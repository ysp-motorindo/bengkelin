import type { AppDatabase } from '@/main/database/connection';
import { isLocalDate, type OpeningImportRow } from '@/shared/contracts';
import { formatRupiah, parseRupiah } from '@/shared/primitives';
import {
  customerIssue,
  decodeCustomerText,
} from '@/main/features/customer-transfer/planner';
export const OPENING_COLUMNS = [
  'external_id',
  'customer_name',
  'as_of_date',
  'opening_balance',
] as const;
export function planOpeningImport(records: string[][], db: AppDatabase) {
  const rows: OpeningImportRow[] = [];
  const errors: ReturnType<typeof customerIssue>[] = [];
  const summary = { creates: 0, unchanged: 0 };
  let total = 0n;
  const header = records[0]?.map((x) => x.trim().toLowerCase()) ?? [];
  if (
    header.length !== 4 ||
    new Set(header).size !== 4 ||
    OPENING_COLUMNS.some((x) => !header.includes(x))
  )
    errors.push(customerIssue('OPENING_IMPORT_HEADER'));
  else {
    if (records.length === 1) errors.push(customerIssue('NO_DATA_ROWS'));
    const seen = new Set<string>();
    for (const [i, cells] of records.slice(1).entries()) {
      const cell = (key: (typeof OPENING_COLUMNS)[number]) =>
        decodeCustomerText(cells[header.indexOf(key)] ?? '').trim();
      const externalId = cell('external_id');
      const asOfDate = cell('as_of_date');
      const customer = db
        .prepare('SELECT id FROM customers WHERE external_id=? COLLATE BINARY')
        .get(externalId) as { id: string } | undefined;
      const row: OpeningImportRow = {
        row: i + 2,
        externalId,
        customerName: cell('customer_name') || null,
        customerId: customer?.id ?? null,
        asOfDate,
        amount: null,
        action: 'INVALID',
      };
      rows.push(row);
      const invalid = (code: string, column: string | null = null) =>
        errors.push(customerIssue(code, i + 2, column, externalId));
      if (cells.length !== 4) {
        invalid('CUSTOMER_IMPORT_INVALID_ROW');
        continue;
      }
      if (!externalId || seen.has(externalId)) {
        invalid('CUSTOMER_IMPORT_DUPLICATE_ID', 'external_id');
        continue;
      }
      seen.add(externalId);
      if (!customer) {
        invalid('OPENING_IMPORT_UNKNOWN_CUSTOMER', 'external_id');
        continue;
      }
      if (!isLocalDate(asOfDate)) {
        invalid('OPENING_IMPORT_INVALID_DATE', 'as_of_date');
        continue;
      }
      let amount: bigint;
      try {
        amount = parseRupiah(cell('opening_balance'));
        if (amount < 0n) throw Error();
        formatRupiah(total + amount);
      } catch {
        invalid('OPENING_IMPORT_INVALID_AMOUNT', 'opening_balance');
        continue;
      }
      row.amount = formatRupiah(amount);
      total += amount;
      const existing = db
        .prepare(
          'SELECT amount,as_of_date FROM customer_opening_balances WHERE customer_id=?',
        )
        .get(customer.id) as { amount: bigint; as_of_date: string } | undefined;
      if (
        existing &&
        (existing.amount !== amount || existing.as_of_date !== asOfDate)
      ) {
        invalid('OPENING_IMPORT_CONFLICT');
        continue;
      }
      row.action = existing ? 'UNCHANGED' : 'CREATE';
      summary[existing ? 'unchanged' : 'creates']++;
    }
  }
  return { rows, errors, summary, totalAmount: formatRupiah(total) };
}
