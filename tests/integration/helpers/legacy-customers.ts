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
  addCurrentStockLocationColumns(db);
  db.exec(bundledMigrations.find((m) => m.version === 20)!.sql);
  if (Number(db.pragma('user_version', { simple: true })) < 7)
    db.exec('CREATE TABLE payments (invoice_id TEXT, amount INTEGER) STRICT');
  db.exec(bundledMigrations.find((m) => m.version === 12)!.sql);
  db.exec(bundledMigrations.find((m) => m.version === 15)!.sql);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'invoices'").get()) {
    db.exec(bundledMigrations.find((m) => m.version === 16)!.sql);
    db.exec(bundledMigrations.find((m) => m.version === 17)!.sql);
    if (Number(db.pragma('user_version', { simple: true })) < 7)
      db.exec(
        'CREATE TABLE invoice_daily_counters (business_date TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL) STRICT',
      );
  }
}
export function removeCurrentCustomerColumns(db: AppDatabase): void {
  removeCurrentStockLocationColumns(db);
  db.exec(
    'DROP TABLE customer_opening_payments; DROP TABLE customer_opening_balances',
  );
  if (Number(db.pragma('user_version', { simple: true })) < 7)
    db.exec('DROP TABLE payments');
  if (
    Number(db.pragma('user_version', { simple: true })) < 7 &&
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name = 'invoice_daily_counters'",
      )
      .get()
  )
    db.exec('DROP TABLE invoice_daily_counters');
  if (
    (
      db.prepare('PRAGMA table_info(invoices)').all() as { name: string }[]
    ).some((c) => c.name === 'reserved_invoice_number')
  )
    db.exec(
      'DROP TRIGGER invoices_cash_immutable; ALTER TABLE invoices DROP COLUMN cash_received; ALTER TABLE invoice_items DROP COLUMN price_entry_confirmed; DROP TRIGGER invoices_reservation_immutable; DROP TRIGGER invoices_refinement_finalized_immutable; DROP INDEX invoices_reserved_number; ALTER TABLE invoices DROP COLUMN reserved_invoice_number; ALTER TABLE invoices DROP COLUMN tax_invoice_number;',
    );
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sales'").get())
    db.exec(
      'DROP TRIGGER invoices_finalized_references_immutable; ALTER TABLE invoices DROP COLUMN sales_id; ALTER TABLE invoices DROP COLUMN expedition_id; ALTER TABLE invoices DROP COLUMN sales_name_snapshot; ALTER TABLE invoices DROP COLUMN expedition_name_snapshot; DROP TABLE sales; DROP TABLE expeditions;',
    );
  db.exec(
    'ALTER TABLE settings DROP COLUMN complaint_phone_number; ALTER TABLE settings DROP COLUMN social_media_url; DROP INDEX customers_external_id; ALTER TABLE customers DROP COLUMN external_id; ALTER TABLE customers DROP COLUMN is_active;',
  );
}

/** Today's writer needs location columns while generating an older-schema fixture. */
export function addCurrentStockLocationColumns(db: AppDatabase): void {
  db.exec(bundledMigrations.find((m) => m.version === 18)!.sql);
  db.prepare(
    "INSERT INTO stock_locations (id,code,label,is_default) VALUES ('11111111-1111-4111-8111-111111111119','01','Gudang',1)",
  ).run();
  if (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='stock_ledger_entries'")
      .get()
  )
    db.exec(
      `ALTER TABLE stock_ledger_entries ADD COLUMN stock_location_id TEXT DEFAULT '11111111-1111-4111-8111-111111111119'`,
    );
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='invoices'").get())
    db.exec(
      `ALTER TABLE invoices ADD COLUMN stock_location_id TEXT DEFAULT '11111111-1111-4111-8111-111111111119'; ALTER TABLE invoices ADD COLUMN stock_location_code_snapshot TEXT DEFAULT '01'; ALTER TABLE invoices ADD COLUMN stock_location_label_snapshot TEXT DEFAULT 'Gudang';`,
    );
}
export function removeCurrentStockLocationColumns(db: AppDatabase): void {
  if (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='stock_ledger_entries'")
      .get()
  )
    db.exec('ALTER TABLE stock_ledger_entries DROP COLUMN stock_location_id');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='invoices'").get())
    db.exec(
      'ALTER TABLE invoices DROP COLUMN stock_location_id; ALTER TABLE invoices DROP COLUMN stock_location_code_snapshot; ALTER TABLE invoices DROP COLUMN stock_location_label_snapshot;',
    );
  db.exec('DROP TABLE stock_locations');
}
