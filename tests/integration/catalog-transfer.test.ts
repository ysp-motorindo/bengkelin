import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  readCsv,
  unescapeFormulaGuard,
} from '@/main/features/catalog-transfer/reader';
import { CHANNELS } from '@/shared/channels';
import type {
  AppliedPriceChangeDto,
  CatalogFileOutcomeDto,
  CatalogItemDto,
  ImportIssueDto,
  ImportPreviewDto,
  ImportReadyDto,
  ImportSummaryDto,
  PricePreviewDto,
  ReferenceDto,
} from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';
import { resolveLocalDateTime, toInstant } from '@/shared/time';
import { FakeDialogs } from './helpers/fake-print';
import { parseCsv } from './helpers/csv';
import {
  ADMIN_PASSWORD,
  createHarness,
  failure,
  validSetup,
  value,
  type Harness,
} from './helpers/harness';

/**
 * Task 15: catalog CSV transfer (spec 37-41, 45, 47, 55, 60; Part A review
 * focus 4). Import = native open dialog in main -> strict parse -> validate
 * -> preview (token) -> commit: stale check, SAFETY backup OUTSIDE the
 * transaction, then ONE write transaction (all-or-nothing, idempotent by
 * token). Export/template = native save dialog + the T13 formula-safe writer.
 * T0 = 2026-09-30 10:00 WIB (Asia/Jakarta).
 */

const C = CHANNELS;
const ADMIN = 1;
const CASHIER = 2;
const T0 = Date.UTC(2026, 8, 30, 3, 0, 0);
const MINUTE = 60_000;
const ZONE = 'Asia/Jakarta';
const FIXTURES = path.resolve(__dirname, '../fixtures/csv');

const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));
/** CRLF records from lines. */
const csv = (...lines: string[]) => lines.join('\r\n') + '\r\n';

function local(dateTime: string): Instant {
  const resolved = resolveLocalDateTime(dateTime, ZONE);
  if (resolved.kind !== 'ok') throw new Error(`not resolvable: ${dateTime}`);
  return resolved.instant;
}

let h: Harness;
let dialogs: FakeDialogs;
let nowMs = T0;
let csvDir: string;
let seq = 0;
let bengkel: string;
let shopee: string;
let pcs: string;

beforeEach(async () => {
  nowMs = T0;
  dialogs = new FakeDialogs();
  h = createHarness({ clock: { now: () => toInstant(nowMs) }, dialogs });
  csvDir = path.join(h.dir, 'csv');
  mkdirSync(csvDir);
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(
      C.auth.login,
      { username: 'admin', password: ADMIN_PASSWORD },
      ADMIN,
    ),
  );
  value(
    await h.call(C.cashiers.create, {
      username: 'siti',
      displayName: 'Siti',
      password: 'siti-password-1',
      role: 'CASHIER',
    }),
  );
  value(
    await h.call(
      C.auth.login,
      { username: 'siti', password: 'siti-password-1' },
      CASHIER,
    ),
  );
  const channels = value(
    await h.call<ReferenceDto[]>(C.references.list, { entity: 'channel' }),
  );
  bengkel = channels.find((c) => c.code === 'BENGKEL')!.id;
  shopee = channels.find((c) => c.code === 'SHOPEE')!.id;
  const units = value(
    await h.call<ReferenceDto[]>(C.references.list, { entity: 'unit' }),
  );
  pcs = units.find((u) => u.code === 'PCS')!.id;
});
afterEach(() => h.close());

// ---- helpers ----

const rows = (sql: string, ...params: unknown[]) =>
  h.db.prepare(sql).all(...params) as Record<string, unknown>[];
const count = (sql: string, ...params: unknown[]) =>
  Number((h.db.prepare(sql).get(...params) as { n: bigint }).n);

/** Every catalog-related table, in full. */
function catalogDump() {
  return {
    items: rows('SELECT * FROM catalog_items ORDER BY id'),
    barcodes: rows('SELECT * FROM catalog_item_barcodes ORDER BY id'),
    prices: rows('SELECT * FROM catalog_item_prices ORDER BY id'),
    ledger: rows('SELECT * FROM stock_ledger_entries ORDER BY id'),
    units: rows('SELECT * FROM units ORDER BY id'),
    channels: rows('SELECT * FROM channels ORDER BY id'),
    audit: rows(
      `SELECT * FROM audit_log WHERE action LIKE 'CATALOG%' OR action LIKE 'PRICE%'
         OR action LIKE 'STOCK%' ORDER BY id`,
    ),
    receipts: rows('SELECT * FROM command_receipts ORDER BY request_id'),
  };
}

function writeCsv(content: string | Buffer): string {
  seq += 1;
  const file = path.join(csvDir, `import-${seq}.csv`);
  writeFileSync(file, content);
  return file;
}

async function previewResult(content: string | Buffer, windowId = ADMIN) {
  dialogs.csvOpenAnswers.push(writeCsv(content));
  return h.call<ImportPreviewDto>(
    C.catalogTransfer.previewImport,
    undefined,
    windowId,
  );
}

async function preview(content: string | Buffer): Promise<ImportReadyDto> {
  const result = value(await previewResult(content));
  if (result.outcome !== 'READY') throw new Error('expected a preview');
  return result;
}

const commit = (token: string, windowId = ADMIN) =>
  h.call<ImportSummaryDto>(C.catalogTransfer.commitImport, { token }, windowId);

async function importCsv(content: string | Buffer) {
  const p = await preview(content);
  expect(p.errors).toEqual([]);
  expect(p.canCommit).toBe(true);
  return value(await commit(p.token));
}

const codes = (issues: ImportIssueDto[]) => issues.map((i) => i.error.code);
const issue = (issues: ImportIssueDto[], code: string) =>
  issues.find((i) => i.error.code === code);

