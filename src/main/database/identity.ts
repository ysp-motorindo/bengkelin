import type { AppDatabase } from './connection';
import { DatabaseError } from './errors';

/**
 * Fixed SQLite `PRAGMA application_id` stamped on every Bengkelin database
 * (ASCII "BKLN"). Together with `PRAGMA user_version` (the schema version) it
 * lets backup/restore identify a file without opening any table.
 */
export const APPLICATION_ID = 0x424b4c4e;

export function readApplicationId(db: AppDatabase): number {
  return Number(db.pragma('application_id', { simple: true }));
}

/** Schema version = `PRAGMA user_version`; 0 for a database never migrated. */
export function readSchemaVersion(db: AppDatabase): number {
  return Number(db.pragma('user_version', { simple: true }));
}

function hasUserObjects(db: AppDatabase): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
      )
      .get() !== undefined
  );
}

/** Rejects a non-empty database that is not ours. Empty files are accepted. */
export function assertOwnDatabase(db: AppDatabase): void {
  if (hasUserObjects(db) && readApplicationId(db) !== APPLICATION_ID) {
    throw new DatabaseError(
      'FOREIGN_DATABASE',
      'The file is not a Bengkelin database',
    );
  }
}

export function assertSupportedSchema(
  db: AppDatabase,
  latestKnownVersion: number,
): void {
  const version = readSchemaVersion(db);
  if (version > latestKnownVersion) {
    throw new DatabaseError(
      'UNSUPPORTED_SCHEMA',
      `Database schema ${version} is newer than this app supports (${latestKnownVersion})`,
    );
  }
}
