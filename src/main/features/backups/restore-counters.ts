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
  const hasReservations = (
    db.prepare('PRAGMA table_info(invoices)').all() as { name: string }[]
  ).some((column) => column.name === 'reserved_invoice_number');
  const numbers = db
    .prepare(
      `SELECT invoice_number FROM invoices WHERE invoice_number IS NOT NULL ${hasReservations ? 'UNION ALL SELECT reserved_invoice_number AS invoice_number FROM invoices WHERE reserved_invoice_number IS NOT NULL' : ''}`,
    )
    .all() as { invoice_number: string }[];
  for (const { invoice_number: number } of numbers) {
    const match = NUMBER.exec(number);
    if (!match) continue;
    const [, year, month, day, sequence] = match as unknown as string[];
    raise(`${year}-${month}-${day}`, BigInt(sequence as string));
  }
  const hasPurchases = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_daily_counters'",
    )
    .get();
  if (hasPurchases) {
    const counters = db
      .prepare(
        'SELECT kind,business_date,last_sequence FROM purchase_daily_counters',
      )
      .all() as {
      kind: string;
      business_date: string;
      last_sequence: bigint;
    }[];
    for (const row of counters)
      raise(`${row.kind}/${row.business_date}`, row.last_sequence);
    const docs = db
      .prepare(
        'SELECT document_number FROM purchases WHERE document_number IS NOT NULL UNION ALL SELECT document_number FROM purchase_receipts UNION ALL SELECT document_number FROM purchase_credits',
      )
      .all() as { document_number: string }[];
    for (const row of docs) {
      const m = /^(PUR|RCV|PCN)-(\d{4})(\d{2})(\d{2})-(\d{4,})$/.exec(
        row.document_number,
      );
      if (m) raise(`${m[1]}/${m[2]}-${m[3]}-${m[4]}`, BigInt(m[5]!));
    }
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
    if (date.includes('/')) {
      const [kind, day] = date.split('/');
      staged
        .prepare(
          `INSERT INTO purchase_daily_counters(kind,business_date,last_sequence) VALUES(?,?,?) ON CONFLICT(kind,business_date) DO UPDATE SET last_sequence=excluded.last_sequence WHERE excluded.last_sequence>purchase_daily_counters.last_sequence`,
        )
        .run(kind!, day!, sequence);
    } else upsert.run(date, sequence);
  }
}
