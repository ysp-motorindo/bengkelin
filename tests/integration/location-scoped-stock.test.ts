import { randomUUID } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openDatabase } from '@/main/database/connection';
import { bundledMigrations, migrateDatabase } from '@/main/database/migrate';
import { CHANNELS as C } from '@/shared/channels';
import type {
  CatalogItemDto,
  DraftOperation,
  DraftView,
  FinalizePreviewDto,
  InvoiceView,
  LedgerDto,
  ReferenceDto,
  StockDto,
} from '@/shared/contracts';
import {
  ADMIN_PASSWORD,
  createHarness,
  failure,
  validSetup,
  value,
  type Harness,
} from './helpers/harness';
let h: Harness;
let a: ReferenceDto;
let b: ReferenceDto;
let item: CatalogItemDto;
let channelId: string;
beforeEach(async () => {
  h = createHarness();
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  const location = async (code: string, label: string) =>
    value(
      await h.call<ReferenceDto>(C.references.save, {
        entity: 'stockLocation',
        code,
        label,
        isDefault: code === 'A',
      }),
    );
  a = await location('A', 'Alpha');
  b = await location('B', 'Beta');
  const units = value(
    await h.call<ReferenceDto[]>(C.references.list, { entity: 'unit' }),
  );
  channelId = value(
    await h.call<ReferenceDto[]>(C.references.list, { entity: 'channel' }),
  )[0]!.id;
  item = value(
    await h.call<CatalogItemDto>(C.catalog.save, {
      type: 'STOCK_ITEM',
      title: 'Oil',
      unitId: units[0]!.id,
      trackInventory: true,
    }),
  );
});
afterEach(() => h.close());
const stock = async (loc: ReferenceDto) =>
  value(
    await h.call<StockDto>(C.inventory.getStock, {
      catalogItemId: item.id,
      stockLocationId: loc.id,
    }),
  );
const receive = (loc: ReferenceDto, quantity: number) =>
  h.call(C.inventory.receive, {
    requestId: randomUUID(),
    catalogItemId: item.id,
    stockLocationId: loc.id,
    quantity,
  });
const create = (stockLocationId?: string) =>
  h.call<DraftView>(C.drafts.create, {
    requestId: randomUUID(),
    channelId,
    invoiceDate: '2026-09-30',
    pricingAt: '2026-09-30T03:00:00.000Z',
    ...(stockLocationId ? { stockLocationId } : {}),
  });
const apply = async (draft: DraftView, op: DraftOperation) =>
  value(
    await h.call<DraftView>(C.drafts.apply, {
      requestId: randomUUID(),
      invoiceId: draft.id,
      expectedVersion: draft.version,
      op,
    }),
  );
async function ready(loc = a) {
  let d = value(await create(loc.id));
  d = await apply(d, {
    kind: 'addCatalogLine',
    catalogItemId: item.id,
    quantity: 2,
    unitPrice: '1000',
  });
  const c = value(
    await h.call<{ saved: boolean; customer: { id: string } }>(
      C.customers.save,
      { name: 'Buyer' },
    ),
  );
  d = await apply(d, {
    kind: 'updateHeader',
    changes: { topDays: 30, customerId: c.customer.id },
  });
  return apply(d, { kind: 'setCashPayment', amount: '0' });
}
const preview = async (d: DraftView) =>
  value(
    await h.call<FinalizePreviewDto>(C.invoices.previewFinalize, {
      invoiceId: d.id,
    }),
  );
const finalize = (d: DraftView, p: FinalizePreviewDto) =>
  h.call<InvoiceView>(C.invoices.finalize, {
    requestId: randomUUID(),
    invoiceId: d.id,
    expectedVersion: d.version,
    acknowledgedWarnings: p.warnings,
  });

