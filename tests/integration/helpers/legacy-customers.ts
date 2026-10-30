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
  db.exec(bundledMigrations.find((m) => m.version === 15)!.sql);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'invoices'").get())
    db.exec(bundledMigrations.find((m) => m.version === 16)!.sql);
}
export function removeCurrentCustomerColumns(db: AppDatabase): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sales'").get())
    db.exec(
      'DROP TRIGGER invoices_finalized_references_immutable; ALTER TABLE invoices DROP COLUMN sales_id; ALTER TABLE invoices DROP COLUMN expedition_id; ALTER TABLE invoices DROP COLUMN sales_name_snapshot; ALTER TABLE invoices DROP COLUMN expedition_name_snapshot; DROP TABLE sales; DROP TABLE expeditions;',
    );
  db.exec(
    'ALTER TABLE settings DROP COLUMN complaint_phone_number; ALTER TABLE settings DROP COLUMN social_media_url; DROP INDEX customers_external_id; ALTER TABLE customers DROP COLUMN external_id; ALTER TABLE customers DROP COLUMN is_active;',
  );
}
