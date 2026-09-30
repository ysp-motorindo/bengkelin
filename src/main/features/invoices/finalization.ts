import { appendAudit } from '@/main/database/audit';
import type { AppDatabase } from '@/main/database/connection';
import { toNumber } from '@/main/database/rows';
import type { InvoiceRow } from '@/main/features/drafts/repository';
import { recordSale } from '@/main/features/inventory/ledger';
import type { FinalizeData } from '@/shared/contracts';
import { DomainError, type Instant, type LocalDate } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { checkFinalization, sameWarnings, type CheckDeps } from './checks';
import { allocateInvoiceNumber } from './numbering';
import type { PaymentRepository } from './payments-repository';
import { writeSnapshots, type SnapshotDeps } from './snapshots';

/**
 * The write boundaries of finalization, in order. The test-only `onStep`
 * hook is called after each one (fault injection).
 */
export const FINALIZE_STEPS = [
  'snapshots',
  'allocationsCleared',
  'counterIncremented',
  'stockRecorded',
  'statusFlipped',
  'paymentsInserted',
] as const;
export type FinalizeStep = (typeof FINALIZE_STEPS)[number];

export interface FinalizationContext extends CheckDeps, SnapshotDeps {
  db: AppDatabase;
  clock: Clock;
  payments: PaymentRepository;
  newId: () => string;
  onStep?: ((step: FinalizeStep) => void) | undefined;
}

/** Raised when stored draft totals disagree with the shared calculation. */
export class FinalizationIntegrityError extends Error {
  override readonly name = 'FinalizationIntegrityError';
}

/**
 * Finalizes one open draft. MUST run inside the caller's write transaction
 * (with `runIdempotent`), after the DRAFT / discarded / version checks. Any
 * throw rolls back everything: the draft keeps its lines, allocations and
 * version, and no number, stock entry or payment remains.
 *
 * Write order (each step satisfies the 006/007 triggers):
 *  1. snapshots          invoice header + line snapshots, while DRAFT (child
 *                        rows freeze once the status leaves DRAFT).
 *  2. allocationsCleared the checkout plan is read into memory and deleted,
 *                        while DRAFT (allocations are draft-only rows).
 *  3. counterIncremented the day's counter is upserted and incremented.
 *  4. stockRecorded      one SALE per tracked item (aggregated demand); the
 *                        ledger has no invoice-status trigger.
 *  5. statusFlipped      ONE guarded update: DRAFT -> FINALIZED with number,
 *                        finalizer, finalized_at, version + 1. The 006 CHECK
 *                        needs the snapshots from step 1 in this same row.
 *  6. paymentsInserted   payments from the captured plan; the 007 triggers
 *                        need FINALIZED (step 5) and sum <= amount.
 *  Then the audit row; `runIdempotent` stores the receipt.
 */
export function finalizeDraft(
  ctx: FinalizationContext,
  invoice: InvoiceRow,
  input: FinalizeData,
  actor: { cashierId: string },
  timezone: string,
  today: LocalDate,
): void {
  const now: Instant = ctx.clock.now();
  const step = (name: FinalizeStep) => ctx.onStep?.(name);

  // Validation and warnings on committed state, inside the write lock.
  const check = checkFinalization(ctx, invoice, today);
  const firstError = check.errors[0];
  if (firstError) {
    throw new DomainError(
      firstError.code,
      `Cannot finalize: ${firstError.code}`,
      firstError.params,
    );
  }
  if (!sameWarnings(check.warnings, input.acknowledgedWarnings)) {
    throw new DomainError(
      'FINALIZE_WARNINGS_CHANGED',
      'The warnings changed since they were acknowledged',
    );
  }
  assertPersistedTotals(invoice, check);

  writeSnapshots(ctx, invoice, actor.cashierId);
  step('snapshots');

  const plan = check.allocations;
  const receiverName = ctx.drafts.cashierName(actor.cashierId);
  ctx.invoices.clearAllocations(invoice.id);
  step('allocationsCleared');

  const invoiceNumber = allocateInvoiceNumber(ctx.db, today);
  step('counterIncremented');

  for (const item of check.demand) {
    recordSale(ctx.db, {
      invoiceId: invoice.id,
      catalogItemId: item.catalog_item_id,
      quantity: toNumber(item.demand),
      actor,
      at: now,
    });
  }
  step('stockRecorded');

  const flipped = ctx.invoices.markFinalized({
    invoiceId: invoice.id,
    expectedVersion: invoice.version,
    invoiceNumber,
    cashierId: actor.cashierId,
    now,
  });
  if (!flipped) {
    throw new DomainError(
      'DRAFT_VERSION_CONFLICT',
      'The draft changed since it was loaded',
    );
  }
  step('statusFlipped');

  for (const allocation of plan) {
    ctx.payments.insert({
      id: ctx.newId(),
      invoiceId: invoice.id,
      method: allocation.method,
      amount: allocation.amount,
      paidAt: now,
      reference: allocation.reference,
      note: allocation.note,
      receivedByCashierId: actor.cashierId,
      receivedByName: receiverName,
      source: 'CHECKOUT',
      createdAt: now,
    });
  }
  step('paymentsInserted');

  appendAudit(ctx.db, ctx.clock, {
    cashierId: actor.cashierId,
    action: 'INVOICE_FINALIZED',
    entityType: 'invoice',
    entityId: invoice.id,
    metadata: {
      invoiceId: invoice.id,
      invoiceNumber,
      businessDate: today,
      timezone,
      amount: check.calculation.calc.amount.toString(),
      paidAmount: check.allocatedAmount.toString(),
      paymentCount: plan.length,
      saleItemCount: check.demand.length,
      acknowledgedWarnings: input.acknowledgedWarnings.map((w) => w.code),
    },
  });
}

/**
 * Draft commands always persist recomputed totals, so the stored values must
 * equal the shared calculation. A mismatch is an internal error (rollback).
 */
function assertPersistedTotals(
  invoice: InvoiceRow,
  check: ReturnType<typeof checkFinalization>,
): void {
  const { calc, lines, lineStages, invoiceStages } = check.calculation;
  const mismatch =
    invoice.subtotal !== calc.subtotal ||
    invoice.item_discount_amount !== calc.itemDiscountTotal ||
    invoice.invoice_discount_amount !== calc.invoiceDiscountTotal ||
    invoice.discount_amount !== calc.discountAmount ||
    invoice.amount !== calc.amount ||
    lines.some((line, index) => {
      const result = calc.lines[index]!;
      return (
        line.subtotal !== result.subtotal ||
        line.discount_amount !== result.discountTotal ||
        line.amount !== result.amount ||
        (lineStages.get(line.id) ?? []).some(
          (stage, i) => stage.amount !== result.stageAmounts[i],
        )
      );
    }) ||
    invoiceStages.some(
      (stage, i) => stage.amount !== calc.invoiceDiscountStageAmounts[i],
    );
  if (mismatch) {
    throw new FinalizationIntegrityError(
      `Stored totals of ${invoice.id} differ from the calculation`,
    );
  }
}