test('receipts, opening balances, adjustments and history are scoped to location', async () => {
  for (const loc of [a, b])
    value(
      await h.call(C.inventory.openBalance, {
        requestId: randomUUID(),
        catalogItemId: item.id,
        stockLocationId: loc.id,
        quantity: 10,
      }),
    );
  value(await receive(a, 5));
  value(
    await h.call(C.inventory.setStock, {
      requestId: randomUUID(),
      catalogItemId: item.id,
      stockLocationId: b.id,
      targetQuantity: 3,
      reason: 'Count',
    }),
  );
  expect(await stock(a)).toMatchObject({
    quantity: 15,
    stockLocation: { id: a.id, code: 'A' },
  });
  expect((await stock(b)).quantity).toBe(3);
  const history = value(
    await h.call<LedgerDto>(C.inventory.history, {
      catalogItemId: item.id,
      stockLocationId: a.id,
    }),
  );
  expect(history.entries.map((e) => e.quantityDelta)).toEqual([5, 10]);
  expect(history.stockLocation.id).toBe(a.id);
  expect(
    failure(await h.call(C.inventory.getStock, { catalogItemId: item.id }))
      .code,
  ).toBe('VALIDATION_FAILED');
});
test('no active location rejects draft creation without an invoice, receipt, or number', async () => {
  for (const loc of [a, b])
    value(
      await h.call(C.references.deactivate, {
        entity: 'stockLocation',
        id: loc.id,
      }),
    );
  expect(failure(await create()).code).toBe('STOCK_LOCATION_REQUIRED');
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM invoices').get()).toEqual({
    n: 0n,
  });
  expect(
    h.db
      .prepare('SELECT COUNT(*) AS n FROM command_receipts WHERE command = ?')
      .get('drafts.create'),
  ).toEqual({ n: 0n });
  expect(
    h.db.prepare('SELECT COUNT(*) AS n FROM invoice_daily_counters').get(),
  ).toEqual({ n: 0n });
});
test('draft defaults and line stock follow the selected location without repricing', async () => {
  value(await receive(a, 7));
  value(await receive(b, 20));
  let d = value(await create());
  expect(d.stockLocation.id).toBe(a.id);
  d = await apply(d, {
    kind: 'addCatalogLine',
    catalogItemId: item.id,
    quantity: 2,
    unitPrice: '1000',
  });
  expect(d.lines[0]!.currentStock).toBe(7);
  const price = d.lines[0]!.unitPrice;
  d = await apply(d, {
    kind: 'updateHeader',
    changes: { stockLocationId: b.id },
  });
  expect(d.stockLocation.id).toBe(b.id);
  expect(d.lines[0]!.currentStock).toBe(20);
  expect(d.lines[0]!.unitPrice).toBe(price);
});
test('deactivation after checkout preview blocks finalization without partial writes', async () => {
  value(await receive(a, 10));
  const d = await ready();
  const p = await preview(d);
  expect(p.errors).toEqual([]);
  value(
    await h.call(C.references.deactivate, {
      entity: 'stockLocation',
      id: a.id,
    }),
  );
  expect(failure(await finalize(d, p)).code).toBe('STOCK_LOCATION_INACTIVE');
  expect(
    h.db
      .prepare(
        "SELECT COUNT(*) AS n FROM stock_ledger_entries WHERE movement_type = 'SALE'",
      )
      .get(),
  ).toEqual({ n: 0n });
  expect(
    h.db.prepare('SELECT status FROM invoices WHERE id = ?').get(d.id),
  ).toEqual({ status: 'DRAFT' });
});
test('finalize and void use original location and frozen facts after rename and deactivation', async () => {
  value(await receive(a, 10));
  value(await receive(b, 30));
  const d = await ready();
  const p = await preview(d);
  expect(p.errors).toEqual([]);
  const invoice = value(await finalize(d, p));
  expect(invoice.stockLocation).toEqual({
    id: a.id,
    code: 'A',
    label: 'Alpha',
  });
  expect((await stock(a)).quantity).toBe(8);
  expect((await stock(b)).quantity).toBe(30);
  value(
    await h.call(C.references.save, {
      entity: 'stockLocation',
      id: a.id,
      label: 'Renamed',
      isDefault: true,
    }),
  );
  value(
    await h.call(C.references.deactivate, {
      entity: 'stockLocation',
      id: a.id,
    }),
  );
  const voided = value(
    await h.call<InvoiceView>(C.invoices.void, {
      requestId: randomUUID(),
      invoiceId: invoice.id,
      reason: 'Cancelled',
    }),
  );
  expect(voided.stockLocation).toEqual(invoice.stockLocation);
  expect((await stock(a)).quantity).toBe(10);
  expect((await stock(b)).quantity).toBe(30);
  expect(() =>
    h.db
      .prepare('UPDATE invoices SET stock_location_id = ? WHERE id = ?')
      .run(b.id, invoice.id),
  ).toThrow();
});
test('populated v17 upgrade preserves ledger history and backfills all invoice statuses', () => {
  const file = path.join(h.dir, 'legacy.sqlite');
  copyFileSync('tests/fixtures/db/schema-v017-populated.sqlite', file);
  const db = openDatabase(file);
  try {
    const ledger = db
      .prepare('SELECT rowid, * FROM stock_ledger_entries ORDER BY rowid')
      .all();
    migrateDatabase(db);
    const loc = db
      .prepare("SELECT id, code, label FROM stock_locations WHERE code='01'")
      .get() as { id: string };
    expect(loc).toMatchObject({ code: '01', label: 'Gudang' });
    const after = db
      .prepare('SELECT rowid, * FROM stock_ledger_entries ORDER BY rowid')
      .all() as Record<string, unknown>[];
    expect(
      after.map(({ stock_location_id: _stockLocationId, ...row }) => row),
    ).toEqual(ledger);
    expect(after.every((row) => row.stock_location_id === loc.id)).toBe(true);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM invoices WHERE stock_location_id IS NULL',
        )
        .get(),
    ).toEqual({ n: 0n });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() =>
      db.prepare('UPDATE stock_ledger_entries SET quantity_delta=1').run(),
    ).toThrow('append-only');
    expect(() =>
      db
        .prepare("UPDATE invoices SET note='tampered' WHERE status='VOID'")
        .run(),
    ).toThrow();
  } finally {
    db.close();
  }
});

