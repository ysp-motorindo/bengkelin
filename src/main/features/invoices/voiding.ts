import { appendAudit } from '@/main/database/audit';
import {
  readSaleEntriesForInvoice,
  recordVoidReversal,
} from '@/main/features/inventory/ledger';
import type { VoidInvoiceData } from '@/shared/contracts';
import { DomainError, formatRupiah } from '@/shared/primitives';
import { requireIssuedInvoice, type InvoiceWriteContext } from './payments';

/**
 * Voids a whole invoice (spec 29; Part A "Voiding"). Any cashier may void an
 * invoice with no payments; any positive payment blocks it. VOID is terminal
 * and keeps the number, lines, totals, payments and snapshots.
 *
 * MUST run inside the caller's write transaction (with `runIdempotent`), so a
 * racing payment is either already committed (-> PAID_INVOICE_CANNOT_BE_VOIDED)
 * or will see the VOID (-> INVOICE_VOID).
 *
 * Every SALE entry of the invoice is reversed exactly once through
 * `recordVoidReversal`: the 005 triggers enforce the exact negation and the
 * UNIQUE link, so an entry that was somehow already reversed aborts the whole
 * void (SALE_ALREADY_REVERSED) instead of being skipped.
 */
export function voidIssuedInvoice(
  ctx: InvoiceWriteContext,
  input: VoidInvoiceData,
  actor: { cashierId: string },
): void {
  const invoice = requireIssuedInvoice(ctx.invoices, input.invoiceId);
  if (invoice.status === 'VOID') {
    throw new DomainError(
      'INVOICE_ALREADY_VOID',
      'The invoice is already void',
    );
  }
  if (ctx.payments.paidAmount(invoice.id) > 0n) {
    throw new DomainError(
      'PAID_INVOICE_CANNOT_BE_VOIDED',
      'An invoice with payments cannot be voided',
    );
  }

  const now = ctx.clock.now();
  const sales = readSaleEntriesForInvoice(ctx.db, invoice.id);
  for (const sale of sales) {
    recordVoidReversal(ctx.db, { saleEntryId: sale.id, actor, at: now });
  }

  const voided = ctx.invoices.markVoided({
    invoiceId: invoice.id,
    cashierId: actor.cashierId,
    cashierName: ctx.drafts.cashierName(actor.cashierId),
    reason: input.reason,
    now,
  });
  if (!voided) throw new Error(`invoice ${invoice.id} was not FINALIZED`);

  appendAudit(ctx.db, ctx.clock, {
    cashierId: actor.cashierId,
    action: 'INVOICE_VOIDED',
    entityType: 'invoice',
    entityId: invoice.id,
    metadata: {
      stockLocationId: invoice.stock_location_id,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      finalizedAt: invoice.finalized_at,
      amount: formatRupiah(invoice.amount),
      reversalCount: sales.length,
      reason: input.reason,
    },
  });
}