async function exportCatalog(windowId = ADMIN) {
  const file = path.join(csvDir, `export-${++seq}.csv`);
  dialogs.csvAnswers.push(file);
  const outcome = value(
    await h.call<CatalogFileOutcomeDto>(
      C.catalogTransfer.exportCatalog,
      undefined,
      windowId,
    ),
  );
  return { outcome, file };
}

async function newItem(overrides: Record<string, unknown> = {}) {
  return value(
    await h.call<CatalogItemDto>(C.catalog.save, {
      type: 'STOCK_ITEM',
      title: 'Oli MPX2',
      unitId: pcs,
      ...overrides,
    }),
  );
}

async function addPrice(
  itemId: string,
  price: string,
  start: Instant,
  channelId = bengkel,
) {
  const p = value(
    await h.call<PricePreviewDto>(C.catalog.previewPriceChange, {
      catalogItemId: itemId,
      channelId,
      effectiveStartAt: start,
      price,
    }),
  );
  return value(
    await h.call<AppliedPriceChangeDto>(C.catalog.applyPriceChange, {
      token: p.token,
    }),
  ).point;
}

async function saveBarcodes(
  itemId: string,
  barcodes: { barcode: string; isActive: boolean }[],
) {
  value(
    await h.call(C.catalog.saveBarcodes, { catalogItemId: itemId, barcodes }),
  );
}

const itemBySku = (sku: string) =>
  h.db.prepare('SELECT * FROM catalog_items WHERE sku = ?').get(sku) as
    | Record<string, unknown>
    | undefined;
const barcodesOf = (itemId: string) =>
  rows(
    'SELECT barcode, is_active FROM catalog_item_barcodes WHERE catalog_item_id = ? ORDER BY barcode',
    itemId,
  );
const pricesOf = (itemId: string, channelId = bengkel) =>
  rows(
    `SELECT id, price, effective_start_at, superseded_at FROM catalog_item_prices
     WHERE catalog_item_id = ? AND channel_id = ? ORDER BY effective_start_at`,
    itemId,
    channelId,
  );
const resolve = (itemId: string, at: Instant, channelId = bengkel) =>
  h.services.catalog.resolvePrice(itemId, channelId, at);
const safetyBackups = () =>
  count(
    `SELECT COUNT(*) AS n FROM backup_runs WHERE kind = 'SAFETY' AND outcome = 'SUCCEEDED'`,
  );

const HEAD =
  'sku,title,type,unit,barcode,price_bengkel,opening_stock,is_active';

// ---- required assertions ----

