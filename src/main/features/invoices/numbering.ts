import type { AppDatabase } from '@/main/database/connection';
import type { LocalDate } from '@/shared/primitives';

/**
 * Official invoice numbers (spec 17): `INV-YYYYMMDD-NNNN`, keyed by the
 * FINALIZATION business day in the shop timezone (not the invoice date, which
 * may be backdated). The sequence is padded to at least four digits and never
 * wraps: 9999 is followed by 10000.
 */
export function formatInvoiceNumber(
  businessDate: LocalDate,
  sequence: bigint,
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || sequence < 1n) {
    throw new Error('invalid invoice number parts');
  }
  return `INV-${businessDate.replaceAll('-', '')}-${sequence.toString().padStart(4, '0')}`;
}

/**
 * Takes the next sequence of the day: upsert + increment in ONE statement,
 * inside the caller's write transaction, so allocation is atomic with the
 * rest of finalization (a rollback returns the number). Counters only move
 * forward (migration 007 triggers), so an issued number is never reused.
 */
export function allocateInvoiceNumber(
  db: AppDatabase,
  businessDate: LocalDate,
): string {
  const row = db
    .prepare(
      `INSERT INTO invoice_daily_counters (business_date, last_sequence) VALUES (?, 1)
       ON CONFLICT (business_date) DO UPDATE SET last_sequence = last_sequence + 1
       RETURNING last_sequence`,
    )
    .get(businessDate) as { last_sequence: bigint };
  return formatInvoiceNumber(businessDate, row.last_sequence);
}
