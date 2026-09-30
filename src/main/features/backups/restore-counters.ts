import type { AppDatabase } from '@/main/database/connection';

/**
 * Invoice numbers are never reused (spec 17), not even across a restore:
 * before the swap, the staged database's `invoice_daily_counters` are raised
 * to the maximum of what either database has issued per business date,
 * including dates only the current database knows (T16 ruling).
 */

export type IssuedSequences = Map<string, bigint>;

const NUMBER = /^INV-(\d{4})(\d{2})(\d{2})-(\d{4,})$/;

/** Highest sequence per business date: counters and issued numbers. */
export function readIssuedSequences(db: AppDatabase): IssuedSequences {
  const issued: IssuedSequences = new Map();
  const raise = (date: string, sequence: bigint) => {
    const current = issued.get(date);
    if (current === undefined || sequence > current) issued.set(date, sequence);
  };
  const counters = db
    .prepare('SELECT business_date, last_sequence FROM invoice_daily_counters')
    .all() as { business_date: string; last_sequence: bigint }[];
  for (const row of counters) raise(row.business_date, row.last_sequence);
  // Guard: a counter should never lag the numbers actually issued.
  const numbers = db
    .prepare(
      'SELECT invoice_number FROM invoices WHERE invoice_number IS NOT NULL',
    )
    .all() as { invoice_number: string }[];
  for (const { invoice_number: number } of numbers) {
    const match = NUMBER.exec(number);
    if (!match) continue;
    const [, year, month, day, sequence] = match as unknown as string[];
    raise(`${year}-${month}-${day}`, BigInt(sequence as string));
  }
  return issued;
}

/** The per-date maximum of several maps. */
export function mergeIssuedSequences(
  ...sources: IssuedSequences[]
): IssuedSequences {
  const merged: IssuedSequences = new Map();
  for (const source of sources) {
    for (const [date, sequence] of source) {
      const current = merged.get(date);
      if (current === undefined || sequence > current) {
        merged.set(date, sequence);
      }
    }
  }
  return merged;
}

/**
 * Raises the staged database's counters (inside the caller's write
 * transaction on `staged`). Counters only move forward, which the table's
 * trigger also enforces.
 */
export function raiseStagedCounters(
  staged: AppDatabase,
  current: IssuedSequences,
): void {
  const target = mergeIssuedSequences(readIssuedSequences(staged), current);
  const upsert = staged.prepare(
    `INSERT INTO invoice_daily_counters (business_date, last_sequence)
     VALUES (?, ?)
     ON CONFLICT (business_date) DO UPDATE
       SET last_sequence = excluded.last_sequence
       WHERE excluded.last_sequence > invoice_daily_counters.last_sequence`,
  );
  for (const [date, sequence] of [...target].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    upsert.run(date, sequence);
  }
}