describe('required assertions', () => {
  test('repeated imports never duplicate the opening stock', async () => {
    const first = await importCsv(fixture('new-items.csv'));
    expect(first.creates).toBe(3);
    expect(first.openingBalances).toBe(2);
    nowMs += 60 * MINUTE;

    const second = await preview(fixture('new-items.csv'));
    // Existing SKUs: opening_stock is ignored with a warning (spec 39).
    expect(
      second.warnings.filter((w) => w.error.code === 'OPENING_STOCK_IGNORED'),
    ).toHaveLength(2);
    expect(second.summary.openingBalances).toBe(0);
    const summary = value(await commit(second.token));
    expect(summary.openingBalances).toBe(0);

    const item = itemBySku('OLI-MPX2-1L')!;
    const openingBalanceCountAfterSecondImport = count(
      `SELECT COUNT(*) AS n FROM stock_ledger_entries
       WHERE catalog_item_id = ? AND movement_type = 'OPENING_BALANCE'`,
      item.id,
    );
    expect(openingBalanceCountAfterSecondImport).toBe(1);
    expect(
      count(
        `SELECT COALESCE(SUM(quantity_delta), 0) AS n FROM stock_ledger_entries WHERE catalog_item_id = ?`,
        item.id,
      ),
    ).toBe(12);
  });

  test('a failure injected mid-transaction rolls everything back', async () => {
    const existing = await newItem({ sku: 'OLI-MPX2-1L', title: 'Oli lama' });
    await addPrice(existing.id, '60000', local('2026-09-01T08:00'));
    const databaseBeforeImport = catalogDump();

    const p = await preview(fixture('new-items.csv'));
    expect(p.canCommit).toBe(true);
    expect(p.summary).toMatchObject({ creates: 2, updates: 1 });
    // Fails at the very end: every item, barcode, price point and opening
    // balance has been written inside the transaction by then.
    h.db.exec(`CREATE TEMP TRIGGER inject_failure BEFORE INSERT ON audit_log
      WHEN NEW.action = 'CATALOG_IMPORTED'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    const result = await commit(p.token);
    expect(result.ok).toBe(false);
    h.db.exec('DROP TRIGGER temp.inject_failure');

    const databaseAfterFailedImport = catalogDump();
    expect(databaseAfterFailedImport).toEqual(databaseBeforeImport);
    // The safety backup was taken before the transaction.
    expect(safetyBackups()).toBe(1);
  });

  test('an unknown unit code is a row error', async () => {
    const p = await preview(fixture('unknown-unit.csv'));
    const unknownUnit = issue(p.errors, 'UNKNOWN_UNIT')!;
    expect(unknownUnit.error.code).toBe('UNKNOWN_UNIT');
    expect(unknownUnit).toMatchObject({
      row: 3,
      column: 'unit',
      sku: 'BAN-02',
    });
    expect(unknownUnit.error.params).toMatchObject({ value: 'LUSIN' });
    expect(p.canCommit).toBe(false);
    expect(failure(await commit(p.token)).code).toBe('IMPORT_HAS_ERRORS');
    expect(itemBySku('BAN-01')).toBeUndefined();
    expect(safetyBackups()).toBe(0);
  });

  test('a price changed after the preview makes it stale', async () => {
    const item = await newItem({ sku: 'OLI-01' });
    await addPrice(item.id, '50000', local('2026-09-01T08:00'));
    const p = await preview(csv(HEAD, 'OLI-01,,,,,55000,,'));
    expect(p.summary.priceChanges).toBe(1);

    nowMs += MINUTE;
    await addPrice(item.id, '52000', local('2026-09-30T10:00'));
    const before = catalogDump();
    const stalePreview = await commit(p.token);
    if (stalePreview.ok) throw new Error('expected a stale preview');
    expect(stalePreview.error.code).toBe('IMPORT_PREVIEW_STALE');
    expect(catalogDump()).toEqual(before);
    // Rejected before the backup.
    expect(safetyBackups()).toBe(0);
  });
});

// ---- the strict reader ----

describe('reader', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const read = (text: string) => {
    const result = readCsv(bytes(text));
    if (!result.ok) throw new Error(`read failed: ${result.code}`);
    return result.records;
  };

  test('BOM, CRLF or LF, quoted commas, quotes and newlines', () => {
    expect(read('﻿a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(read('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(read('a,b\n"x, ""y""","line 1\r\nline 2"\n')).toEqual([
      ['a', 'b'],
      ['x, "y"', 'line 1\r\nline 2'],
    ]);
  });

  test('blank trailing lines are ignored; values stay text', () => {
    expect(read('a,b\r\n007,0089\r\n\r\n\n\r\n')).toEqual([
      ['a', 'b'],
      ['007', '0089'],
    ]);
  });

  test('malformed quoting is rejected with the record number', () => {
    expect(readCsv(bytes('a,b\n1,"2\n'))).toMatchObject({
      ok: false,
      code: 'MALFORMED_CSV',
      row: 2,
    });
    expect(readCsv(bytes('a,b\n1,x"y\n'))).toMatchObject({
      ok: false,
      code: 'MALFORMED_CSV',
      row: 2,
    });
    expect(readCsv(bytes('a,b\n1,"2"x\n'))).toMatchObject({
      ok: false,
      code: 'MALFORMED_CSV',
      row: 2,
    });
  });

  test('invalid UTF-8 is INVALID_ENCODING', () => {
    expect(readCsv(new Uint8Array([0x61, 0x0a, 0xff, 0x0a]))).toMatchObject({
      ok: false,
      code: 'INVALID_ENCODING',
    });
  });

  test('exactly one formula-guard apostrophe is removed', () => {
    expect(unescapeFormulaGuard("'=SUM(A1)")).toBe('=SUM(A1)');
    expect(unescapeFormulaGuard("'-250000")).toBe('-250000');
    expect(unescapeFormulaGuard("'@x")).toBe('@x');
    expect(unescapeFormulaGuard("'\tx")).toBe('\tx');
    expect(unescapeFormulaGuard("''=x")).toBe("''=x");
    expect(unescapeFormulaGuard("'abc")).toBe("'abc");
    expect(unescapeFormulaGuard("'")).toBe("'");
  });
});

// ---- import: parsing and validation ----

describe('import validation', () => {
  test('cancelling the open dialog does nothing', async () => {
    dialogs.csvOpenAnswers.push(null);
    const result = value(
      await h.call<ImportPreviewDto>(C.catalogTransfer.previewImport),
    );
    expect(result).toEqual({ outcome: 'CANCELLED' });
    expect(dialogs.csvOpenCalls).toBe(1);
  });

  test('quoted commas, quotes and newlines; leading zeros; BOM + CRLF', async () => {
    const p = await preview(fixture('new-items.csv'));
    expect(p.fileName).toMatch(/^import-\d+\.csv$/);
    expect(p.summary).toEqual({
      creates: 3,
      updates: 0,
      unchanged: 0,
      priceChanges: 5,
      openingBalances: 2,
      barcodeChanges: 3,
    });
    expect(p.rows.map((r) => [r.row, r.sku, r.action])).toEqual([
      [2, 'OLI-MPX2-1L', 'CREATE'],
      [3, '007-KAMPAS', 'CREATE'],
      [4, 'JASA-GANTI-OLI', 'CREATE'],
    ]);
    value(await commit(p.token));

    const kampas = itemBySku('007-KAMPAS')!;
    expect(kampas.title).toBe('Kampas Rem, Depan "Honda"');
    expect(kampas.description).toBe('Baris satu\nBaris dua');
    expect(barcodesOf(kampas.id as string)).toEqual([
      { barcode: '0089686010947', is_active: 1n },
      { barcode: '0089686010954', is_active: 1n },
    ]);
    const oli = itemBySku('OLI-MPX2-1L')!;
    expect(oli).toMatchObject({
      type: 'STOCK_ITEM',
      track_inventory: 1n,
      is_active: 1n,
      description: 'Oli mesin 4T',
    });
    const service = itemBySku('JASA-GANTI-OLI')!;
    expect(service).toMatchObject({ type: 'SERVICE', track_inventory: 0n });
    expect(service.description).toBeNull();
    // A zero opening stock is recorded as a zero OPENING_BALANCE.
    expect(
      rows(
        `SELECT quantity_delta, reference_type FROM stock_ledger_entries WHERE catalog_item_id = ?`,
        kampas.id,
      ),
    ).toEqual([{ quantity_delta: 0n, reference_type: 'CATALOG_IMPORT' }]);
    expect(resolve(oli.id as string, toInstant(nowMs))?.price).toBe('65000');
    expect(resolve(oli.id as string, toInstant(nowMs), shopee)?.price).toBe(
      '70000',
    );
    expect(pricesOf(oli.id as string)[0]!.effective_start_at).toBe(
      toInstant(nowMs),
    );
  });

  test('numeric-looking SKUs and barcodes are never coerced', async () => {
    await importCsv(
      csv(HEAD, '00123,Baut 00123,STOCK_ITEM,PCS,000456,1000,,true'),
    );
    const item = itemBySku('00123')!;
    expect(item.sku).toBe('00123');
    expect(barcodesOf(item.id as string)).toEqual([
      { barcode: '000456', is_active: 1n },
    ]);
  });

  test('missing SKU: a blank cell and a missing column', async () => {
    const blank = await preview(
      csv(HEAD, ',Tanpa SKU,STOCK_ITEM,PCS,,1000,,true'),
    );
    expect(issue(blank.errors, 'SKU_REQUIRED')).toMatchObject({
      row: 2,
      column: 'sku',
    });
    expect(blank.canCommit).toBe(false);

    const noColumn = await preview(csv('title,type,unit', 'A,SERVICE,PCS'));
    expect(issue(noColumn.errors, 'MISSING_COLUMN')).toMatchObject({
      row: 1,
      column: 'sku',
    });
    expect(noColumn.canCommit).toBe(false);
  });

  test('row width mismatch, including the spec 38 short example row', async () => {
    const p = await preview(fixture('spec-38-example.csv'));
    const mismatch = issue(p.errors, 'ROW_WIDTH_MISMATCH')!;
    expect(mismatch).toMatchObject({ row: 3, column: null });
    expect(mismatch.error.params).toEqual({ expected: '10', actual: '9' });
    expect(p.canCommit).toBe(false);

    const wide = await preview(
      csv(HEAD, 'A-1,Satu,STOCK_ITEM,PCS,,1000,,true,extra'),
    );
    expect(issue(wide.errors, 'ROW_WIDTH_MISMATCH')?.row).toBe(2);
  });

  test('invalid UTF-8 blocks the import', async () => {
    const p = await preview(fixture('invalid-utf8.csv'));
    expect(codes(p.errors)).toEqual(['INVALID_ENCODING']);
    expect(p.canCommit).toBe(false);
    expect(p.rows).toEqual([]);
    expect(failure(await commit(p.token)).code).toBe('IMPORT_HAS_ERRORS');
  });

  test('a file over the size limit is rejected', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 'a');
    const p = await preview(big);
    expect(codes(p.errors)).toEqual(['FILE_TOO_LARGE']);
    expect(p.canCommit).toBe(false);
  });

  test('header errors: unknown, repeated, unknown channel, barcode gaps', async () => {
    const p = await preview(
      csv(
        'sku,title,colour,Title,price_grab,barcode,barcode_3',
        'A-1,Satu,merah,Dua,1000,111,333',
      ),
    );
    expect(codes(p.errors).sort()).toEqual(
      [
        'BARCODE_COLUMN_GAP',
        'DUPLICATE_COLUMN',
        'UNKNOWN_CHANNEL',
        'UNKNOWN_COLUMN',
      ].sort(),
    );
    expect(issue(p.errors, 'UNKNOWN_COLUMN')).toMatchObject({
      row: 1,
      column: 'colour',
    });
    expect(issue(p.errors, 'UNKNOWN_CHANNEL')?.column).toBe('price_grab');
    expect(issue(p.errors, 'DUPLICATE_COLUMN')?.column).toBe('title');
    expect(issue(p.errors, 'BARCODE_COLUMN_GAP')?.column).toBe('barcode_3');
    expect(p.canCommit).toBe(false);
  });

  test('field errors are listed per row and field', async () => {
    const p = await preview(
      csv(
        HEAD,
        'A-1,Satu,BARANG,PCS,,1000,,true',
        'A-2,Dua,STOCK_ITEM,PCS,,65.000,,true',
        'A-3,Tiga,STOCK_ITEM,PCS,,-5,,true',
        'A-4,Empat,STOCK_ITEM,PCS,,1000,1.5,true',
        'A-5,Lima,STOCK_ITEM,PCS,,1000,,ya',
        'A-6,,STOCK_ITEM,PCS,,1000,,true',
        'A-7,Tujuh,SERVICE,SERVICE,,1000,3,true',
        'A-8,Delapan,STOCK_ITEM,PCS,,1000,-2,true',
      ),
    );
    expect(p.errors.map((e) => [e.row, e.column, e.error.code])).toEqual([
      [2, 'type', 'INVALID_TYPE'],
      [3, 'price_bengkel', 'INVALID_PRICE'],
      [4, 'price_bengkel', 'INVALID_PRICE'],
      [5, 'opening_stock', 'INVALID_OPENING_STOCK'],
      [6, 'is_active', 'INVALID_BOOLEAN'],
      [7, 'title', 'TITLE_REQUIRED'],
      [8, 'opening_stock', 'SERVICE_WITH_OPENING_STOCK'],
      [9, 'opening_stock', 'INVALID_OPENING_STOCK'],
    ]);
    expect(p.rows.every((r) => r.action === 'INVALID')).toBe(true);
    expect(p.canCommit).toBe(false);
  });

  test('duplicate SKUs (case-insensitive) and barcodes in the file', async () => {
    const p = await preview(
      csv(
        HEAD,
        'ABC-1,Satu,STOCK_ITEM,PCS,111,1000,,true',
        'abc-1,Dua,STOCK_ITEM,PCS,222,1000,,true',
        'XYZ-1,Tiga,STOCK_ITEM,PCS,111,1000,,true',
      ),
    );
    expect(issue(p.errors, 'DUPLICATE_SKU_IN_FILE')).toMatchObject({
      row: 3,
      column: 'sku',
    });
    expect(
      issue(p.errors, 'DUPLICATE_SKU_IN_FILE')!.error.params,
    ).toMatchObject({ firstRow: '2' });
    expect(issue(p.errors, 'DUPLICATE_BARCODE_IN_FILE')).toMatchObject({
      row: 4,
      column: 'barcode',
    });
    expect(p.canCommit).toBe(false);
  });

  test('BARCODE_OWNED_BY_OTHER_ITEM', async () => {
    const other = await newItem({ sku: 'LAIN-1', title: 'Barang lain' });
    await saveBarcodes(other.id, [{ barcode: '8990001', isActive: false }]);
    const p = await preview(
      csv(HEAD, 'BARU-1,Barang baru,STOCK_ITEM,PCS,8990001,1000,,true'),
    );
    const owned = issue(p.errors, 'BARCODE_OWNED_BY_OTHER_ITEM')!;
    expect(owned).toMatchObject({ row: 2, column: 'barcode' });
    expect(owned.error.params).toMatchObject({
      barcode: '8990001',
      ownerSku: 'LAIN-1',
    });
    expect(p.canCommit).toBe(false);
  });

  test('a type change is refused once the item has stock movements', async () => {
    const item = await newItem({ sku: 'OLI-01' });
    value(
      await h.call(C.inventory.openBalance, {
        requestId: crypto.randomUUID(),
        catalogItemId: item.id,
        quantity: 5,
      }),
    );
    const untouched = await newItem({ sku: 'OLI-02', title: 'Tanpa stok' });
    const p = await preview(
      csv(
        'sku,type,unit',
        'OLI-01,SERVICE,SERVICE',
        `${untouched.sku},SERVICE,SERVICE`,
      ),
    );
    expect(p.errors.map((e) => [e.row, e.column, e.error.code])).toEqual([
      [2, 'type', 'TRACKING_LOCKED_BY_LEDGER'],
    ]);
    // Without ledger activity the type change is allowed.
    expect(p.rows[1]).toMatchObject({
      action: 'UPDATE',
      changedFields: ['type', 'unit', 'trackInventory'],
    });
  });

  test('warnings: inactive channel (price applies), current_stock ignored', async () => {
    const shopeeRef = value(
      await h.call<ReferenceDto[]>(C.references.list, { entity: 'channel' }),
    ).find((c) => c.id === shopee)!;
    value(
      await h.call(C.references.deactivate, {
        entity: 'channel',
        id: shopeeRef.id,
      }),
    );
    const p = await preview(
      csv(
        'sku,title,type,unit,price_shopee,current_stock',
        'NEW-1,Baru,STOCK_ITEM,PCS,70000,99',
      ),
    );
    expect(p.errors).toEqual([]);
    expect(codes(p.warnings).sort()).toEqual([
      'CURRENT_STOCK_IGNORED',
      'INACTIVE_CHANNEL',
    ]);
    expect(issue(p.warnings, 'INACTIVE_CHANNEL')?.column).toBe('price_shopee');
    value(await commit(p.token));
    const item = itemBySku('NEW-1')!;
    expect(resolve(item.id as string, toInstant(nowMs), shopee)?.price).toBe(
      '70000',
    );
    // current_stock never becomes an opening balance.
    expect(
      count(
        'SELECT COUNT(*) AS n FROM stock_ledger_entries WHERE catalog_item_id = ?',
        item.id,
      ),
    ).toBe(0);
  });

  test('CASHIER is forbidden everywhere and no dialog opens', async () => {
    dialogs.csvOpenAnswers.push(writeCsv(fixture('new-items.csv')));
    expect(
      failure(await h.call(C.catalogTransfer.previewImport, undefined, CASHIER))
        .code,
    ).toBe('FORBIDDEN');
    expect(
      failure(
        await h.call(
          C.catalogTransfer.commitImport,
          { token: crypto.randomUUID() },
          CASHIER,
        ),
      ).code,
    ).toBe('FORBIDDEN');
    expect(
      failure(await h.call(C.catalogTransfer.exportCatalog, undefined, CASHIER))
        .code,
    ).toBe('FORBIDDEN');
    expect(
      failure(
        await h.call(C.catalogTransfer.downloadTemplate, undefined, CASHIER),
      ).code,
    ).toBe('FORBIDDEN');
    expect(
      failure(await h.call(C.catalogTransfer.previewImport, undefined, 99))
        .code,
    ).toBe('UNAUTHENTICATED');
    expect(dialogs.csvOpenCalls).toBe(0);
    expect(dialogs.csvCalls).toEqual([]);
  });
});

// ---- import: semantics ----

describe('import semantics', () => {
  test('existing SKU: fields update, barcodes are added or activated, never removed', async () => {
    const item = await newItem({
      sku: 'KMP-1',
      title: 'Kampas lama',
      description: 'catatan',
    });
    await saveBarcodes(item.id, [
      { barcode: '111', isActive: true },
      { barcode: '222', isActive: false },
      { barcode: '999', isActive: true },
    ]);
    const p = await preview(
      csv(
        'sku,title,unit,barcode,barcode_2,barcode_3,is_active',
        'kmp-1,Kampas baru,SET,111,222,333,false',
      ),
    );
    expect(p.rows[0]).toMatchObject({
      action: 'UPDATE',
      changedFields: ['title', 'unit', 'isActive'],
      barcodesAdded: ['333'],
      barcodesActivated: ['222'],
    });
    expect(p.summary).toMatchObject({ updates: 1, barcodeChanges: 2 });
    value(await commit(p.token));
    const after = itemBySku('KMP-1')!;
    expect(after).toMatchObject({
      id: item.id,
      sku: 'KMP-1',
      title: 'Kampas baru',
      description: 'catatan',
      is_active: 0n,
    });
    expect(barcodesOf(item.id)).toEqual([
      { barcode: '111', is_active: 1n },
      { barcode: '222', is_active: 1n },
      { barcode: '333', is_active: 1n },
      { barcode: '999', is_active: 1n },
    ]);
  });

  test('same-day price changes create two points at their import instants', async () => {
    const first = local('2026-09-30T10:00');
    nowMs = Date.parse(first);
    await importCsv(csv(HEAD, 'OLI-01,Oli,STOCK_ITEM,PCS,,65000,,true'));
    const second = local('2026-09-30T14:30');
    nowMs = Date.parse(second);
    const summary = await importCsv(csv(HEAD, 'OLI-01,,,,,70000,,'));
    expect(summary.priceChanges).toBe(1);
    expect(summary.importedAt).toBe(second);

    const item = itemBySku('OLI-01')!;
    expect(
      pricesOf(item.id as string).map((p) => [
        p.effective_start_at,
        p.price,
        p.superseded_at,
      ]),
    ).toEqual([
      [first, 65000n, null],
      [second, 70000n, null],
    ]);
    expect(resolve(item.id as string, local('2026-09-30T12:00'))?.price).toBe(
      '65000',
    );
    expect(resolve(item.id as string, local('2026-09-30T15:00'))?.price).toBe(
      '70000',
    );
    // Start-only: no end column anywhere.
    const columns = rows('PRAGMA table_info(catalog_item_prices)').map(
      (c) => c.name as string,
    );
    expect(columns.filter((c) => /end/i.test(c))).toEqual([]);
  });

  test('a future-scheduled point stays untouched', async () => {
    const item = await newItem({ sku: 'OLI-01' });
    await addPrice(item.id, '50000', local('2026-09-01T08:00'));
    const future = await addPrice(item.id, '60000', local('2026-10-05T08:00'));
    const futureBefore = rows(
      'SELECT * FROM catalog_item_prices WHERE id = ?',
      future.id,
    );

    const summary = await importCsv(csv(HEAD, 'OLI-01,,,,,55000,,'));
    expect(summary.priceChanges).toBe(1);
    expect(
      rows('SELECT * FROM catalog_item_prices WHERE id = ?', future.id),
    ).toEqual(futureBefore);
    expect(resolve(item.id, toInstant(nowMs))?.price).toBe('55000');
    expect(resolve(item.id, local('2026-10-05T09:00'))?.price).toBe('60000');
    expect(pricesOf(item.id)).toHaveLength(3);
  });

  test('an unchanged price creates no point (warning only)', async () => {
    const item = await newItem({ sku: 'OLI-01' });
    await addPrice(item.id, '50000', local('2026-09-01T08:00'));
    const p = await preview(csv(HEAD, 'OLI-01,,,,,50000,,'));
    expect(p.summary.priceChanges).toBe(0);
    expect(issue(p.warnings, 'PRICE_UNCHANGED')).toMatchObject({
      row: 2,
      column: 'price_bengkel',
    });
    expect(p.rows[0]!.action).toBe('UNCHANGED');
    value(await commit(p.token));
    expect(pricesOf(item.id)).toHaveLength(1);
  });

  test('empty cells leave existing values and prices unchanged', async () => {
    const item = await newItem({ sku: 'OLI-01', description: 'tetap' });
    await addPrice(item.id, '50000', local('2026-09-01T08:00'));
    const before = catalogDump();
    const p = await preview(
      csv(
        'sku,title,type,unit,barcode,price_bengkel,is_active,description',
        'OLI-01,,,,,,,',
      ),
    );
    expect(p.rows[0]!.action).toBe('UNCHANGED');
    expect(p.summary).toEqual({
      creates: 0,
      updates: 0,
      unchanged: 1,
      priceChanges: 0,
      openingBalances: 0,
      barcodeChanges: 0,
    });
    value(await commit(p.token));
    const after = catalogDump();
    expect({ ...after, audit: [], receipts: [] }).toEqual({
      ...before,
      audit: [],
      receipts: [],
    });
  });

  test('the commit is audited once with counts and the backup file name', async () => {
    const summary = await importCsv(fixture('new-items.csv'));
    const audit = rows(
      `SELECT cashier_id, action, metadata FROM audit_log WHERE action = 'CATALOG_IMPORTED'`,
    );
    expect(audit).toHaveLength(1);
    const metadata = JSON.parse(audit[0]!.metadata as string);
    expect(metadata).toMatchObject({
      creates: 3,
      updates: 0,
      priceChanges: 5,
      openingBalances: 2,
      barcodeChanges: 3,
      backupFileName: summary.backupFileName,
    });
    expect(summary.backupFileName).toMatch(/^bengkelin-safety-\d{8}-\d{6}/);
    expect(existsSync(path.join(h.backupsDir, summary.backupFileName))).toBe(
      true,
    );
    // Individual item/price audits are not written by the import.
    expect(
      count(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('CATALOG_ITEM_CREATED', 'PRICE_POINT_ADDED')`,
      ),
    ).toBe(0);
  });
});

