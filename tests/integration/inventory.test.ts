import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { withWriteTransaction, openDatabase } from '@/main/database/connection';
import { migrateDatabase } from '@/main/database/migrate';
import {
  readSaleEntriesForInvoice,
  recordSale,
  recordVoidReversal,
} from '@/main/features/inventory/ledger';
import { InventoryService } from '@/main/features/inventory/service';
import type { Session } from '@/main/features/auth/sessions';
import { CHANNELS } from '@/shared/channels';
import type {
  CatalogItemDto,
  LedgerDto,
  ReferenceDto,
  StockChangeDto,
  StockDto,
  StockListDto,
} from '@/shared/contracts';
import { toInstant } from '@/shared/time';
import {
  ADMIN_PASSWORD,
  createHarness,
  failure,
  validSetup,
  value,
  type Harness,
} from './helpers/harness';

const C = CHANNELS;
const ADMIN = 1;
const CASHIER = 2;
const T0 = Date.UTC(2026, 8, 30, 3, 0, 0);

let h: Harness;
let nowMs = T0;
let pcs: string;
let adminId: string;
let cashierId: string;
let counter = 0;

/** Distinct, valid UUID per call. */
function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

beforeEach(async () => {
  nowMs = T0;
  counter = 0;
  h = createHarness({ clock: { now: () => toInstant(nowMs) } });
  value(await h.call(C.settings.completeSetup, validSetup()));
  const login = value(
    await h.call<{ cashierId: string }>(
      C.auth.login,
      { username: 'admin', password: ADMIN_PASSWORD },
      ADMIN,
    ),
  );
  adminId = login.cashierId;
  value(
    await h.call(C.cashiers.create, {
      username: 'siti',
      displayName: 'Siti',
      password: 'siti-password-1',
      role: 'CASHIER',
    }),
  );
  cashierId = value(
    await h.call<{ cashierId: string }>(
      C.auth.login,
      { username: 'siti', password: 'siti-password-1' },
      CASHIER,
    ),
  ).cashierId;
  const units = value(
    await h.call<ReferenceDto[]>(C.references.list, { entity: 'unit' }),
  );
  pcs = units.find((u) => u.code === 'PCS')!.id;
});
afterEach(() => h.close());

const rows = (sql: string, ...params: unknown[]) =>
  h.db.prepare(sql).all(...params) as Record<string, unknown>[];

async function newItem(overrides: Record<string, unknown> = {}) {
  return value(
    await h.call<CatalogItemDto>(
      C.catalog.save,
      { type: 'STOCK_ITEM', title: 'Oli MPX2', unitId: pcs, ...overrides },
      ADMIN,
    ),
  );
}

type Op = 'openBalance' | 'receive' | 'adjust' | 'setStock';
const channelOf = (op: Op) => C.inventory[op];

function call(
  op: Op,
  input: Record<string, unknown>,
  windowId = ADMIN,
  requestId: string = uuid(),
) {
  return h.call<StockChangeDto>(
    channelOf(op),
    { requestId, ...input },
    windowId,
  );
}

async function stockOf(itemId: string, windowId = ADMIN): Promise<number> {
  return value(
    await h.call<StockDto>(
      C.inventory.getStock,
      { catalogItemId: itemId },
      windowId,
    ),
  ).quantity;
}

