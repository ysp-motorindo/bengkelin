import type { AppDatabase } from '@/main/database/connection';
import type { PaymentMethod, PaymentSource } from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';

/**
 * Payments (spec 22). Append-only; the schema (migration 007) also refuses a
 * payment for a non-FINALIZED invoice and any payment that would push the sum
 * above the invoice amount. Writes run inside the caller's transaction.
 */

export interface PaymentRow {
  id: string;
  invoice_id: string;
  method: PaymentMethod;
  amount: bigint;
  paid_at: Instant;
  reference: string | null;
  note: string | null;
  received_by_cashier_id: string;
  received_by_name: string;
  source: PaymentSource;
  created_at: Instant;
}

export interface NewPayment {
  id: string;
  invoiceId: string;
  method: PaymentMethod;
  amount: bigint;
  paidAt: Instant;
  reference: string | null;
  note: string | null;
  receivedByCashierId: string;
  source: PaymentSource;
  createdAt: Instant;
}

export class PaymentRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(payment: NewPayment): void {
    this.db
      .prepare(
        `INSERT INTO payments (id, invoice_id, method, amount, paid_at, reference, note,
           received_by_cashier_id, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        payment.id,
        payment.invoiceId,
        payment.method,
        payment.amount,
        payment.paidAt,
        payment.reference,
        payment.note,
        payment.receivedByCashierId,
        payment.source,
        payment.createdAt,
      );
  }

  /** Oldest first (insertion order breaks ties within one instant). */
  forInvoice(invoiceId: string): PaymentRow[] {
    return this.db
      .prepare(
        `SELECT p.id, p.invoice_id, p.method, p.amount, p.paid_at, p.reference, p.note,
           p.received_by_cashier_id, c.display_name AS received_by_name, p.source, p.created_at
         FROM payments p JOIN cashiers c ON c.id = p.received_by_cashier_id
         WHERE p.invoice_id = ?
         ORDER BY p.paid_at, p.rowid`,
      )
      .all(invoiceId) as PaymentRow[];
  }

  paidAmount(invoiceId: string): bigint {
    return (
      this.db
        .prepare(
          'SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = ?',
        )
        .get(invoiceId) as { paid: bigint }
    ).paid;
  }
}
