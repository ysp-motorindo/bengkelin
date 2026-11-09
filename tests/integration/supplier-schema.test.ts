import { test, expect } from 'vitest';
import { openDatabase } from '@/main/database/connection';
import { migrateDatabase } from '@/main/database/migrate';
test('supplier opening storage is available with immutable originals', () => {
  const db = openDatabase(':memory:');
  try {
    migrateDatabase(db);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='supplier_opening_balances'",
        )
        .get(),
    ).toBeDefined();
    expect(db.prepare('PRAGMA table_info(suppliers)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'external_id' }),
      ]),
    );
  } finally {
    db.close();
  }
});
