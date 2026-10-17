import type { AppDatabase } from '@/main/database/connection';
import { bundledMigrations } from '@/main/database/migrate';

/** Generate old-schema fixture actions with today's writer, then restore the old columns. */
export async function withCurrentCustomerColumns<T>(
  db: AppDatabase,
  work: () => Promise<T>,
): Promise<T> {
  addCurrentCustomerColumns(db);
  try {
    return await work();
  } finally {
    removeCurrentCustomerColumns(db);
  }
}

export function addCurrentCustomerColumns(db: AppDatabase): void {
  db.exec(bundledMigrations.find((m) => m.version === 12)!.sql);
}
export function removeCurrentCustomerColumns(db: AppDatabase): void {
  db.exec(
    'DROP INDEX customers_external_id; ALTER TABLE customers DROP COLUMN external_id; ALTER TABLE customers DROP COLUMN is_active;',
  );
}
