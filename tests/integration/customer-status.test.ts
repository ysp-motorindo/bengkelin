import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '@/main/database/connection';
import { bundledMigrations, migrateDatabase } from '@/main/database/migrate';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { CHANNELS as C } from '@/shared/channels';
import type {
  SaveCustomerResult,
  SearchCustomersResult,
} from '@/shared/contracts';
import {
  ADMIN_PASSWORD,
  createHarness,
  validSetup,
  value,
  type Harness,
} from './helpers/harness';
let h: Harness;
beforeEach(async () => {
  h = createHarness();
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
});
afterEach(() => h.close());
test('active defaults, omitted status preservation, empty searches and inactive access', async () => {
  const created = value(
    await h.call<SaveCustomerResult>(C.customers.save, { name: 'Alpha' }),
  );
  if (!created.saved) throw new Error('not saved');
  expect(created.customer.isActive).toBe(true);
  expect(created.customer.externalId).toBeNull();
  value(
    await h.call(C.customers.save, {
      id: created.customer.id,
      name: 'Alpha',
      isActive: false,
    }),
  );
  const saved = value(
    await h.call<SaveCustomerResult>(C.customers.save, {
      id: created.customer.id,
      name: 'Alpha updated',
    }),
  );
  if (!saved.saved) throw new Error('not saved');
  expect(saved.customer.isActive).toBe(false);
  expect(
    value(
      await h.call<SearchCustomersResult>(C.customers.search, { query: '' }),
    ).results,
  ).toHaveLength(0);
  expect(
    value(
      await h.call<SearchCustomersResult>(C.customers.search, {
        query: '',
        includeInactive: true,
      }),
    ).results[0]?.id,
  ).toBe(created.customer.id);
  expect((await h.call(C.customers.get, { id: created.customer.id })).ok).toBe(
    true,
  );
});
test('external IDs are nullable, unique and nonblank', async () => {
  value(await h.call(C.customers.save, { name: 'One' }));
  value(await h.call(C.customers.save, { name: 'Two' }));
  expect(h.db.prepare('SELECT external_id FROM customers').all()).toEqual([
    { external_id: null },
    { external_id: null },
  ]);
  expect(() =>
    h.db.prepare("UPDATE customers SET external_id = ''").run(),
  ).toThrow();
  expect(() =>
    h.db.prepare("UPDATE customers SET external_id = 'SAME'").run(),
  ).toThrow();
});
test('empty search is alphabetical and keeps existing limits', async () => {
  for (let i = 29; i >= 0; i--)
    value(
      await h.call(C.customers.save, {
        name: `N${String(i).padStart(2, '0')}`,
      }),
    );
  const first = value(
    await h.call<SearchCustomersResult>(C.customers.search, { query: '' }),
  ).results;
  expect(first).toHaveLength(25);
  expect(first[0]?.name).toBe('N00');
  expect(first[24]?.name).toBe('N24');
  expect(
    value(
      await h.call<SearchCustomersResult>(C.customers.search, {
        query: '',
        limit: 50,
      }),
    ).results,
  ).toHaveLength(30);
  expect((await h.call(C.customers.search, { query: '', limit: 51 })).ok).toBe(
    false,
  );
});

test('schema 011 migration preserves channels, customer IDs, drafts, ownership and invoice references', () => {
  const file = path.join(h.dir, 'previous.sqlite');
  copyFileSync(
    path.resolve('tests/fixtures/db/schema-v011-populated.sqlite'),
    file,
  );
  const db = openDatabase(file);
  try {
    const channels = db.prepare('SELECT * FROM channels ORDER BY id').all();
    const customers = db.prepare('SELECT id FROM customers ORDER BY id').all();
    const references = db
      .prepare('SELECT id,customer_id,status FROM invoices ORDER BY id')
      .all();
    const owners = db
      .prepare('SELECT * FROM vehicle_ownerships ORDER BY id')
      .all();
    expect(migrateDatabase(db).applied).toEqual(
      bundledMigrations
        .filter((migration) => migration.version > 11)
        .map((migration) => migration.version),
    );
    expect(db.prepare('SELECT * FROM channels ORDER BY id').all()).toEqual(
      channels,
    );
    expect(db.prepare('SELECT id FROM customers ORDER BY id').all()).toEqual(
      customers,
    );
    expect(
      db
        .prepare('SELECT id,customer_id,status FROM invoices ORDER BY id')
        .all(),
    ).toEqual(references);
    expect(
      db.prepare('SELECT * FROM vehicle_ownerships ORDER BY id').all(),
    ).toEqual(owners);
    expect(
      db
        .prepare(
          'SELECT count(*) AS n FROM customers WHERE is_active=1 AND external_id IS NULL',
        )
        .get(),
    ).toEqual({ n: BigInt(customers.length) });
  } finally {
    db.close();
  }
});
