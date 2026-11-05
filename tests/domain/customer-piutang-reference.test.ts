import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { readCsv } from '@/main/features/catalog-transfer/reader';

test('reference CSV contains 11 unique customers totaling 243750942', () => {
  const parsed = readCsv(
    readFileSync('references/customer-piutang-import.csv'),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.code);

  const [header, ...rows] = parsed.records;
  expect(header).toEqual([
    'external_id',
    'customer_name',
    'as_of_date',
    'opening_balance',
  ]);
  expect(rows).toHaveLength(11);
  expect(new Set(rows.map((row) => row[0])).size).toBe(11);

  let total = 0;
  for (const row of rows) {
    expect(row).toHaveLength(4);
    expect(row[2]).toBe('2026-09-30');
    expect(row[3]).toMatch(/^\d+$/);
    const amount = Number(row[3]);
    expect(Number.isSafeInteger(amount)).toBe(true);
    total += amount;
  }
  expect(total).toBe(243750942);
});