/** Runs a raw ledger insert; returns the SQLite error message or undefined. */
function rawInsert(fields: Record<string, unknown>): string | undefined {
  const row = {
    id: uuid(),
    catalog_item_id: null,
    movement_type: 'STOCK_IN',
    quantity_delta: 1n,
    reference_type: null,
    reference_id: null,
    note: null,
    reverses_entry_id: null,
    created_by_cashier_id: adminId,
    created_at: '2026-09-30T03:00:00.000Z',
    ...fields,
  };
  try {
    h.db
      .prepare(
        `INSERT INTO stock_ledger_entries (id, catalog_item_id, movement_type, quantity_delta,
           reference_type, reference_id, note, reverses_entry_id, created_by_cashier_id, created_at)
         VALUES (@id, @catalog_item_id, @movement_type, @quantity_delta, @reference_type,
           @reference_id, @note, @reverses_entry_id, @created_by_cashier_id, @created_at)`,
      )
      .run(row);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

const admin = (): Session => ({
  windowId: ADMIN,
  cashierId: adminId,
  username: 'admin',
  displayName: 'Pak Budi',
  role: 'ADMIN',
});
const actor = () => ({ cashierId: adminId });
const at = () => toInstant(nowMs);
const write = <T>(work: () => T) => withWriteTransaction(h.db, work);

describe('stock operations', () => {
  test('opening balance, then set stock 30 -> 25 writes a -5 adjustment (the required assertions)', async () => {
    const item = await newItem();
    value(await call('openBalance', { catalogItemId: item.id, quantity: 30 }));
    expect(await stockOf(item.id)).toBe(30);

    nowMs += 1000;
    const setStockResult = value(
      await call('setStock', {
        catalogItemId: item.id,
        targetQuantity: 25,
        reason: 'Stock opname',
      }),
    );
    expect(setStockResult.quantityDelta).toBe(-5);
    expect(setStockResult.newQuantity).toBe(25);
    const stockAfterSetting30To25 = await stockOf(item.id);
    expect(stockAfterSetting30To25).toBe(25);

    const adjustmentWithoutReason = await call('adjust', {
      catalogItemId: item.id,
      quantityDelta: -1,
    });
    expect(failure(adjustmentWithoutReason).code).toBe('REASON_REQUIRED');
    const blank = await call('adjust', {
      catalogItemId: item.id,
      quantityDelta: -1,
      reason: '   ',
    });
    expect(failure(blank).code).toBe('REASON_REQUIRED');
    const blankSet = await call('setStock', {
      catalogItemId: item.id,
      targetQuantity: 3,
      reason: '  ',
    });
    expect(failure(blankSet).code).toBe('REASON_REQUIRED');
    expect(await stockOf(item.id)).toBe(25);

    const ledger = rows(
      'SELECT movement_type, quantity_delta, note FROM stock_ledger_entries ORDER BY rowid',
    );
    expect(ledger).toEqual([
      { movement_type: 'OPENING_BALANCE', quantity_delta: 30n, note: null },
      {
        movement_type: 'ADJUSTMENT',
        quantity_delta: -5n,
        note: 'Stock opname',
      },
    ]);
  });

  test('receive adds stock; quantities must be positive integers', async () => {
    const item = await newItem();
    const received = value(
      await call('receive', {
        catalogItemId: item.id,
        quantity: 12,
        note: 'Supplier A',
      }),
    );
    expect(received).toMatchObject({ quantityDelta: 12, newQuantity: 12 });
    expect(
      rows(
        "SELECT note FROM stock_ledger_entries WHERE movement_type = 'STOCK_IN'",
      ),
    ).toEqual([{ note: 'Supplier A' }]);
    for (const quantity of [0, -3, 1.5, '4']) {
      const r = await call('receive', { catalogItemId: item.id, quantity });
      expect(failure(r).code).toBe('VALIDATION_FAILED');
    }
    expect(
      failure(
        await call('adjust', {
          catalogItemId: item.id,
          quantityDelta: 0,
          reason: 'x',
        }),
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(await stockOf(item.id)).toBe(12);
  });

  test('duplicate opening balances are refused, by the service and by the database', async () => {
    const item = await newItem();
    value(await call('openBalance', { catalogItemId: item.id, quantity: 10 }));
    const second = await call('openBalance', {
      catalogItemId: item.id,
      quantity: 99,
    });
    expect(failure(second).code).toBe('OPENING_BALANCE_EXISTS');
    expect(await stockOf(item.id)).toBe(10);
    expect(
      rawInsert({
        catalog_item_id: item.id,
        movement_type: 'OPENING_BALANCE',
        quantity_delta: 5n,
      }),
    ).toMatch(/UNIQUE/);

    // Opening stock is only for an item with no stock history (spec 39).
    const other = await newItem({ title: 'Kampas rem' });
    value(await call('receive', { catalogItemId: other.id, quantity: 4 }));
    const late = await call('openBalance', {
      catalogItemId: other.id,
      quantity: 4,
    });
    expect(failure(late).code).toBe('OPENING_BALANCE_EXISTS');

    // A zero opening balance is a valid explicit starting point.
    const empty = await newItem({ title: 'Busi' });
    expect(
      value(await call('openBalance', { catalogItemId: empty.id, quantity: 0 }))
        .newQuantity,
    ).toBe(0);
    expect(
      failure(
        await call('openBalance', { catalogItemId: empty.id, quantity: 3 }),
      ).code,
    ).toBe('OPENING_BALANCE_EXISTS');
  });

  test('a set-stock to the current quantity writes nothing', async () => {
    const item = await newItem();
    value(await call('openBalance', { catalogItemId: item.id, quantity: 8 }));
    const before = rows('SELECT id FROM stock_ledger_entries').length;
    const auditBefore = rows('SELECT id FROM audit_log').length;
    const result = value(
      await call('setStock', {
        catalogItemId: item.id,
        targetQuantity: 8,
        reason: 'Count matches',
      }),
    );
    expect(result).toMatchObject({ quantityDelta: 0, newQuantity: 8 });
    expect(rows('SELECT id FROM stock_ledger_entries')).toHaveLength(before);
    expect(rows('SELECT id FROM audit_log')).toHaveLength(auditBefore);
  });

  test('negative stock is allowed and surfaced by the list filter', async () => {
    const low = await newItem({ title: 'Aki' });
    const fine = await newItem({ title: 'Busi' });
    value(await call('openBalance', { catalogItemId: fine.id, quantity: 5 }));
    const adjusted = value(
      await call('adjust', {
        catalogItemId: low.id,
        quantityDelta: -2,
        reason: 'Broken units',
      }),
    );
    expect(adjusted.newQuantity).toBe(-2);
    expect(await stockOf(low.id)).toBe(-2);

    const all = value(
      await h.call<StockListDto>(C.inventory.listStock, {}, CASHIER),
    );
    expect(all.items.map((i) => [i.title, i.quantity, i.isNegative])).toEqual([
      ['Aki', -2, true],
      ['Busi', 5, false],
    ]);
    const negatives = value(
      await h.call<StockListDto>(
        C.inventory.listStock,
        { negativeOnly: true },
        CASHIER,
      ),
    );
    expect(negatives.items.map((i) => i.title)).toEqual(['Aki']);
    const searched = value(
      await h.call<StockListDto>(
        C.inventory.listStock,
        { query: 'bus' },
        ADMIN,
      ),
    );
    expect(searched.items.map((i) => i.title)).toEqual(['Busi']);
  });

  test('history is newest first with localized-ready fields, the cashier name and the shop timezone', async () => {
    const item = await newItem();
    value(await call('openBalance', { catalogItemId: item.id, quantity: 10 }));
    nowMs += 60_000;
    value(await call('receive', { catalogItemId: item.id, quantity: 5 }));
    nowMs += 60_000;
    value(
      await call('adjust', {
        catalogItemId: item.id,
        quantityDelta: -3,
        reason: 'Damaged',
      }),
    );
    const ledger = value(
      await h.call<LedgerDto>(
        C.inventory.history,
        { catalogItemId: item.id },
        CASHIER,
      ),
    );
    expect(ledger.timezone).toBe('Asia/Jakarta');
    expect(ledger.entries.map((e) => e.movementType)).toEqual([
      'ADJUSTMENT',
      'STOCK_IN',
      'OPENING_BALANCE',
    ]);
    expect(ledger.entries[0]).toMatchObject({
      quantityDelta: -3,
      note: 'Damaged',
      cashierName: 'Pak Budi',
      createdAt: '2026-09-30T03:02:00.000Z',
    });
    expect(JSON.parse(JSON.stringify(ledger))).toEqual(ledger);
  });
});

describe('authorization', () => {
  test('a CASHIER can read stock but every write is FORBIDDEN and writes nothing', async () => {
    const item = await newItem();
    value(await call('openBalance', { catalogItemId: item.id, quantity: 4 }));
    expect(await stockOf(item.id, CASHIER)).toBe(4);
    for (const [op, input] of [
      ['openBalance', { quantity: 1 }],
      ['receive', { quantity: 1 }],
      ['adjust', { quantityDelta: 1, reason: 'x' }],
      ['setStock', { targetQuantity: 9, reason: 'x' }],
    ] as [Op, Record<string, unknown>][]) {
      const r = await call(op, { catalogItemId: item.id, ...input }, CASHIER);
      expect(failure(r).code).toBe('FORBIDDEN');
    }
    expect(rows('SELECT id FROM stock_ledger_entries')).toHaveLength(1);
    expect(rows('SELECT request_id FROM command_receipts')).toHaveLength(1);
  });

  test('no session is UNAUTHENTICATED for reads and writes', async () => {
    const item = await newItem();
    const r = await h.call(
      C.inventory.getStock,
      { catalogItemId: item.id },
      99,
    );
    expect(failure(r).code).toBe('UNAUTHENTICATED');
    expect(
      failure(
        await call('receive', { catalogItemId: item.id, quantity: 1 }, 99),
      ).code,
    ).toBe('UNAUTHENTICATED');
  });
});

describe('items that do not track inventory', () => {
  test('services and untracked items are rejected by the service and by the database', async () => {
    const service = await newItem({ type: 'SERVICE', title: 'Ganti oli' });
    const untracked = await newItem({ title: 'Baut', trackInventory: false });
    for (const item of [service, untracked]) {
      for (const [op, input] of [
        ['openBalance', { quantity: 1 }],
        ['receive', { quantity: 1 }],
        ['adjust', { quantityDelta: 1, reason: 'x' }],
        ['setStock', { targetQuantity: 1, reason: 'x' }],
      ] as [Op, Record<string, unknown>][]) {
        const r = await call(op, { catalogItemId: item.id, ...input });
        expect(failure(r).code).toBe('ITEM_NOT_INVENTORY_TRACKED');
      }
      expect(
        rawInsert({
          catalog_item_id: item.id,
          movement_type: 'STOCK_IN',
          quantity_delta: 1n,
        }),
      ).toMatch(/track/i);
    }
    expect(rows('SELECT id FROM stock_ledger_entries')).toHaveLength(0);
    const missing = await call('receive', {
      catalogItemId: uuid(),
      quantity: 1,
    });
    expect(failure(missing).code).toBe('CATALOG_ITEM_NOT_FOUND');
  });

  test('the tracking-change guard blocks changes once any ledger entry exists', async () => {
    const free = await newItem({ title: 'Belum ada stok' });
    const flipped = value(
      await h.call<CatalogItemDto>(
        C.catalog.save,
        {
          id: free.id,
          type: 'STOCK_ITEM',
          title: 'Belum ada stok',
          unitId: pcs,
          trackInventory: false,
        },
        ADMIN,
      ),
    );
    expect(flipped.trackInventory).toBe(false);

    const item = await newItem();
    value(await call('receive', { catalogItemId: item.id, quantity: 2 }));
    const blocked = await h.call(
      C.catalog.save,
      {
        id: item.id,
        type: 'STOCK_ITEM',
        title: 'Oli MPX2',
        unitId: pcs,
        trackInventory: false,
      },
      ADMIN,
    );
    expect(failure(blocked).code).toBe('TRACKING_LOCKED_BY_LEDGER');
    expect(
      rows('SELECT track_inventory FROM catalog_items WHERE id = ?', item.id),
    ).toEqual([{ track_inventory: 1n }]);
    // Other edits still work; so does an unchanged flag.
    value(
      await h.call(
        C.catalog.save,
        {
          id: item.id,
          type: 'STOCK_ITEM',
          title: 'Oli MPX2 1L',
          unitId: pcs,
          trackInventory: true,
        },
        ADMIN,
      ),
    );
    // The schema refuses it too, should something bypass the service.
    expect(() =>
      h.db
        .prepare('UPDATE catalog_items SET track_inventory = 0 WHERE id = ?')
        .run(item.id),
    ).toThrow(/ledger/i);
  });
});

describe('append-only ledger', () => {
  test('UPDATE and DELETE are rejected by the database', async () => {
    const item = await newItem();
    value(await call('receive', { catalogItemId: item.id, quantity: 2 }));
    expect(() =>
      h.db.prepare('UPDATE stock_ledger_entries SET quantity_delta = 99').run(),
    ).toThrow(/append-only/);
    expect(() =>
      h.db.prepare("UPDATE stock_ledger_entries SET note = 'x'").run(),
    ).toThrow(/append-only/);
    expect(() =>
      h.db.prepare('DELETE FROM stock_ledger_entries').run(),
    ).toThrow(/append-only/);
    expect(await stockOf(item.id)).toBe(2);
  });

  test('CHECK constraints enforce the sign and reason rules per movement type', async () => {
    const item = await newItem();
    const base = { catalog_item_id: item.id };
    const refs = { reference_type: 'INVOICE', reference_id: uuid() };
    expect(
      rawInsert({ ...base, movement_type: 'STOCK_IN', quantity_delta: 0n }),
    ).toMatch(/CHECK/);
    expect(
      rawInsert({ ...base, movement_type: 'STOCK_IN', quantity_delta: -1n }),
    ).toMatch(/CHECK/);
    expect(
      rawInsert({
        ...base,
        movement_type: 'OPENING_BALANCE',
        quantity_delta: -1n,
      }),
    ).toMatch(/CHECK/);
    expect(
      rawInsert({
        ...base,
        ...refs,
        movement_type: 'SALE',
        quantity_delta: 1n,
      }),
    ).toMatch(/CHECK/);
    expect(
      rawInsert({
        ...base,
        ...refs,
        movement_type: 'SALE',
        quantity_delta: 0n,
      }),
    ).toMatch(/CHECK/);
    expect(
      rawInsert({
        ...base,
        movement_type: 'ADJUSTMENT',
        quantity_delta: 0n,
        note: 'x',
      }),
    ).toMatch(/CHECK/);
    expect(
      rawInsert({ ...base, movement_type: 'ADJUSTMENT', quantity_delta: 2n }),
    ).toMatch(/CHECK/);
    expect(
      rawInsert({
        ...base,
        movement_type: 'ADJUSTMENT',
        quantity_delta: 2n,
        note: '  ',
      }),
    ).toMatch(/CHECK/);
    expect(
      rawInsert({ ...base, movement_type: 'BOGUS', quantity_delta: 2n }),
    ).toMatch(/CHECK/);
    // A SALE needs the reference that ties it to its invoice.
    expect(
      rawInsert({ ...base, movement_type: 'SALE', quantity_delta: -1n }),
    ).toMatch(/CHECK/);
    expect(rows('SELECT id FROM stock_ledger_entries')).toHaveLength(0);
    // The valid forms go in.
    expect(
      rawInsert({
        ...base,
        movement_type: 'ADJUSTMENT',
        quantity_delta: -2n,
        note: 'ok',
      }),
    ).toBeUndefined();
  });
});

describe('SALE and VOID_REVERSAL (used by finalization and void)', () => {
  test('recordSale writes a negative SALE keyed to the invoice; a duplicate for the same invoice+item is rejected', async () => {
    const item = await newItem();
    const other = await newItem({ title: 'Kampas' });
    value(await call('openBalance', { catalogItemId: item.id, quantity: 10 }));
    const invoiceId = uuid();
    const saleId = write(() =>
      recordSale(h.db, {
        invoiceId,
        catalogItemId: item.id,
        quantity: 3,
        actor: actor(),
        at: at(),
      }),
    );
    expect(await stockOf(item.id)).toBe(7);
    expect(
      rows(
        'SELECT movement_type, quantity_delta, reference_type, reference_id FROM stock_ledger_entries WHERE id = ?',
        saleId,
      ),
    ).toEqual([
      {
        movement_type: 'SALE',
        quantity_delta: -3n,
        reference_type: 'INVOICE',
        reference_id: invoiceId,
      },
    ]);
    expect(() =>
      write(() =>
        recordSale(h.db, {
          invoiceId,
          catalogItemId: item.id,
          quantity: 1,
          actor: actor(),
          at: at(),
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'SALE_ALREADY_RECORDED' }));
    expect(await stockOf(item.id)).toBe(7);
    // Same invoice, other item is fine (finalization aggregates demand per item).
    value(await call('openBalance', { catalogItemId: other.id, quantity: 1 }));
    write(() =>
      recordSale(h.db, {
        invoiceId,
        catalogItemId: other.id,
        quantity: 2,
        actor: actor(),
        at: at(),
      }),
    );
    expect(await stockOf(other.id)).toBe(-1);
    expect(
      readSaleEntriesForInvoice(h.db, invoiceId)
        .map((e) => [e.catalogItemId, e.quantity, e.reversedByEntryId])
        .sort(),
    ).toEqual(
      [
        [item.id, 3, null],
        [other.id, 2, null],
      ].sort(),
    );
    // And the database backs the unique rule up.
    expect(
      rawInsert({
        catalog_item_id: item.id,
        movement_type: 'SALE',
        quantity_delta: -1n,
        reference_type: 'INVOICE',
        reference_id: invoiceId,
      }),
    ).toMatch(/UNIQUE/);
  });

  test('recordSale refuses untracked items and non-positive or fractional quantities', async () => {
    const service = await newItem({ type: 'SERVICE', title: 'Jasa' });
    const item = await newItem();
    expect(() =>
      write(() =>
        recordSale(h.db, {
          invoiceId: uuid(),
          catalogItemId: service.id,
          quantity: 1,
          actor: actor(),
          at: at(),
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'ITEM_NOT_INVENTORY_TRACKED' }));
    for (const quantity of [0, -1, 1.5]) {
      expect(() =>
        write(() =>
          recordSale(h.db, {
            invoiceId: uuid(),
            catalogItemId: item.id,
            quantity,
            actor: actor(),
            at: at(),
          }),
        ),
      ).toThrow(expect.objectContaining({ code: 'INVALID_QUANTITY' }));
    }
    expect(() =>
      recordSale(h.db, {
        invoiceId: uuid(),
        catalogItemId: item.id,
        quantity: 1,
        actor: actor(),
        at: at(),
      }),
    ).toThrow(/transaction/i);
    expect(rows('SELECT id FROM stock_ledger_entries')).toHaveLength(0);
  });

  test('a void reversal negates its sale exactly once', async () => {
    const item = await newItem();
    const invoiceId = uuid();
    const saleId = write(() =>
      recordSale(h.db, {
        invoiceId,
        catalogItemId: item.id,
        quantity: 2,
        actor: actor(),
        at: at(),
      }),
    );
    expect(await stockOf(item.id)).toBe(-2);
    nowMs += 1000;
    const reversalId = write(() =>
      recordVoidReversal(h.db, {
        saleEntryId: saleId,
        actor: actor(),
        at: at(),
      }),
    );
    expect(await stockOf(item.id)).toBe(0);
    expect(
      rows(
        'SELECT movement_type, quantity_delta, reverses_entry_id, reference_id, catalog_item_id FROM stock_ledger_entries WHERE id = ?',
        reversalId,
      ),
    ).toEqual([
      {
        movement_type: 'VOID_REVERSAL',
        quantity_delta: 2n,
        reverses_entry_id: saleId,
        reference_id: invoiceId,
        catalog_item_id: item.id,
      },
    ]);
    expect(readSaleEntriesForInvoice(h.db, invoiceId)[0]).toMatchObject({
      id: saleId,
      reversedByEntryId: reversalId,
    });

    // A second reversal is refused by the helper, and by the database.
    expect(() =>
      write(() =>
        recordVoidReversal(h.db, {
          saleEntryId: saleId,
          actor: actor(),
          at: at(),
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'SALE_ALREADY_REVERSED' }));
    expect(
      rawInsert({
        catalog_item_id: item.id,
        movement_type: 'VOID_REVERSAL',
        quantity_delta: 2n,
        reference_type: 'INVOICE',
        reference_id: invoiceId,
        reverses_entry_id: saleId,
      }),
    ).toMatch(/UNIQUE/);
    expect(await stockOf(item.id)).toBe(0);
  });

  test('the database rejects reversals that do not exactly match a SALE', async () => {
    const item = await newItem();
    const other = await newItem({ title: 'Kampas' });
    const invoiceId = uuid();
    const saleId = write(() =>
      recordSale(h.db, {
        invoiceId,
        catalogItemId: item.id,
        quantity: 2,
        actor: actor(),
        at: at(),
      }),
    );
    const reversal = {
      catalog_item_id: item.id,
      movement_type: 'VOID_REVERSAL',
      quantity_delta: 2n,
      reference_type: 'INVOICE',
      reference_id: invoiceId,
      reverses_entry_id: saleId,
    };
    // Wrong quantity, wrong item, wrong invoice, no link, link to a non-sale.
    expect(rawInsert({ ...reversal, quantity_delta: 1n })).toMatch(/exactly/);
    expect(rawInsert({ ...reversal, quantity_delta: 3n })).toMatch(/exactly/);
    expect(rawInsert({ ...reversal, catalog_item_id: other.id })).toMatch(
      /exactly/,
    );
    expect(rawInsert({ ...reversal, reference_id: uuid() })).toMatch(/exactly/);
    expect(rawInsert({ ...reversal, reverses_entry_id: null })).toMatch(
      /CHECK|exactly/,
    );
    expect(rawInsert({ ...reversal, reverses_entry_id: uuid() })).toMatch(
      /FOREIGN KEY|exactly/,
    );
    const stockIn = uuid();
    expect(
      rawInsert({
        id: stockIn,
        catalog_item_id: item.id,
        movement_type: 'STOCK_IN',
        quantity_delta: 2n,
      }),
    ).toBeUndefined();
    expect(rawInsert({ ...reversal, reverses_entry_id: stockIn })).toMatch(
      /exactly/,
    );
    // Only VOID_REVERSAL may carry a link.
    expect(
      rawInsert({
        catalog_item_id: item.id,
        movement_type: 'STOCK_IN',
        quantity_delta: 2n,
        reverses_entry_id: saleId,
      }),
    ).toMatch(/CHECK/);
    expect(await stockOf(item.id)).toBe(0);
    // The exact negation goes in.
    expect(rawInsert(reversal)).toBeUndefined();
    expect(await stockOf(item.id)).toBe(2);
  });
});

describe('retries and concurrency', () => {
  test('a retried requestId has exactly one effect and returns the same result', async () => {
    const item = await newItem();
    value(await call('openBalance', { catalogItemId: item.id, quantity: 10 }));
    const requestId = uuid();
    const input = {
      catalogItemId: item.id,
      quantityDelta: -4,
      reason: 'Damaged',
    };
    const first = value(await call('adjust', input, ADMIN, requestId));
    nowMs += 5000;
    const replay = value(await call('adjust', input, ADMIN, requestId));
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ quantityDelta: -4, newQuantity: 6 });
    expect(await stockOf(item.id)).toBe(6);
    expect(
      rows(
        "SELECT id FROM stock_ledger_entries WHERE movement_type = 'ADJUSTMENT'",
      ),
    ).toHaveLength(1);
    expect(
      rows("SELECT id FROM audit_log WHERE action = 'STOCK_ADJUSTED'"),
    ).toHaveLength(1);

    // A retried set-stock does not recompute against the new state.
    const setId = uuid();
    const set = {
      catalogItemId: item.id,
      targetQuantity: 1,
      reason: 'Recount',
    };
    const s1 = value(await call('setStock', set, ADMIN, setId));
    const s2 = value(await call('setStock', set, ADMIN, setId));
    expect(s1.quantityDelta).toBe(-5);
    expect(s2).toEqual(s1);
    expect(await stockOf(item.id)).toBe(1);
  });

  test('reusing a requestId with different input is IDEMPOTENCY_KEY_REUSED (a client error)', async () => {
    const item = await newItem();
    const requestId = uuid();
    value(
      await call(
        'receive',
        { catalogItemId: item.id, quantity: 5 },
        ADMIN,
        requestId,
      ),
    );
    const different = await call(
      'receive',
      { catalogItemId: item.id, quantity: 6 },
      ADMIN,
      requestId,
    );
    expect(failure(different)).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      messageKey: 'errors.IDEMPOTENCY_KEY_REUSED',
    });
    const otherCommand = await call(
      'openBalance',
      { catalogItemId: item.id, quantity: 5 },
      ADMIN,
      requestId,
    );
    expect(failure(otherCommand).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await stockOf(item.id)).toBe(5);
  });

  test('a failed command records no receipt, so the same requestId can be retried after the cause is fixed', async () => {
    const item = await newItem({ trackInventory: false });
    const requestId = uuid();
    const input = { catalogItemId: item.id, quantity: 5 };
    expect(failure(await call('receive', input, ADMIN, requestId)).code).toBe(
      'ITEM_NOT_INVENTORY_TRACKED',
    );
    expect(rows('SELECT request_id FROM command_receipts')).toHaveLength(0);
  });

  test('two set-stock calls from separate connections each compute their delta from committed state', async () => {
    const item = await newItem();
    value(await call('openBalance', { catalogItemId: item.id, quantity: 30 }));
    const second = openDatabase(`${h.dir}/db.sqlite`);
    migrateDatabase(second);
    try {
      const clock = { now: () => toInstant(nowMs) };
      const other = new InventoryService({ db: second, clock });
      nowMs += 1000;
      const a = value(
        await h.call<StockChangeDto>(C.inventory.setStock, {
          requestId: uuid(),
          catalogItemId: item.id,
          targetQuantity: 25,
          reason: 'A counted',
        }),
      );
      const b = other.setStock(admin(), {
        requestId: uuid(),
        catalogItemId: item.id,
        targetQuantity: 20,
        reason: 'B counted',
      });
      expect(a.quantityDelta).toBe(-5);
      expect(b).toMatchObject({ quantityDelta: -5, newQuantity: 20 });
      // Same target again, other connection, new requestId: nothing left to do.
      const c = other.setStock(admin(), {
        requestId: uuid(),
        catalogItemId: item.id,
        targetQuantity: 20,
        reason: 'C counted',
      });
      expect(c.quantityDelta).toBe(0);
      expect(await stockOf(item.id)).toBe(20);
      expect(
        rows(
          "SELECT id FROM stock_ledger_entries WHERE movement_type = 'ADJUSTMENT'",
        ),
      ).toHaveLength(2);
    } finally {
      second.close();
    }
  });
});

describe('audit', () => {
  test('every stock write is audited with the actor, item and quantities', async () => {
    const item = await newItem();
    value(await call('openBalance', { catalogItemId: item.id, quantity: 30 }));
    value(
      await call('receive', {
        catalogItemId: item.id,
        quantity: 5,
        note: 'PO-7',
      }),
    );
    value(
      await call('adjust', {
        catalogItemId: item.id,
        quantityDelta: -2,
        reason: 'Broken',
      }),
    );
    value(
      await call('setStock', {
        catalogItemId: item.id,
        targetQuantity: 20,
        reason: 'Recount',
      }),
    );
    const audit = rows(
      "SELECT cashier_id, action, entity_type, entity_id, metadata FROM audit_log WHERE entity_type = 'catalog_item' AND action LIKE 'STOCK_%' ORDER BY id",
    );
    expect(audit.map((r) => r.action)).toEqual([
      'STOCK_OPENING_BALANCE_RECORDED',
      'STOCK_RECEIVED',
      'STOCK_ADJUSTED',
      'STOCK_ADJUSTED',
    ]);
    for (const r of audit) {
      expect(r.cashier_id).toBe(adminId);
      expect(r.entity_id).toBe(item.id);
    }
    expect(JSON.parse(audit[3]!.metadata as string)).toMatchObject({
      via: 'SET_STOCK',
      quantityDelta: -13,
      previousQuantity: 33,
      newQuantity: 20,
      reason: 'Recount',
    });
    expect(JSON.parse(audit[2]!.metadata as string)).toMatchObject({
      via: 'ADJUST',
      quantityDelta: -2,
      reason: 'Broken',
    });
  });

  test('forbidden and failed writes leave no audit rows', async () => {
    const item = await newItem();
    await call('receive', { catalogItemId: item.id, quantity: 5 }, CASHIER);
    await call('adjust', { catalogItemId: item.id, quantityDelta: 1 });
    expect(
      rows("SELECT id FROM audit_log WHERE action LIKE 'STOCK_%'"),
    ).toHaveLength(0);
    expect(cashierId).toBeTruthy();
  });
});