// ---- commit: tokens, backup, idempotency, rollback ----

describe('commit', () => {
  test('a retried commit returns the stored summary with one effect', async () => {
    const p = await preview(fixture('new-items.csv'));
    const first = value(await commit(p.token));
    const dump = catalogDump();
    const retry = value(await commit(p.token));
    expect(retry).toEqual(first);
    expect(catalogDump()).toEqual(dump);
    expect(safetyBackups()).toBe(1);
    expect(
      count(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'CATALOG_IMPORTED'`,
      ),
    ).toBe(1);
  });

  test('concurrent commits of one token share one run', async () => {
    const p = await preview(fixture('new-items.csv'));
    const [a, b] = await Promise.all([commit(p.token), commit(p.token)]);
    expect(value(a)).toEqual(value(b));
    expect(safetyBackups()).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM catalog_items')).toBe(3);
  });

  test('unknown and expired tokens', async () => {
    expect(failure(await commit(crypto.randomUUID())).code).toBe(
      'IMPORT_PREVIEW_EXPIRED',
    );
    const p = await preview(fixture('new-items.csv'));
    nowMs += 31 * MINUTE;
    expect(failure(await commit(p.token)).code).toBe('IMPORT_PREVIEW_EXPIRED');
    expect(count('SELECT COUNT(*) AS n FROM catalog_items')).toBe(0);
    expect(safetyBackups()).toBe(0);
  });

  test('a change during the backup is caught inside the transaction', async () => {
    const item = await newItem({ sku: 'OLI-01' });
    await addPrice(item.id, '50000', local('2026-09-01T08:00'));
    const p = await preview(csv(HEAD, 'OLI-01,,,,,55000,,'));
    const before = catalogDump();
    // The pre-checks run synchronously; the backup is then awaited.
    const pending = commit(p.token);
    h.db
      .prepare('UPDATE catalog_items SET title = ? WHERE id = ?')
      .run('Diubah saat backup', item.id);
    const result = await pending;
    expect(failure(result).code).toBe('IMPORT_PREVIEW_STALE');
    expect(safetyBackups()).toBe(1);
    expect(catalogDump().prices).toEqual(before.prices);
  });

  test('a scheduled price that starts between preview and commit makes it stale', async () => {
    const item = await newItem({ sku: 'OLI-01' });
    await addPrice(item.id, '50000', local('2026-09-01T08:00'));
    await addPrice(item.id, '55000', toInstant(T0 + 5 * MINUTE));
    const p = await preview(csv(HEAD, 'OLI-01,,,,,55000,,'));
    expect(p.summary.priceChanges).toBe(1);
    nowMs = T0 + 6 * MINUTE;
    expect(failure(await commit(p.token)).code).toBe('IMPORT_PREVIEW_STALE');
    expect(pricesOf(item.id)).toHaveLength(2);
  });

  test('a backup failure aborts the import and changes nothing', async () => {
    const existing = await newItem({ sku: 'OLI-MPX2-1L' });
    const p = await preview(fixture('new-items.csv'));
    h.db
      .prepare('UPDATE settings SET backup_directory = ? WHERE id = 1')
      .run(path.join(h.dir, 'unplugged-usb'));
    const before = catalogDump();
    const error = failure(await commit(p.token));
    expect(error.code).toBe('IMPORT_BACKUP_FAILED');
    expect(error.params).toEqual({
      backupCode: 'BACKUP_DESTINATION_UNAVAILABLE',
    });
    expect(catalogDump()).toEqual(before);

    // Ordinary work is not blocked.
    value(
      await h.call(C.catalog.save, {
        id: existing.id,
        type: 'STOCK_ITEM',
        title: 'Masih bisa diubah',
        sku: 'OLI-MPX2-1L',
        unitId: pcs,
      }),
    );
    // The preview survives a failed backup; with the folder back it commits.
    h.db
      .prepare('UPDATE settings SET backup_directory = NULL WHERE id = 1')
      .run();
    const stale = failure(await commit(p.token));
    expect(stale.code).toBe('IMPORT_PREVIEW_STALE');
    const again = await preview(fixture('new-items.csv'));
    const summary = value(await commit(again.token));
    expect(summary).toMatchObject({ creates: 2, updates: 1 });
  });

  test('a failure between rows rolls back the earlier rows', async () => {
    const before = catalogDump();
    const p = await preview(
      csv(
        HEAD,
        'A-1,Satu,STOCK_ITEM,PCS,111,1000,5,true',
        'A-2,Dua,STOCK_ITEM,PCS,222,2000,5,true',
        'A-3,Tiga,STOCK_ITEM,PCS,333,777,5,true',
      ),
    );
    h.db
      .exec(`CREATE TEMP TRIGGER inject_price_failure BEFORE INSERT ON catalog_item_prices
      WHEN NEW.price = 777
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    expect((await commit(p.token)).ok).toBe(false);
    h.db.exec('DROP TRIGGER temp.inject_price_failure');
    expect(catalogDump()).toEqual(before);
    // The token was consumed: a retry does not re-run the import.
    expect(failure(await commit(p.token)).code).toBe('IMPORT_PREVIEW_EXPIRED');
  });
});

// ---- export and template ----

describe('export and template', () => {
  test('cancelling the save dialogs writes nothing', async () => {
    dialogs.csvAnswers.push(null, null);
    expect(value(await h.call(C.catalogTransfer.exportCatalog))).toEqual({
      outcome: 'CANCELLED',
    });
    expect(value(await h.call(C.catalogTransfer.downloadTemplate))).toEqual({
      outcome: 'CANCELLED',
    });
    expect(dialogs.csvCalls).toEqual([
      expect.stringMatching(/^katalog-\d{8}\.csv$/),
      'template-katalog.csv',
    ]);
    expect(
      count(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'CATALOG_EXPORTED'`,
      ),
    ).toBe(0);
  });

  test('the export: current prices, barcodes, current_stock, blank opening_stock', async () => {
    const oli = await newItem({ sku: 'OLI-01', title: 'Oli' });
    await addPrice(oli.id, '50000', local('2026-09-01T08:00'));
    await addPrice(oli.id, '99000', local('2026-12-01T08:00')); // future
    await addPrice(oli.id, '52000', local('2026-09-01T08:00'), shopee);
    await saveBarcodes(oli.id, [
      { barcode: '0011', isActive: true },
      { barcode: '0022', isActive: true },
      { barcode: '0033', isActive: false },
    ]);
    value(
      await h.call(C.inventory.openBalance, {
        requestId: crypto.randomUUID(),
        catalogItemId: oli.id,
        quantity: 7,
      }),
    );
    const jasa = await newItem({
      sku: 'JASA-01',
      title: 'Jasa',
      type: 'SERVICE',
    });
    await addPrice(jasa.id, '20000', local('2026-09-01T08:00'));
    await newItem({ title: 'Tanpa SKU' });

    const { outcome, file } = await exportCatalog();
    expect(outcome).toEqual({
      outcome: 'SAVED',
      fileName: path.basename(file),
      itemCount: 3,
      skuMissingCount: 1,
    });
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('﻿')).toBe(true);
    const table = parseCsv(text);
    expect(table[0]).toEqual([
      'sku',
      'title',
      'type',
      'unit',
      'barcode',
      'barcode_2',
      'price_bengkel',
      'price_shopee',
      'price_reseller',
      'opening_stock',
      'current_stock',
      'is_active',
      'description',
    ]);
    const bySku = new Map(table.slice(1).map((r) => [r[0], r]));
    expect(bySku.get('OLI-01')).toEqual([
      'OLI-01',
      'Oli',
      'STOCK_ITEM',
      'PCS',
      '0011',
      '0022',
      '50000',
      '52000',
      '',
      '',
      '7',
      'true',
      '',
    ]);
    expect(bySku.get('JASA-01')).toEqual([
      'JASA-01',
      'Jasa',
      'SERVICE',
      'PCS',
      '',
      '',
      '20000',
      '',
      '',
      '',
      '',
      'true',
      '',
    ]);
    expect(bySku.get('')?.[1]).toBe('Tanpa SKU');
    expect(table.every((r) => r.length === 13)).toBe(true);
    const audit = rows(
      `SELECT metadata FROM audit_log WHERE action = 'CATALOG_EXPORTED'`,
    );
    expect(JSON.parse(audit[0]!.metadata as string)).toMatchObject({
      itemCount: 3,
      skuMissingCount: 1,
    });
  });

  test('formula-safe export round-trips', async () => {
    const title = "=cmd|' /C calc'!A0";
    const item = await newItem({
      sku: 'EVIL-1',
      title,
      description: '@SUM(1)',
    });
    await addPrice(item.id, '1000', local('2026-09-01T08:00'));
    const { file } = await exportCatalog();
    const table = parseCsv(readFileSync(file, 'utf8'));
    const row = table.find((r) => r[0] === 'EVIL-1')!;
    expect(row[1]).toBe(`'${title}`);
    expect(row[row.length - 1]).toBe("'@SUM(1)");
    for (const cell of table.flat()) {
      expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    }

    const p = await preview(readFileSync(file));
    expect(p.errors).toEqual([]);
    expect(p.rows[0]).toMatchObject({ action: 'UNCHANGED', title });
    value(await commit(p.token));
    expect(itemBySku('EVIL-1')).toMatchObject({
      title,
      description: '@SUM(1)',
    });
  });

  test('export -> import round trip makes zero catalog writes', async () => {
    const oli = await newItem({ sku: '007', title: 'Oli, "Super"\nBaris 2' });
    await addPrice(oli.id, '50000', local('2026-09-01T08:00'));
    await addPrice(oli.id, '90000', local('2026-12-01T08:00'));
    await saveBarcodes(oli.id, [
      { barcode: '0011', isActive: true },
      { barcode: '0022', isActive: true },
    ]);
    value(
      await h.call(C.inventory.openBalance, {
        requestId: crypto.randomUUID(),
        catalogItemId: oli.id,
        quantity: 3,
      }),
    );
    value(
      await h.call(C.inventory.setStock, {
        requestId: crypto.randomUUID(),
        catalogItemId: oli.id,
        targetQuantity: -2,
        reason: 'Stok opname',
      }),
    );
    const jasa = await newItem({
      sku: 'JASA-01',
      title: 'Jasa',
      type: 'SERVICE',
      isActive: false,
    });
    await addPrice(jasa.id, '20000', local('2026-09-01T08:00'), shopee);

    const { file } = await exportCatalog();
    const before = catalogDump();
    nowMs += 10 * MINUTE;
    const p = await preview(readFileSync(file));
    expect(p.errors).toEqual([]);
    expect(p.summary).toEqual({
      creates: 0,
      updates: 0,
      unchanged: 2,
      priceChanges: 0,
      openingBalances: 0,
      barcodeChanges: 0,
    });
    value(await commit(p.token));
    const after = catalogDump();
    expect({ ...after, audit: [], receipts: [] }).toEqual({
      ...before,
      audit: [],
      receipts: [],
    });
  });

  test('the template has the configured channels and two full-width examples', async () => {
    const file = path.join(csvDir, 'template.csv');
    dialogs.csvAnswers.push(file);
    const outcome = value(
      await h.call<CatalogFileOutcomeDto>(C.catalogTransfer.downloadTemplate),
    );
    expect(outcome).toMatchObject({
      outcome: 'SAVED',
      fileName: 'template.csv',
    });
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('﻿')).toBe(true);
    const table = parseCsv(text);
    expect(table[0]).toEqual([
      'sku',
      'title',
      'type',
      'unit',
      'barcode',
      'barcode_2',
      'price_bengkel',
      'price_shopee',
      'price_reseller',
      'opening_stock',
      'is_active',
      'description',
    ]);
    expect(table).toHaveLength(3);
    expect(table.every((r) => r.length === table[0]!.length)).toBe(true);
    expect(table[1]!.slice(0, 3)).toEqual([
      'OLI-MPX2-1L',
      'Oli MPX 2 1L',
      'STOCK_ITEM',
    ]);
    expect(table[2]!.slice(0, 4)).toEqual([
      'JASA-GANTI-OLI',
      'Jasa Ganti Oli',
      'SERVICE',
      'SERVICE',
    ]);
    // The template itself imports cleanly.
    const p = await preview(readFileSync(file));
    expect(p.errors).toEqual([]);
    expect(p.summary.creates).toBe(2);
  });
});
