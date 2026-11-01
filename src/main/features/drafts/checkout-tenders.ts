import { toNumber } from '@/main/database/rows';
import type { CheckoutAllocationDto } from '@/shared/contracts';
import { formatRupiah } from '@/shared/primitives';
import type { DraftRepository, InvoiceRow } from './repository';

export function readCheckoutTenders(
  repo: DraftRepository,
  invoice: InvoiceRow,
): CheckoutAllocationDto[] {
  if (invoice.cash_received !== null) {
    return invoice.cash_received > 0n
      ? [
          {
            sequence: 1,
            method: 'CASH',
            amount: formatRupiah(invoice.cash_received),
            reference: null,
            note: null,
          },
        ]
      : [];
  }
  return repo.allocations(invoice.id).map((row) => ({
    sequence: toNumber(row.sequence),
    method: row.method,
    amount: formatRupiah(row.amount),
    reference: row.reference,
    note: row.note,
  }));
}
