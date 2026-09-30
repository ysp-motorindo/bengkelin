import { appendAudit } from '@/main/database/audit';
import type { AppDatabase } from '@/main/database/connection';
import type { DraftRepository } from '@/main/features/drafts/repository';
import type { RecordPaymentData } from '@/shared/contracts';
import { DomainError, formatRupiah, parseRupiah } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import type { PaymentRepository } from './payments-repository';
import type { FullInvoiceRow, InvoiceRepository } from './repository';

/**
 * Later payments (spec 22, 23; Part A review focus 2). Append-only rows with
 * source LATER. Paid, outstanding and payment status are always derived from
 * SUM(payments); nothing on the invoice changes.
 */

export interface InvoiceWriteContext {
  db: AppDatabase;
  clock: Clock;
  drafts: DraftRepository;
  invoices: InvoiceRepository;
  payments: PaymentRepository;
  newId: () => string;
}

/**
 * The issued invoice a payment or void acts on. Missing -> INVOICE_NOT_FOUND;
 * a draft (open or discarded) -> INVOICE_NOT_FINALIZED.
 */
export function requireIssuedInvoice(
  invoices: InvoiceRepository,
  invoiceId: string,
): FullInvoiceRow {
  const invoice = invoices.findFull(invoiceId);
  if (!invoice) throw new DomainError('INVOICE_NOT_FOUND', 'Invoice not found');
  if (invoice.status === 'DRAFT') {
    throw new DomainError(
      'INVOICE_NOT_FINALIZED',
      'The invoice is not finalized yet',
    );
  }
  return invoice;
}

/**
 * Records one later payment. MUST run inside the caller's write transaction
 * (with `runIdempotent`), so the outstanding amount is recomputed under the
 * write lock: of two concurrent submissions for the full amount, the second
 * sees the first and gets PAYMENT_EXCEEDS_OUTSTANDING. A fully PAID invoice
 * answers the same code (outstanding 0). The 007 triggers are the backstop.
 */
export function recordLaterPayment(
  ctx: InvoiceWriteContext,
  input: RecordPaymentData,
  actor: { cashierId: string },
): void {
  const invoice = requireIssuedInvoice(ctx.invoices, input.invoiceId);
  if (invoice.status === 'VOID') {
    throw new DomainError('INVOICE_VOID', 'The invoice is void');
  }
  const amount = parseRupiah(input.amount);
  const paid = ctx.payments.paidAmount(invoice.id);
  const outstanding = invoice.amount - paid;
  if (amount <= 0n || amount > outstanding) {
    throw new DomainError(
      'PAYMENT_EXCEEDS_OUTSTANDING',
      'The payment exceeds the outstanding amount',
      { outstandingAmount: formatRupiah(outstanding) },
    );
  }

  const now = ctx.clock.now();
  const paymentId = ctx.newId();
  ctx.payments.insert({
    id: paymentId,
    invoiceId: invoice.id,
    method: input.method,
    amount,
    // The actual receipt time; v1 has no backdating (Part A defaults).
    paidAt: now,
    reference: input.reference,
    note: input.note,
    receivedByCashierId: actor.cashierId,
    receivedByName: ctx.drafts.cashierName(actor.cashierId),
    source: 'LATER',
    createdAt: now,
  });

  appendAudit(ctx.db, ctx.clock, {
    cashierId: actor.cashierId,
    action: 'INVOICE_PAYMENT_RECORDED',
    entityType: 'invoice',
    entityId: invoice.id,
    metadata: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      paymentId,
      method: input.method,
      amount: formatRupiah(amount),
      paidAmount: formatRupiah(paid + amount),
      outstandingAmount: formatRupiah(outstanding - amount),
    },
  });
}
