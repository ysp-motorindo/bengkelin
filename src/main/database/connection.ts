import Database from 'better-sqlite3';
import { DatabaseError } from './errors';
import { assertOwnDatabase, assertSupportedSchema } from './identity';
import { latestBundledVersion } from './migrate';

export type AppDatabase = Database.Database;

/**
 * Opens (creating if absent) the application database at `filePath`.
 * No Electron imports here: the caller resolves the path.
 *
 * INTEGER CONVENTION: the handle is opened with `defaultSafeIntegers(true)`,
 * so every INTEGER column (all money, quantities, counters) is read as a JS
 * `bigint`. Never coerce money through `Number`. Small non-money integers
 * (versions, counts) may be converted explicitly with `Number(...)`. Bind
 * money as `bigint`. `db.pragma(..., { simple: true })` also returns bigint.
 */
export function openDatabase(
  filePath: string,
  latestKnownVersion: number = latestBundledVersion,
): AppDatabase {
  const db = new Database(filePath);
  try {
    db.defaultSafeIntegers(true);
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    assertOwnDatabase(db);
    assertSupportedSchema(db, latestKnownVersion);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Runs synchronous `work` inside a `BEGIN IMMEDIATE` transaction: the write
 * lock is taken up front, commit on return, rollback on throw. Keep work short
 * (never wait on user input, dialogs, file pickers or previews inside it).
 * Async work is rejected (and rolled back) because the transaction is
 * synchronous and would commit before the promise settled.
 */
export function withWriteTransaction<T>(db: AppDatabase, work: () => T): T {
  return db
    .transaction((): T => {
      const result = work();
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        throw new DatabaseError(
          'ASYNC_TRANSACTION',
          'withWriteTransaction work must be synchronous',
        );
      }
      return result;
    })
    .immediate();
}
