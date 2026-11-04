import { toNumber } from '@/main/database/rows';
import {
  calculateInvoice,
  type InvoiceCalculation,
} from '@/main/features/invoices/domain';
import type { DraftRepository, LineRow, StageRow } from './repository';

function groupByOwner(stages: StageRow[]): Map<string, StageRow[]> {
  const map = new Map<string, StageRow[]>();
  for (const stage of stages) {
    const list = map.get(stage.owner_id) ?? [];
    list.push(stage);
    map.set(stage.owner_id, list);
  }
  return map;
}

export interface DraftCalculation {
  lines: LineRow[];
  lineStages: Map<string, StageRow[]>;
  invoiceStages: StageRow[];
  calc: InvoiceCalculation;
}

/**
 * The shared domain calculation (spec 20, 21, 58) over the draft's live lines
 * and discount stages. Reads only.
 */
export function calculateDraftTotals(
  repo: DraftRepository,
  invoiceId: string,
): DraftCalculation {
  const lines = repo.liveLines(invoiceId);
  const lineStages = groupByOwner(repo.lineStages(invoiceId));
  const invoiceStages = repo.invoiceStages(invoiceId);
  const calc = calculateInvoice({
    vatRateBps: toNumber(repo.findInvoice(invoiceId)!.vat_rate_bps),
    lines: lines.map((line) => ({
      quantity: toNumber(line.quantity),
      unitPrice: line.unit_price,
      discountStages: (lineStages.get(line.id) ?? []).map((s) =>
        toNumber(s.percentage_bps),
      ),
    })),
    discountStages: invoiceStages.map((s) => toNumber(s.percentage_bps)),
  });
  return { lines, lineStages, invoiceStages, calc };
}

/**
 * Recomputes the draft's authoritative totals with the shared domain
 * calculation (spec 20, 21, 58) and persists every line amount, every
 * discount-stage amount and the invoice totals. Removed lines are excluded.
 * Runs inside the command's write transaction, after the operation's writes.
 * Only rows whose stored values differ are rewritten.
 */
export function recalculateDraft(
  repo: DraftRepository,
  invoiceId: string,
): void {
  const { lines, lineStages, invoiceStages, calc } = calculateDraftTotals(
    repo,
    invoiceId,
  );

  lines.forEach((line, index) => {
    const result = calc.lines[index]!;
    if (
      line.subtotal !== result.subtotal ||
      line.discount_amount !== result.discountTotal ||
      line.amount !== result.amount ||
      line.allocated_invoice_discount !== result.allocatedInvoiceDiscount ||
      line.final_amount !== result.finalAmount ||
      line.tax_subtotal !== result.taxSubtotal ||
      line.vat_amount !== result.vatAmount
    ) {
      repo.setLineAmounts(line.id, {
        ...result,
        subtotal: result.subtotal,
        discountAmount: result.discountTotal,
        amount: result.amount,
      });
    }
    (lineStages.get(line.id) ?? []).forEach((stage, stageIndex) => {
      const amount = result.stageAmounts[stageIndex]!;
      if (stage.amount !== amount) repo.setLineStageAmount(stage.id, amount);
    });
  });
  invoiceStages.forEach((stage, index) => {
    const amount = calc.invoiceDiscountStageAmounts[index]!;
    if (stage.amount !== amount) repo.setInvoiceStageAmount(stage.id, amount);
  });

  repo.saveTotals(invoiceId, {
    taxSubtotal: calc.taxSubtotal,
    vatAmount: calc.vatAmount,
    subtotal: calc.subtotal,
    itemDiscountAmount: calc.itemDiscountTotal,
    invoiceDiscountAmount: calc.invoiceDiscountTotal,
    discountAmount: calc.discountAmount,
    amount: calc.amount,
  });
}
