import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import Database from 'better-sqlite3';
import { APPLICATION_ID } from '@/main/database/identity';
import { latestBundledVersion } from '@/main/database/migrate';
import type {
  BackupValidation,
  BackupValidationCode,
} from '@/shared/contracts';

/**
 * Validates a backup file (spec 42, 43) without changing it. Used for every
 * backup before it gets its final name, and by restore (T16) for the file an
 * ADMIN selects.
 *
 * It opens a READONLY raw better-sqlite3 handle, never `openDatabase`, which
 * would switch a foreign file to WAL and set pragmas on it. Checks, in order:
 *  1. the file exists, is a regular file and is non-empty (BACKUP_NOT_FOUND);
 *  2. the 100-byte SQLite header is valid (NOT_SQLITE);
 *  3. `PRAGMA quick_check` is ok (CORRUPT_DATABASE);
 *  4. `application_id` is Bengkelin's (FOREIGN_DATABASE);
 *  5. 1 <= schema version <= the latest bundled one (UNSUPPORTED_SCHEMA);
 *  6. the core tables of that schema version exist (MISSING_TABLES).
 * The handle is closed on every path.
 */

const HEADER = Buffer.from('SQLite format 3\0', 'latin1');
const HEADER_SIZE = 100;

/**
 * Core tables by the schema version that introduced them. A backup of an
 * older (still supported) schema must have the tables of its own version;
 * restore migrates it forward.
 */
const CORE_TABLES: readonly (readonly [number, readonly string[]])[] = [
  [1, ['settings', 'cashiers', 'audit_log', 'command_receipts']],
  [2, ['channels', 'units']],
  [3, ['mechanics', 'customers', 'vehicles', 'vehicle_ownerships']],
  [4, ['catalog_items', 'catalog_item_barcodes', 'catalog_item_prices']],
  [5, ['stock_ledger_entries']],
  [6, ['invoices', 'invoice_items', 'invoice_discounts']],
  [7, ['payments', 'invoice_daily_counters']],
  [9, ['print_jobs']],
  [11, ['backup_runs']],
  [16, ['sales', 'expeditions']],
  [18, ['stock_locations']],
  [21, ['customer_opening_balances', 'customer_opening_payments']],
  [
    22,
    [
      'suppliers',
      'purchases',
      'purchase_items',
      'purchase_discounts',
      'purchase_checkout_allocations',
      'purchase_daily_counters',
      'purchase_payments',
      'purchase_refunds',
      'purchase_receipts',
      'purchase_receipt_items',
      'purchase_receipt_reversals',
      'purchase_credits',
      'purchase_credit_items',
      'purchase_print_jobs',
    ],
  ],
];

export function coreTablesFor(schemaVersion: number): string[] {
  return CORE_TABLES.filter(([version]) => version <= schemaVersion).flatMap(
    ([, tables]) => [...tables],
  );
}

function rejected(
  error: BackupValidationCode,
  applicationId: number | null = null,
  schemaVersion: number | null = null,
): BackupValidation {
  return { ok: false, applicationId, schemaVersion, error };
}

/** Reads the first bytes; null when the file cannot be read. */
function readHeader(file: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(HEADER_SIZE);
    const read = readSync(fd, buffer, 0, HEADER_SIZE, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isSqliteHeader(header: Buffer): boolean {
  if (header.length < HEADER_SIZE) return false;
  if (!header.subarray(0, HEADER.length).equals(HEADER)) return false;
  // Page size: a power of two from 512 to 32768, or 1 meaning 65536.
  const pageSize = header.readUInt16BE(16);
  const validPageSize =
    pageSize === 1 ||
    (pageSize >= 512 && pageSize <= 32768 && (pageSize & (pageSize - 1)) === 0);
  // File format versions: 1 (rollback journal) or 2 (WAL).
  const formatsValid =
    [1, 2].includes(header[18] as number) &&
    [1, 2].includes(header[19] as number);
  return validPageSize && formatsValid;
}

const SIDE_FILES = ['-wal', '-shm'] as const;

export function validateBackup(
  file: string,
  latestVersion: number = latestBundledVersion,
): BackupValidation {
  // 1. Exists, regular, non-empty.
  let size: number;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) return rejected('BACKUP_NOT_FOUND');
    size = stats.size;
  } catch {
    return rejected('BACKUP_NOT_FOUND');
  }
  if (size === 0) return rejected('BACKUP_NOT_FOUND');

  // 2. SQLite header.
  const header = readHeader(file);
  if (header === null) return rejected('BACKUP_NOT_FOUND');
  if (!isSqliteHeader(header)) return rejected('NOT_SQLITE');

  // A WAL-format file (a copy of a live database) makes even a read-only
  // connection create -wal/-shm files; remove the ones this check created.
  const createdSideFiles = SIDE_FILES.map((s) => file + s).filter(
    (side) => !existsSync(side),
  );
  let db: Database.Database | undefined;
  try {
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
    } catch {
      return rejected('CORRUPT_DATABASE');
    }
    return inspect(db, latestVersion);
  } finally {
    db?.close();
    for (const side of createdSideFiles) {
      try {
        rmSync(side, { force: true });
      } catch {
        // Best effort: a leftover empty side file does not affect the backup.
      }
    }
  }
}

function inspect(
  db: Database.Database,
  latestVersion: number,
): BackupValidation {
  // 3. Integrity. Any SQLite error while reading counts as corruption.
  try {
    const rows = db.pragma('quick_check') as { quick_check: string }[];
    if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') {
      return rejected('CORRUPT_DATABASE');
    }
  } catch {
    return rejected('CORRUPT_DATABASE');
  }

  let applicationId: number;
  let schemaVersion: number;
  let tables: Set<string>;
  try {
    applicationId = Number(db.pragma('application_id', { simple: true }));
    schemaVersion = Number(db.pragma('user_version', { simple: true }));
    tables = new Set(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
  } catch {
    return rejected('CORRUPT_DATABASE');
  }

  // 4. Identity.
  if (applicationId !== APPLICATION_ID) {
    return rejected('FOREIGN_DATABASE', applicationId, schemaVersion);
  }
  // 5. Schema version this app can open (and migrate forward).
  if (schemaVersion < 1 || schemaVersion > latestVersion) {
    return rejected('UNSUPPORTED_SCHEMA', applicationId, schemaVersion);
  }
  // 6. Core tables of that version.
  if (coreTablesFor(schemaVersion).some((name) => !tables.has(name))) {
    return rejected('MISSING_TABLES', applicationId, schemaVersion);
  }
  return { ok: true, applicationId, schemaVersion };
}