test('direct issued inserts cannot omit frozen location facts', async () => {
  const d = await ready();
  const issued = value(await finalize(d, await preview(d)));
  const row = h.db
    .prepare('SELECT * FROM invoices WHERE id=?')
    .get(issued.id) as Record<string, unknown>;
  const clone = {
    ...row,
    id: randomUUID(),
    invoice_number: 'INV-20260930-9999',
    reserved_invoice_number: null,
    stock_location_code_snapshot: null,
    stock_location_label_snapshot: null,
  };
  const keys = Object.keys(clone);
  expect(() =>
    h.db
      .prepare(
        `INSERT INTO invoices (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      )
      .run(...Object.values(clone)),
  ).toThrow('issued invoice location snapshot is required');
});

test('database refuses moving an invoice away from its existing sale location', async () => {
  const d = value(await create(a.id));
  const cashier = h.db.prepare('SELECT id FROM cashiers LIMIT 1').get() as {
    id: string;
  };
  h.db
    .prepare(
      `INSERT INTO stock_ledger_entries (id,catalog_item_id,stock_location_id,movement_type,quantity_delta,reference_type,reference_id,created_by_cashier_id,created_at) VALUES (?,?,?,'SALE',-1,'INVOICE',?,?,?)`,
    )
    .run(
      randomUUID(),
      item.id,
      a.id,
      d.id,
      cashier.id,
      '2026-09-30T03:00:00.000Z',
    );
  expect(() =>
    h.db
      .prepare('UPDATE invoices SET stock_location_id=? WHERE id=?')
      .run(b.id, d.id),
  ).toThrow('sale location must match invoice');
});

test('a failed location migration rolls back backfill, columns, and removed guards', () => {
  const file = path.join(h.dir, 'rollback.sqlite');
  copyFileSync('tests/fixtures/db/schema-v017-populated.sqlite', file);
  const db = openDatabase(file);
  try {
    migrateDatabase(
      db,
      bundledMigrations.filter((m) => m.version <= 18),
    );
    const ledger = db
      .prepare('SELECT rowid,* FROM stock_ledger_entries ORDER BY rowid')
      .all();
    const migration = bundledMigrations.find((m) => m.version === 19)!;
    expect(() =>
      migrateDatabase(db, [
        ...bundledMigrations.filter((m) => m.version <= 18),
        {
          ...migration,
          sql: migration.sql + '; SELECT * FROM missing_migration_probe;',
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'MIGRATION_FAILED' }));
    expect(db.pragma('user_version', { simple: true })).toBe(18n);
    expect(
      db
        .prepare('SELECT rowid,* FROM stock_ledger_entries ORDER BY rowid')
        .all(),
    ).toEqual(ledger);
    expect(db.prepare('SELECT * FROM stock_locations').all()).toEqual([]);
    expect(() =>
      db.prepare('UPDATE stock_ledger_entries SET quantity_delta=1').run(),
    ).toThrow('append-only');
    expect(() =>
      db
        .prepare("UPDATE invoices SET note='tampered' WHERE status='VOID'")
        .run(),
    ).toThrow('a void invoice cannot change');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

test('negative-stock acknowledgment is stale after changing invoice location even when quantities match', async () => {
  const d = await ready(a);
  const observed = await preview(d);
  expect(observed.warnings.some((w) => w.code === 'NEGATIVE_STOCK')).toBe(true);
  const switched = await apply(d, {
    kind: 'updateHeader',
    changes: { stockLocationId: b.id },
  });
  expect(failure(await finalize(switched, observed)).code).toBe(
    'FINALIZE_WARNINGS_CHANGED',
  );
});
