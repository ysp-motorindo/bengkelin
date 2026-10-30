import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { openDatabase } from '@/main/database/connection';
import { createApplicationServices } from '@/main/compose';
import { CHANNELS } from '@/shared/channels';
import type {
  AppliedPriceChangeDto,
  CatalogItemDto,
  DraftLineDto,
  DraftOperation,
  DraftSummary,
  DraftView,
  PricePreviewDto,
  PriceRefreshPreviewDto,
  ReferenceDto,
  SaveCustomerResult,
  SaveVehicleResult,
  SearchAdHocReferencesResult,
} from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';
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
const NOBODY = 99;
const T0 = Date.UTC(2026, 8, 30, 3, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number): Instant => toInstant(ms);

let h: Harness;
let nowMs = T0;
let counter = 0;
let adminId: string;
let cashierId: string;
let bengkel: string;
let shopee: string;
let pcs: string;
let serviceUnit: string;

/** Distinct, valid UUID per call. */
function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

async function login(username: string, password: string, windowId: number) {
  return value(
    await h.call<{ cashierId: string }>(
      C.auth.login,
      { username, password },
      windowId,
    ),
  ).cashierId;
}

beforeEach(async () => {
  nowMs = T0;
  counter = 0;
  h = createHarness({ clock: { now: () => toInstant(nowMs) } });
  value(await h.call(C.settings.completeSetup, validSetup()));
  adminId = await login('admin', ADMIN_PASSWORD, ADMIN);
  value(
    await h.call(C.cashiers.create, {
      username: 'siti',
      displayName: 'Siti',
      password: 'siti-password-1',
      role: 'CASHIER',
    }),
  );
  cashierId = await login('siti', 'siti-password-1', CASHIER);
  const channels = value(
    await h.call<ReferenceDto[]>(C.references.list, { entity: 'channel' }),
  );
  bengkel = channels.find((c) => c.code === 'BENGKEL')!.id;
  shopee = channels.find((c) => c.code === 'ONLINE')!.id;
  const units = value(
    await h.call<ReferenceDto[]>(C.references.list, { entity: 'unit' }),
  );
  pcs = units.find((u) => u.code === 'PCS')!.id;
  serviceUnit = units.find((u) => u.code === 'SERVICE')!.id;
});
afterEach(() => h.close());

const rows = (sql: string, ...params: unknown[]) =>
  h.db.prepare(sql).all(...params) as Record<string, unknown>[];
const count = (sql: string, ...params: unknown[]) =>
  Number((h.db.prepare(sql).get(...params) as { n: bigint }).n);

async function newItem(overrides: Record<string, unknown> = {}) {
  return value(
    await h.call<CatalogItemDto>(
      C.catalog.save,
      { type: 'STOCK_ITEM', title: 'Oli MPX2', unitId: pcs, ...overrides },
      ADMIN,
    ),
  );
}

async function addPrice(args: {
  itemId: string;
  price: string;
  start: Instant;
  channelId?: string;
  correctsPriceId?: string;
  reason?: string;
}) {
  const preview = value(
    await h.call<PricePreviewDto>(
      C.catalog.previewPriceChange,
      {
        catalogItemId: args.itemId,
        channelId: args.channelId ?? bengkel,
        effectiveStartAt: args.start,
        price: args.price,
        ...(args.correctsPriceId
          ? { correctsPriceId: args.correctsPriceId, reason: args.reason }
          : {}),
      },
      ADMIN,
    ),
  );
  return value(
    await h.call<AppliedPriceChangeDto>(
      C.catalog.applyPriceChange,
      { token: preview.token },
      ADMIN,
    ),
  );
}

/** A priced stock item (65000 at Bengkel since yesterday) with a barcode. */
async function pricedItem(
  price = '65000',
  barcode = '8991234567890',
  overrides: Record<string, unknown> = {},
) {
  const item = await newItem(overrides);
  value(
    await h.call(
      C.catalog.saveBarcodes,
      { catalogItemId: item.id, barcodes: [{ barcode, isActive: true }] },
      ADMIN,
    ),
  );
  const applied = await addPrice({
    itemId: item.id,
    price,
    start: at(T0 - DAY),
  });
  return { item, applied };
}

function createDraft(
  overrides: Record<string, unknown> = {},
  windowId = CASHIER,
  requestId = uuid(),
) {
  return h.call<DraftView>(
    C.drafts.create,
    {
      requestId,
      channelId: bengkel,
      invoiceDate: '2026-09-30',
      pricingAt: at(nowMs),
      ...overrides,
    },
    windowId,
  );
}

function apply(
  draft: { id: string; version: number },
  op: DraftOperation,
  options: { windowId?: number; requestId?: string } = {},
) {
  return h.call<DraftView>(
    C.drafts.apply,
    {
      requestId: options.requestId ?? uuid(),
      invoiceId: draft.id,
      expectedVersion: draft.version,
      op,
    },
    options.windowId ?? CASHIER,
  );
}

async function applyOk(
  draft: { id: string; version: number },
  op: DraftOperation,
  options: { windowId?: number; requestId?: string } = {},
) {
  return value(await apply(draft, op, options));
}

const getDraft = (id: string, windowId = CASHIER) =>
  h.call<DraftView>(C.drafts.get, id, windowId);
const listDrafts = (windowId = CASHIER) =>
  h.call<DraftSummary[]>(C.drafts.list, undefined, windowId);

async function draftWithLine(price = '65000') {
  const { item, applied } = await pricedItem(price);
  const draft = value(await createDraft());
  const withLine = await applyOk(draft, {
    kind: 'addCatalogLine',
    catalogItemId: item.id,
  });
  return { item, applied, draft: withLine, line: withLine.lines[0]! };
}

// ---------------------------------------------------------------------------

describe('required assertions', () => {
  test('an acknowledged draft survives closing and reopening the database', async () => {
    const { draft } = await draftWithLine('65000');
    h.reopen();
    await login('siti', 'siti-password-1', CASHIER);
    // The draft has one line (typed so the brief's assertion reads verbatim).
    const reopenedDraft = value(await getDraft(draft.id)) as DraftView & {
      lines: [DraftLineDto, ...DraftLineDto[]];
    };
    expect(reopenedDraft.lines[0].unitPrice).toBe('65000');
    expect(reopenedDraft.version).toBe(draft.version);
    expect(reopenedDraft).toEqual(draft);
  });

  test('a save built from an old version is refused', async () => {
    const { draft, line } = await draftWithLine();
    await applyOk(draft, { kind: 'updateLine', lineId: line.id, quantity: 2 });
    const staleSave = {
      error: failure(
        await apply(draft, {
          kind: 'updateLine',
          lineId: line.id,
          quantity: 5,
        }),
      ),
    };
    expect(staleSave.error.code).toBe('DRAFT_VERSION_CONFLICT');
    expect(value(await getDraft(draft.id)).lines[0]!.quantity).toBe(2);
  });

  test('manual overrides keep an ordered price history', async () => {
    const { draft, line } = await draftWithLine('65000');
    const v2 = await applyOk(draft, {
      kind: 'updateLine',
      lineId: line.id,
      unitPrice: '62500',
    });
    const v3 = await applyOk(v2, {
      kind: 'updateLine',
      lineId: line.id,
      unitPrice: '60000',
      reason: 'Pelanggan tetap',
    });
    const priceHistory = v3.lines[0]!.priceChanges;
    expect(priceHistory.map((x) => x.newPrice)).toEqual(['62500', '60000']);
    expect(priceHistory.map((x) => x.previousPrice)).toEqual([
      '65000',
      '62500',
    ]);
    expect(priceHistory.map((x) => x.kind)).toEqual([
      'MANUAL_OVERRIDE',
      'MANUAL_OVERRIDE',
    ]);
    expect(priceHistory[1]!.reason).toBe('Pelanggan tetap');
    expect(priceHistory[0]!.changedBy.id).toBe(cashierId);
    expect(v3.lines[0]!.pricing.manualPriceOverride).toBe(true);
    expect(v3.lines[0]!.listedUnitPrice).toBe('65000');
    expect(v3.lines[0]!.unitPrice).toBe('60000');
    const audits = rows(
      `SELECT action, metadata FROM audit_log WHERE action = 'DRAFT_PRICE_OVERRIDDEN' ORDER BY id`,
    );
    expect(audits).toHaveLength(2);
    expect(JSON.parse(audits[1]!.metadata as string)).toMatchObject({
      invoiceId: draft.id,
      lineId: line.id,
      previousPrice: '62500',
      newPrice: '60000',
    });
  });

  test('a discarded draft never reappears', async () => {
    const { draft, line } = await draftWithLine();
    const earlierRequest = uuid();
    const v2 = await applyOk(
      draft,
      { kind: 'updateLine', lineId: line.id, quantity: 3 },
      { requestId: earlierRequest },
    );
    const discarded = await applyOk(v2, { kind: 'discard' });
    expect(discarded.discardedAt).toBe(at(nowMs));

    // A delayed retry of an earlier command replays its stored result only.
    const replay = await apply(
      draft,
      { kind: 'updateLine', lineId: line.id, quantity: 3 },
      { requestId: earlierRequest },
    );
    expect(value(replay).version).toBe(v2.version);
    // New commands, even with the right version, are refused.
    expect(
      failure(
        await apply(discarded, {
          kind: 'updateLine',
          lineId: line.id,
          quantity: 4,
        }),
      ).code,
    ).toBe('DRAFT_DISCARDED');
    expect(failure(await getDraft(draft.id)).code).toBe('DRAFT_DISCARDED');

    const list = value(await listDrafts());
    const discardedDraftReappearance = list.some((d) => d.id === draft.id);
    expect(discardedDraftReappearance).toBe(false);
    const row = rows(
      'SELECT discarded_at, version FROM invoices WHERE id = ?',
      draft.id,
    )[0]!;
    expect(row.discarded_at).toBe(at(nowMs));
    expect(row.version).toBe(BigInt(discarded.version));
    expect(
      rows(
        `SELECT cashier_id FROM audit_log WHERE action = 'DRAFT_DISCARDED' AND entity_id = ?`,
        draft.id,
      ),
    ).toEqual([{ cashier_id: cashierId }]);
    // The schema backs it up: a discarded draft cannot be edited directly.
    expect(() =>
      h.db
        .prepare('UPDATE invoices SET note = ? WHERE id = ?')
        .run('x', draft.id),
    ).toThrow(/discarded draft/);
  });
});

describe('create, list, get', () => {
  test('create is idempotent and starts an empty versioned draft', async () => {
    const requestId = uuid();
    const first = value(await createDraft({}, CASHIER, requestId));
    const retry = value(await createDraft({}, CASHIER, requestId));
    expect(retry).toEqual(first);
    expect(count('SELECT COUNT(*) AS n FROM invoices')).toBe(1);
    expect(first).toMatchObject({
      status: 'DRAFT',
      version: 1,
      channelId: bengkel,
      channelLabel: 'Bengkel',
      invoiceDate: '2026-09-30',
      pricingAt: at(T0),
      topDays: 0,
      dueDate: '2026-09-30',
      customer: null,
      vehicle: null,
      ownerMismatch: false,
      lines: [],
      totals: { subtotal: '0', amount: '0', allocatedAmount: '0' },
      createdBy: { id: cashierId, displayName: 'Siti' },
      lastEditedBy: { id: cashierId, displayName: 'Siti' },
      discardedAt: null,
    });
    // Same key, different request.
    expect(
      failure(
        await createDraft({ invoiceDate: '2026-09-29' }, CASHIER, requestId),
      ).code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('create validates the channel and the instants', async () => {
    expect(failure(await createDraft({ channelId: uuid() })).code).toBe(
      'CHANNEL_NOT_FOUND',
    );
    const bad = failure(
      await createDraft({ pricingAt: '2026-09-30T10:00:00+07:00' }),
    );
    expect(bad.code).toBe('VALIDATION_FAILED');
    expect(bad.fieldErrors).toHaveProperty('pricingAt');
    expect(failure(await createDraft({ invoiceDate: '2026-02-30' })).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  test('drafts are shared: summaries show creator, last editor, customer, amount and lines', async () => {
    const { draft, line } = await draftWithLine('65000');
    const customer = value(
      await h.call<SaveCustomerResult>(
        C.customers.save,
        { name: 'Andi', phoneNumber: '0812-1111-2222' },
        CASHIER,
      ),
    );
    if (!customer.saved) throw new Error('not saved');
    nowMs += 60_000;
    // The ADMIN edits the cashier's draft.
    const edited = await applyOk(
      draft,
      { kind: 'updateHeader', changes: { customerId: customer.customer.id } },
      { windowId: ADMIN },
    );
    await applyOk(
      edited,
      { kind: 'updateLine', lineId: line.id, quantity: 2 },
      { windowId: ADMIN },
    );
    nowMs += 60_000;
    const other = value(await createDraft({}, ADMIN));
    const list = value(await listDrafts(CASHIER));
    expect(list.map((d) => d.id)).toEqual([other.id, draft.id]);
    expect(list[1]).toMatchObject({
      id: draft.id,
      version: 4,
      customerLabel: 'Andi',
      amount: '130000',
      lineCount: 1,
      createdBy: { id: cashierId, displayName: 'Siti' },
      lastEditedBy: { id: adminId, displayName: 'Pak Budi' },
      channelLabel: 'Bengkel',
      updatedAt: at(T0 + 60_000),
    });
    expect(list[0]).toMatchObject({
      lineCount: 0,
      amount: '0',
      customerLabel: null,
    });
  });

  test('get of an unknown draft is DRAFT_NOT_FOUND', async () => {
    expect(failure(await getDraft(uuid())).code).toBe('DRAFT_NOT_FOUND');
    expect(
      failure(await apply({ id: uuid(), version: 1 }, { kind: 'discard' }))
        .code,
    ).toBe('DRAFT_NOT_FOUND');
  });
});

describe('idempotency and concurrency', () => {
  test('a retried command returns the same result and has one effect', async () => {
    const draft = value(await createDraft());
    const requestId = uuid();
    const op: DraftOperation = {
      kind: 'addCustomLine',
      type: 'SERVICE',
      title: 'Jasa servis ringan',
      unitPrice: '35000',
    };
    const first = await applyOk(draft, op, { requestId });
    const retry = await applyOk(draft, op, { requestId });
    expect(retry).toEqual(first);
    expect(first.version).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM invoice_items')).toBe(1);
    expect(
      rows('SELECT version FROM invoices WHERE id = ?', draft.id)[0]!.version,
    ).toBe(2n);
    // Later retries still replay the original result, never re-apply.
    const next = await applyOk(first, {
      kind: 'updateHeader',
      changes: { topDays: 7 },
    });
    const lateRetry = await applyOk(draft, op, { requestId });
    expect(lateRetry).toEqual(first);
    expect(value(await getDraft(draft.id)).version).toBe(next.version);
    // Reusing the key for another command is refused.
    expect(
      failure(await apply(next, { kind: 'discard' }, { requestId })).code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('a delayed command carrying an old version never overwrites newer state', async () => {
    const draft = value(await createDraft());
    // Two cashiers load version 1; the admin saves first.
    const adminSave = await applyOk(
      draft,
      { kind: 'updateHeader', changes: { note: 'Ganti oli + cek rem' } },
      { windowId: ADMIN },
    );
    const delayed = await apply(draft, {
      kind: 'updateHeader',
      changes: { note: 'catatan lama' },
    });
    expect(failure(delayed).code).toBe('DRAFT_VERSION_CONFLICT');
    const current = value(await getDraft(draft.id));
    expect(current.note).toBe('Ganti oli + cek rem');
    expect(current.version).toBe(adminSave.version);
    expect(current.lastEditedBy.id).toBe(adminId);
  });

  test('a failed command records nothing and does not bump the version', async () => {
    const draft = value(await createDraft());
    const requestId = uuid();
    expect(
      failure(
        await apply(
          draft,
          { kind: 'addCatalogLine', catalogItemId: uuid() },
          { requestId },
        ),
      ).code,
    ).toBe('CATALOG_ITEM_NOT_FOUND');
    expect(value(await getDraft(draft.id)).version).toBe(1);
    expect(
      count(
        'SELECT COUNT(*) AS n FROM command_receipts WHERE request_id = ?',
        requestId,
      ),
    ).toBe(0);
  });

  test('no session is UNAUTHENTICATED everywhere', async () => {
    const draft = value(await createDraft());
    expect(failure(await createDraft({}, NOBODY)).code).toBe('UNAUTHENTICATED');
    expect(failure(await listDrafts(NOBODY)).code).toBe('UNAUTHENTICATED');
    expect(failure(await getDraft(draft.id, NOBODY)).code).toBe(
      'UNAUTHENTICATED',
    );
    expect(
      failure(await apply(draft, { kind: 'discard' }, { windowId: NOBODY }))
        .code,
    ).toBe('UNAUTHENTICATED');
    expect(
      failure(
        await h.call(
          C.drafts.previewPriceRefresh,
          { invoiceId: draft.id },
          NOBODY,
        ),
      ).code,
    ).toBe('UNAUTHENTICATED');
    expect(
      failure(await h.call(C.adHocReferences.search, { query: 'jasa' }, NOBODY))
        .code,
    ).toBe('UNAUTHENTICATED');
    expect(value(await getDraft(draft.id)).version).toBe(1);
  });
});

describe('catalog lines and pricing', () => {
  test('a scan resolves the channel price at pricingAt and stores provenance', async () => {
    const { item, applied } = await pricedItem('65000', '8990001');
    const draft = value(await createDraft());
    const v2 = await applyOk(draft, {
      kind: 'addCatalogLine',
      barcode: '8990001',
    });
    const line = v2.lines[0]!;
    expect(line).toMatchObject({
      source: 'CATALOG',
      catalogItemId: item.id,
      itemType: 'STOCK_ITEM',
      title: 'Oli MPX2',
      unitLabel: 'Pcs',
      quantity: 1,
      listedUnitPrice: '65000',
      unitPrice: '65000',
      subtotal: '65000',
      amount: '65000',
      pricing: {
        resolvedPriceId: applied.point.id,
        priceResolvedAt: at(T0),
        manualPriceOverride: false,
        currentResolvedPriceId: applied.point.id,
        listedPriceDiffersFromCurrent: false,
      },
      priceChanges: [],
    });
    expect(v2.totals.amount).toBe('65000');
    const stored = rows(
      'SELECT listed_unit_price, unit_price, resolved_price_id, price_resolved_at, manual_price_override FROM invoice_items',
    )[0]!;
    expect(stored).toEqual({
      listed_unit_price: 65000n,
      unit_price: 65000n,
      resolved_price_id: applied.point.id,
      price_resolved_at: at(T0),
      manual_price_override: 0n,
    });
  });

  test('unknown barcodes and inactive items are rejected', async () => {
    const { item } = await pricedItem();
    const draft = value(await createDraft());
    expect(
      failure(await apply(draft, { kind: 'addCatalogLine', barcode: '000' }))
        .code,
    ).toBe('UNKNOWN_BARCODE');
    value(
      await h.call(
        C.catalog.save,
        {
          id: item.id,
          type: 'STOCK_ITEM',
          title: 'Oli MPX2',
          unitId: pcs,
          isActive: false,
        },
        ADMIN,
      ),
    );
    // Manual pick checks isActive itself.
    expect(
      failure(
        await apply(draft, { kind: 'addCatalogLine', catalogItemId: item.id }),
      ).code,
    ).toBe('CATALOG_ITEM_INACTIVE');
    expect(
      failure(
        await apply(draft, {
          kind: 'addCatalogLine',
          barcode: '8991234567890',
        }),
      ).code,
    ).toBe('CATALOG_ITEM_INACTIVE');
    expect(
      failure(
        await apply(draft, {
          kind: 'addCatalogLine',
          catalogItemId: item.id,
          barcode: '1',
        } as DraftOperation),
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(count('SELECT COUNT(*) AS n FROM invoice_items')).toBe(0);
  });

  test('scanning the same item again merges into a plain line', async () => {
    const draft = value(await createDraft());
    await pricedItem('65000', '111');
    const v2 = await applyOk(draft, { kind: 'addCatalogLine', barcode: '111' });
    const v3 = await applyOk(v2, {
      kind: 'addCatalogLine',
      barcode: '111',
      quantity: 2,
    });
    expect(v3.lines).toHaveLength(1);
    expect(v3.lines[0]!.quantity).toBe(3);
    expect(v3.totals.amount).toBe('195000');
  });

  test('a scan after a manual override creates a separate line', async () => {
    const draft = value(await createDraft());
    await pricedItem('65000', '111');
    const v2 = await applyOk(draft, { kind: 'addCatalogLine', barcode: '111' });
    const v3 = await applyOk(v2, {
      kind: 'updateLine',
      lineId: v2.lines[0]!.id,
      unitPrice: '60000',
    });
    const v4 = await applyOk(v3, { kind: 'addCatalogLine', barcode: '111' });
    expect(v4.lines.map((l) => [l.quantity, l.unitPrice])).toEqual([
      [1, '60000'],
      [1, '65000'],
    ]);
    // The next scan merges into the most recent eligible line (the plain one).
    const v5 = await applyOk(v4, { kind: 'addCatalogLine', barcode: '111' });
    expect(v5.lines.map((l) => [l.quantity, l.unitPrice])).toEqual([
      [1, '60000'],
      [2, '65000'],
    ]);
  });

  test('a scan after line discounts creates a separate line', async () => {
    const draft = value(await createDraft());
    await pricedItem('65000', '111');
    const v2 = await applyOk(draft, { kind: 'addCatalogLine', barcode: '111' });
    const v3 = await applyOk(v2, {
      kind: 'setLineDiscounts',
      lineId: v2.lines[0]!.id,
      stages: [1000],
    });
    const v4 = await applyOk(v3, { kind: 'addCatalogLine', barcode: '111' });
    expect(v4.lines).toHaveLength(2);
    expect(v4.lines.map((l) => l.amount)).toEqual(['58500', '65000']);
    // Clearing the stages makes the line eligible again.
    const v5 = await applyOk(v4, {
      kind: 'setLineDiscounts',
      lineId: v2.lines[0]!.id,
      stages: [],
    });
    const v6 = await applyOk(v5, { kind: 'addCatalogLine', barcode: '111' });
    expect(v6.lines.map((l) => l.quantity)).toEqual([1, 2]);
  });

  test('a missing price needs an explicit, audited entry with a null previous price', async () => {
    const item = await newItem({ title: 'Kampas rem' });
    const draft = value(await createDraft());
    const v2 = await applyOk(draft, {
      kind: 'addCatalogLine',
      catalogItemId: item.id,
      unitPrice: '45000',
      reason: 'Belum ada harga',
    });
    const line = v2.lines[0]!;
    expect(line).toMatchObject({
      listedUnitPrice: null,
      unitPrice: '45000',
      pricing: { resolvedPriceId: null, priceResolvedAt: at(T0) },
    });
    expect(line.priceChanges).toHaveLength(1);
    expect(line.priceChanges[0]).toMatchObject({
      kind: 'MISSING_PRICE_ENTRY',
      previousPrice: null,
      newPrice: '45000',
      reason: 'Belum ada harga',
      changedBy: { id: cashierId },
    });
    expect(
      rows('SELECT previous_price, new_price FROM invoice_item_price_changes'),
    ).toEqual([{ previous_price: null, new_price: 45000n }]);
    expect(
      count(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'DRAFT_MISSING_PRICE_ENTERED'`,
      ),
    ).toBe(1);
    // A missing-price line never absorbs later scans.
    const v3 = await applyOk(v2, {
      kind: 'addCatalogLine',
      catalogItemId: item.id,
      unitPrice: '45000',
    });
    expect(v3.lines).toHaveLength(2);
  });

  test('an explicit unit price is refused when a price resolves', async () => {
    const { item } = await pricedItem();
    const draft = value(await createDraft());
    expect(
      failure(
        await apply(draft, {
          kind: 'addCatalogLine',
          catalogItemId: item.id,
          unitPrice: '1',
        }),
      ).code,
    ).toBe('UNIT_PRICE_NOT_EXPECTED');
  });

  test('changing channel or pricingAt retains every existing line price', async () => {
    const { draft, item } = await draftWithLine('65000');
    await addPrice({
      itemId: item.id,
      price: '80000',
      start: at(T0 - DAY),
      channelId: shopee,
    });
    await addPrice({ itemId: item.id, price: '70000', start: at(T0 + HOUR) });
    const v2 = await applyOk(draft, {
      kind: 'updateHeader',
      changes: { channelId: shopee },
    });
    expect(v2.channelId).toBe(shopee);
    expect(v2.lines[0]).toMatchObject({
      unitPrice: '65000',
      listedUnitPrice: '65000',
    });
    expect(v2.lines[0]!.pricing).toMatchObject({
      currentListedPrice: '80000',
      listedPriceDiffersFromCurrent: true,
    });
    const v3 = await applyOk(v2, {
      kind: 'updateHeader',
      changes: { channelId: bengkel, pricingAt: at(T0 + 2 * HOUR) },
    });
    expect(v3.lines[0]).toMatchObject({
      unitPrice: '65000',
      listedUnitPrice: '65000',
    });
    expect(v3.lines[0]!.pricing.currentListedPrice).toBe('70000');
    expect(v3.lines[0]!.priceChanges).toEqual([]);
    // New lines resolve at the new context.
    const v4 = await applyOk(v3, {
      kind: 'updateHeader',
      changes: { channelId: shopee },
    });
    const v5 = await applyOk(v4, {
      kind: 'addCatalogLine',
      catalogItemId: item.id,
    });
    expect(v5.lines.map((l) => l.unitPrice)).toEqual(['65000', '80000']);
  });

  test('master price edits after a line is added never change the draft', async () => {
    const { draft, item, applied } = await draftWithLine('65000');
    const before = rows('SELECT * FROM invoice_items');
    const pointId = applied.point.id;
    // An explicit correction of the very point the line used, plus a new point.
    await addPrice({
      itemId: item.id,
      price: '66000',
      start: at(T0 - DAY),
      correctsPriceId: pointId,
      reason: 'salah ketik',
    });
    await addPrice({ itemId: item.id, price: '90000', start: at(T0 - HOUR) });
    const after = value(await getDraft(draft.id));
    expect(after.version).toBe(draft.version);
    expect(after.lines[0]).toMatchObject({
      unitPrice: '65000',
      listedUnitPrice: '65000',
      amount: '65000',
    });
    expect(after.totals.amount).toBe('65000');
    expect(after.lines[0]!.pricing.listedPriceDiffersFromCurrent).toBe(true);
    expect(rows('SELECT * FROM invoice_items')).toEqual(before);
  });

  test('price refresh: preview is read-only, apply changes only the selected lines', async () => {
    const { draft, item } = await draftWithLine('65000');
    const other = await newItem({ title: 'Busi' });
    await addPrice({ itemId: other.id, price: '20000', start: at(T0 - DAY) });
    const v2 = await applyOk(draft, {
      kind: 'addCatalogLine',
      catalogItemId: other.id,
    });
    const newPoint = await addPrice({
      itemId: item.id,
      price: '70000',
      start: at(T0 + HOUR),
    });
    await addPrice({ itemId: other.id, price: '25000', start: at(T0 + HOUR) });
    const v3 = await applyOk(v2, {
      kind: 'updateHeader',
      changes: { pricingAt: at(T0 + 2 * HOUR) },
    });

    const preview = value(
      await h.call<PriceRefreshPreviewDto>(
        C.drafts.previewPriceRefresh,
        { invoiceId: draft.id },
        CASHIER,
      ),
    );
    expect(preview.version).toBe(v3.version);
    expect(preview.proposals).toEqual([
      expect.objectContaining({
        lineId: v3.lines[0]!.id,
        currentUnitPrice: '65000',
        proposedUnitPrice: '70000',
        resolvedPriceId: newPoint.point.id,
      }),
      expect.objectContaining({
        lineId: v3.lines[1]!.id,
        currentUnitPrice: '20000',
        proposedUnitPrice: '25000',
      }),
    ]);
    expect(value(await getDraft(draft.id)).version).toBe(v3.version);

    const first = preview.proposals[0]!;
    const v4 = await applyOk(v3, {
      kind: 'applyPriceRefresh',
      lines: [
        {
          lineId: first.lineId,
          resolvedPriceId: first.resolvedPriceId,
          proposedUnitPrice: first.proposedUnitPrice,
        },
      ],
    });
    expect(v4.lines.map((l) => l.unitPrice)).toEqual(['70000', '20000']);
    expect(v4.lines[0]).toMatchObject({
      listedUnitPrice: '70000',
      pricing: {
        resolvedPriceId: newPoint.point.id,
        priceResolvedAt: at(T0 + 2 * HOUR),
        manualPriceOverride: false,
        listedPriceDiffersFromCurrent: false,
      },
    });
    expect(v4.lines[0]!.priceChanges).toEqual([
      expect.objectContaining({
        kind: 'PRICE_REFRESH',
        previousPrice: '65000',
        newPrice: '70000',
      }),
    ]);
    expect(v4.totals.amount).toBe('90000');
  });

  test('price refresh is rejected as stale when resolution changed since the preview', async () => {
    const { draft, item } = await draftWithLine('65000');
    await addPrice({ itemId: item.id, price: '70000', start: at(T0 + HOUR) });
    const v2 = await applyOk(draft, {
      kind: 'updateHeader',
      changes: { pricingAt: at(T0 + 2 * HOUR) },
    });
    const preview = value(
      await h.call<PriceRefreshPreviewDto>(
        C.drafts.previewPriceRefresh,
        { invoiceId: draft.id },
        CASHIER,
      ),
    );
    const proposal = preview.proposals[0]!;
    // Someone adds a price that now wins at pricingAt.
    await addPrice({
      itemId: item.id,
      price: '72000',
      start: at(T0 + 90 * 60_000),
    });
    const stale = await apply(v2, {
      kind: 'applyPriceRefresh',
      lines: [
        {
          lineId: proposal.lineId,
          resolvedPriceId: proposal.resolvedPriceId,
          proposedUnitPrice: proposal.proposedUnitPrice,
        },
      ],
    });
    expect(failure(stale).code).toBe('DRAFT_PRICE_REFRESH_STALE');
    const current = value(await getDraft(draft.id));
    expect(current.version).toBe(v2.version);
    expect(current.lines[0]!.unitPrice).toBe('65000');
    expect(count('SELECT COUNT(*) AS n FROM invoice_item_price_changes')).toBe(
      0,
    );
  });

  test('a refresh also resets a manual override', async () => {
    const { draft, line, item } = await draftWithLine('65000');
    const v2 = await applyOk(draft, {
      kind: 'updateLine',
      lineId: line.id,
      unitPrice: '60000',
    });
    const preview = value(
      await h.call<PriceRefreshPreviewDto>(
        C.drafts.previewPriceRefresh,
        { invoiceId: draft.id },
        CASHIER,
      ),
    );
    expect(preview.proposals).toEqual([
      expect.objectContaining({
        currentUnitPrice: '60000',
        proposedUnitPrice: '65000',
        manualPriceOverride: true,
      }),
    ]);
    const v3 = await applyOk(v2, {
      kind: 'applyPriceRefresh',
      lines: [
        {
          lineId: line.id,
          resolvedPriceId: preview.proposals[0]!.resolvedPriceId,
          proposedUnitPrice: '65000',
        },
      ],
    });
    expect(v3.lines[0]!.unitPrice).toBe('65000');
    expect(v3.lines[0]!.pricing.manualPriceOverride).toBe(false);
    expect(v3.lines[0]!.priceChanges.map((c) => c.kind)).toEqual([
      'MANUAL_OVERRIDE',
      'PRICE_REFRESH',
    ]);
    expect(item.id).toBeDefined();
  });
});

describe('line edits', () => {
  test('critical calculation: 100000 with 30%/50%/10% persists 31500', async () => {
    const { draft, line } = await draftWithLine('100000');
    const v2 = await applyOk(draft, {
      kind: 'setLineDiscounts',
      lineId: line.id,
      stages: [3000, 5000, 1000],
    });
    const viewLine = v2.lines[0]!;
    expect(viewLine.amount).toBe('31500');
    expect(viewLine.discountAmount).toBe('68500');
    expect(viewLine.discounts).toEqual([
      { sequence: 1, percentageBps: 3000, amount: '30000' },
      { sequence: 2, percentageBps: 5000, amount: '35000' },
      { sequence: 3, percentageBps: 1000, amount: '3500' },
    ]);
    expect(
      rows(
        'SELECT sequence, percentage_bps, amount FROM invoice_item_discounts ORDER BY sequence',
      ),
    ).toEqual([
      { sequence: 1n, percentage_bps: 3000n, amount: 30000n },
      { sequence: 2n, percentage_bps: 5000n, amount: 35000n },
      { sequence: 3n, percentage_bps: 1000n, amount: 3500n },
    ]);
    expect(
      rows('SELECT subtotal, discount_amount, amount FROM invoice_items'),
    ).toEqual([{ subtotal: 100000n, discount_amount: 68500n, amount: 31500n }]);
    expect(
      rows(
        'SELECT subtotal, item_discount_amount, invoice_discount_amount, discount_amount, amount FROM invoices',
      ),
    ).toEqual([
      {
        subtotal: 100000n,
        item_discount_amount: 68500n,
        invoice_discount_amount: 0n,
        discount_amount: 68500n,
        amount: 31500n,
      },
    ]);
  });

  test('invoice discounts apply to the discounted line sum and are persisted', async () => {
    const { draft, line } = await draftWithLine('100000');
    const v2 = await applyOk(draft, {
      kind: 'updateLine',
      lineId: line.id,
      quantity: 2,
    });
    const v3 = await applyOk(v2, {
      kind: 'setLineDiscounts',
      lineId: line.id,
      stages: [1000],
    });
    const v4 = await applyOk(v3, {
      kind: 'setInvoiceDiscounts',
      stages: [250],
    });
    // 200000 -10% = 180000; invoice -2.5% = 4500 -> 175500
    expect(v4.totals).toMatchObject({
      subtotal: '200000',
      itemDiscountAmount: '20000',
      invoiceDiscountAmount: '4500',
      discountAmount: '24500',
      amount: '175500',
    });
    expect(v4.invoiceDiscounts).toEqual([
      { sequence: 1, percentageBps: 250, amount: '4500' },
    ]);
    // A quantity change recomputes every persisted stage.
    const v5 = await applyOk(v4, {
      kind: 'updateLine',
      lineId: line.id,
      quantity: 1,
    });
    expect(v5.totals.amount).toBe('87750');
    expect(
      rows('SELECT amount FROM invoice_discounts ORDER BY sequence'),
    ).toEqual([{ amount: 2250n }]);
    expect(rows('SELECT amount FROM invoices')).toEqual([{ amount: 87750n }]);
    expect(
      failure(
        await apply(v5, {
          kind: 'setInvoiceDiscounts',
          stages: [1, 2, 3, 4, 5],
        }),
      ).code,
    ).toBe('VALIDATION_FAILED');
  });

  test('removing a line tombstones it and keeps its price history', async () => {
    const { draft, line } = await draftWithLine('65000');
    const v2 = await applyOk(draft, {
      kind: 'updateLine',
      lineId: line.id,
      unitPrice: '60000',
    });
    const v3 = await applyOk(v2, { kind: 'removeLine', lineId: line.id });
    expect(v3.lines).toEqual([]);
    expect(v3.totals.amount).toBe('0');
    expect(
      rows('SELECT removed_at, removed_by_cashier_id FROM invoice_items'),
    ).toEqual([{ removed_at: at(T0), removed_by_cashier_id: cashierId }]);
    expect(count('SELECT COUNT(*) AS n FROM invoice_item_price_changes')).toBe(
      1,
    );
    expect(
      failure(await apply(v3, { kind: 'removeLine', lineId: line.id })).code,
    ).toBe('LINE_NOT_FOUND');
    expect(
      failure(
        await apply(v3, { kind: 'updateLine', lineId: line.id, quantity: 2 }),
      ).code,
    ).toBe('LINE_NOT_FOUND');
    expect(value(await listDrafts())[0]!.lineCount).toBe(0);
  });

  test('a line of another draft is LINE_NOT_FOUND', async () => {
    const { line } = await draftWithLine();
    const other = value(await createDraft());
    expect(
      failure(
        await apply(other, {
          kind: 'updateLine',
          lineId: line.id,
          quantity: 2,
        }),
      ).code,
    ).toBe('LINE_NOT_FOUND');
  });

  test('mechanics only on SERVICE lines, and only active mechanics', async () => {
    const mechanic = value(
      await h.call<ReferenceDto>(
        C.references.save,
        { entity: 'mechanic', name: 'Joko' },
        ADMIN,
      ),
    );
    const retired = value(
      await h.call<ReferenceDto>(
        C.references.save,
        { entity: 'mechanic', name: 'Budi' },
        ADMIN,
      ),
    );
    value(
      await h.call(
        C.references.deactivate,
        { entity: 'mechanic', id: retired.id },
        ADMIN,
      ),
    );
    const service = await newItem({
      type: 'SERVICE',
      title: 'Servis CVT',
      unitId: serviceUnit,
    });
    await addPrice({ itemId: service.id, price: '75000', start: at(T0 - DAY) });
    const { draft, line: stockLine } = await draftWithLine('65000');
    const v2 = await applyOk(draft, {
      kind: 'addCatalogLine',
      catalogItemId: service.id,
    });
    const v3 = await applyOk(v2, {
      kind: 'addCustomLine',
      type: 'SERVICE',
      title: 'Jasa las bracket',
      unitPrice: '50000',
    });
    const v4 = await applyOk(v3, {
      kind: 'addCustomLine',
      type: 'NON_STOCK_ITEM',
      title: 'Seal karet kecil',
      unitPrice: '5000',
    });
    const [, serviceLine, customService, customItem] = v4.lines;

    const v5 = await applyOk(v4, {
      kind: 'updateLine',
      lineId: serviceLine!.id,
      mechanicId: mechanic.id,
    });
    expect(v5.lines[1]).toMatchObject({
      mechanicId: mechanic.id,
      mechanicName: 'Joko',
    });
    const v6 = await applyOk(v5, {
      kind: 'updateLine',
      lineId: customService!.id,
      mechanicId: mechanic.id,
    });
    expect(v6.lines[2]!.mechanicName).toBe('Joko');
    for (const lineId of [stockLine.id, customItem!.id]) {
      expect(
        failure(
          await apply(v6, {
            kind: 'updateLine',
            lineId,
            mechanicId: mechanic.id,
          }),
        ).code,
      ).toBe('MECHANIC_ONLY_FOR_SERVICE');
    }
    expect(
      failure(
        await apply(v6, {
          kind: 'updateLine',
          lineId: serviceLine!.id,
          mechanicId: retired.id,
        }),
      ).code,
    ).toBe('MECHANIC_INACTIVE');
    expect(
      failure(
        await apply(v6, {
          kind: 'updateLine',
          lineId: serviceLine!.id,
          mechanicId: uuid(),
        }),
      ).code,
    ).toBe('MECHANIC_NOT_FOUND');
    const v7 = await applyOk(v6, {
      kind: 'updateLine',
      lineId: serviceLine!.id,
      mechanicId: null,
    });
    expect(v7.lines[1]).toMatchObject({ mechanicId: null, mechanicName: null });
  });

  test('titles are editable on custom lines only', async () => {
    const { draft, line } = await draftWithLine();
    const v2 = await applyOk(draft, {
      kind: 'addCustomLine',
      type: 'SERVICE',
      title: 'Jasa A',
      unitPrice: '1000',
    });
    const v3 = await applyOk(v2, {
      kind: 'updateLine',
      lineId: v2.lines[1]!.id,
      title: 'Jasa B',
    });
    expect(v3.lines[1]!.title).toBe('Jasa B');
    expect(
      failure(
        await apply(v3, { kind: 'updateLine', lineId: line.id, title: 'X' }),
      ).code,
    ).toBe('LINE_TITLE_NOT_EDITABLE');
  });
});

describe('custom lines and ad-hoc references', () => {
  test('a custom line upserts a reusable reference and never touches stock', async () => {
    const draft = value(await createDraft());
    const v2 = await applyOk(draft, {
      kind: 'addCustomLine',
      type: 'SERVICE',
      title: 'Jasa las bracket',
      unitId: serviceUnit,
      unitPrice: '50000',
    });
    const line = v2.lines[0]!;
    expect(line).toMatchObject({
      source: 'CUSTOM',
      catalogItemId: null,
      itemType: 'SERVICE',
      title: 'Jasa las bracket',
      unitLabel: 'Service',
      listedUnitPrice: null,
      unitPrice: '50000',
      pricing: {
        resolvedPriceId: null,
        priceResolvedAt: null,
        manualPriceOverride: false,
      },
    });
    expect(line.adHocItemReferenceId).not.toBeNull();

    const other = value(await createDraft({}, ADMIN));
    const o2 = await applyOk(
      other,
      {
        kind: 'addCustomLine',
        type: 'SERVICE',
        title: 'jasa LAS bracket',
        unitPrice: '55000',
      },
      { windowId: ADMIN },
    );
    expect(o2.lines[0]!.adHocItemReferenceId).toBe(line.adHocItemReferenceId);
    expect(o2.lines[0]!.title).toBe('jasa LAS bracket');
    // Same title, other type: a different reference.
    const o3 = await applyOk(
      o2,
      {
        kind: 'addCustomLine',
        type: 'NON_STOCK_ITEM',
        title: 'Jasa las bracket',
        unitPrice: '1',
      },
      { windowId: ADMIN },
    );
    expect(o3.lines[1]!.adHocItemReferenceId).not.toBe(
      line.adHocItemReferenceId,
    );
    expect(count('SELECT COUNT(*) AS n FROM ad_hoc_item_references')).toBe(2);

    const found = value(
      await h.call<SearchAdHocReferencesResult>(
        C.adHocReferences.search,
        { query: 'las', type: 'SERVICE' },
        CASHIER,
      ),
    );
    expect(found.results).toHaveLength(1);
    expect(found.results[0]).toMatchObject({
      id: line.adHocItemReferenceId,
      title: 'Jasa las bracket',
      defaultPrice: '55000',
    });
    expect(
      value(
        await h.call<SearchAdHocReferencesResult>(
          C.adHocReferences.search,
          { query: '%' },
          CASHIER,
        ),
      ).results,
    ).toEqual([]);

    // Reuse by id.
    const o4 = await applyOk(
      o3,
      {
        kind: 'addCustomLine',
        type: 'SERVICE',
        title: 'Jasa las bracket besar',
        unitPrice: '70000',
        adHocItemReferenceId: line.adHocItemReferenceId!,
      },
      { windowId: ADMIN },
    );
    expect(o4.lines[2]!.adHocItemReferenceId).toBe(line.adHocItemReferenceId);
    expect(
      failure(
        await apply(
          o4,
          {
            kind: 'addCustomLine',
            type: 'NON_STOCK_ITEM',
            title: 'x',
            unitPrice: '1',
            adHocItemReferenceId: line.adHocItemReferenceId!,
          },
          { windowId: ADMIN },
        ),
      ).code,
    ).toBe('AD_HOC_REFERENCE_TYPE_MISMATCH');
    expect(count('SELECT COUNT(*) AS n FROM stock_ledger_entries')).toBe(0);
  });

  test('custom line price edits are recorded as overrides', async () => {
    const draft = value(await createDraft());
    const v2 = await applyOk(draft, {
      kind: 'addCustomLine',
      type: 'NON_STOCK_ITEM',
      title: 'Seal',
      unitPrice: '5000',
    });
    const v3 = await applyOk(v2, {
      kind: 'updateLine',
      lineId: v2.lines[0]!.id,
      unitPrice: '4000',
    });
    expect(v3.lines[0]!.priceChanges).toEqual([
      expect.objectContaining({
        kind: 'MANUAL_OVERRIDE',
        previousPrice: '5000',
        newPrice: '4000',
      }),
    ]);
  });
});

describe('header, customer and vehicle', () => {
  test('dates: due date is persisted, future invoice dates are allowed in a draft', async () => {
    const draft = value(await createDraft());
    const v2 = await applyOk(draft, {
      kind: 'updateHeader',
      changes: {
        invoiceDate: '2026-10-05',
        topDays: 30,
        odometerKm: 12500,
        note: 'Servis rutin',
      },
    });
    expect(v2).toMatchObject({
      invoiceDate: '2026-10-05',
      topDays: 30,
      dueDate: '2026-11-04',
      odometerKm: 12500,
      note: 'Servis rutin',
    });
    expect(rows('SELECT due_date, top_days FROM invoices')).toEqual([
      { due_date: '2026-11-04', top_days: 30n },
    ]);
    const v3 = await applyOk(v2, {
      kind: 'updateHeader',
      changes: { odometerKm: null, note: '  ' },
    });
    expect(v3).toMatchObject({ odometerKm: null, note: null, topDays: 30 });
    expect(
      failure(await apply(v3, { kind: 'updateHeader', changes: {} })).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      failure(
        await apply(v3, { kind: 'updateHeader', changes: { topDays: -1 } }),
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      failure(
        await apply(v3, {
          kind: 'updateHeader',
          changes: { pricingAt: '2026-09-30' },
        }),
      ).code,
    ).toBe('VALIDATION_FAILED');
  });

  test('selecting a customer and a vehicle never transfers ownership; a mismatch warns', async () => {
    const owner = value(
      await h.call<SaveCustomerResult>(
        C.customers.save,
        { name: 'Pemilik' },
        CASHIER,
      ),
    );
    const buyer = value(
      await h.call<SaveCustomerResult>(
        C.customers.save,
        { name: 'Pembeli', phoneNumber: '0813' },
        CASHIER,
      ),
    );
    if (!owner.saved || !buyer.saved) throw new Error('not saved');
    const vehicle = value(
      await h.call<SaveVehicleResult>(
        C.vehicles.save,
        { plateNumber: 'B 1234 XYZ', ownerCustomerId: owner.customer.id },
        CASHIER,
      ),
    );
    const draft = value(await createDraft());
    const v2 = await applyOk(draft, {
      kind: 'updateHeader',
      changes: { customerId: buyer.customer.id, vehicleId: vehicle.vehicle.id },
    });
    expect(v2.customer).toEqual({
      id: buyer.customer.id,
      name: 'Pembeli',
      phoneNumber: '0813',
    });
    expect(v2.vehicle).toMatchObject({
      id: vehicle.vehicle.id,
      plateNumber: 'B 1234 XYZ',
      activeOwnerId: owner.customer.id,
    });
    expect(v2.ownerMismatch).toBe(true);
    expect(
      rows(
        'SELECT customer_id FROM vehicle_ownerships WHERE effective_until IS NULL',
      ),
    ).toEqual([{ customer_id: owner.customer.id }]);
    const v3 = await applyOk(v2, {
      kind: 'updateHeader',
      changes: { customerId: owner.customer.id },
    });
    expect(v3.ownerMismatch).toBe(false);
    const v4 = await applyOk(v3, {
      kind: 'updateHeader',
      changes: { customerId: null },
    });
    expect(v4.ownerMismatch).toBe(false);
    expect(value(await listDrafts())[0]!.plateNumber).toBe('B 1234 XYZ');
    expect(
      failure(
        await apply(v4, {
          kind: 'updateHeader',
          changes: { customerId: uuid() },
        }),
      ).code,
    ).toBe('CUSTOMER_NOT_FOUND');
    expect(
      failure(
        await apply(v4, {
          kind: 'updateHeader',
          changes: { vehicleId: uuid() },
        }),
      ).code,
    ).toBe('VEHICLE_NOT_FOUND');
  });

  test('an inactive channel cannot be selected', async () => {
    const draft = value(await createDraft());
    value(
      await h.call(
        C.references.deactivate,
        { entity: 'channel', id: shopee },
        ADMIN,
      ),
    );
    expect(
      failure(
        await apply(draft, {
          kind: 'updateHeader',
          changes: { channelId: shopee },
        }),
      ).code,
    ).toBe('CHANNEL_INACTIVE');
    expect(failure(await createDraft({ channelId: shopee })).code).toBe(
      'CHANNEL_INACTIVE',
    );
  });
});

describe('legacy checkout allocations', () => {
  test('legacy split plans remain intact until explicitly replaced with cash', async () => {
    const { draft } = await draftWithLine('65000');
    h.db
      .prepare('UPDATE invoices SET cash_received = NULL WHERE id = ?')
      .run(draft.id);
    const legacy = value(
      await apply(draft, {
        kind: 'setCheckoutAllocations',
        allocations: [
          { method: 'CASH', amount: '50000' },
          { method: 'QRIS', amount: '15000', reference: 'QR-778' },
        ],
      }),
    );
    expect(legacy.cashReceived).toBeNull();
    expect(legacy.checkoutAllocations).toMatchObject([
      { method: 'CASH', amount: '50000' },
      { method: 'QRIS', amount: '15000' },
    ]);
    const preview = value(
      await h.call<{ errors: { code: string }[] }>(
        C.invoices.previewFinalize,
        { invoiceId: legacy.id },
        CASHIER,
      ),
    );
    expect(preview.errors.map((e) => e.code)).toContain(
      'LEGACY_CHECKOUT_REVIEW_REQUIRED',
    );
    const replaced = value(
      await apply(legacy, { kind: 'setCashPayment', amount: '65000' }),
    );
    expect(replaced.checkoutAllocations).toMatchObject([
      { method: 'CASH', amount: '65000' },
    ]);
    expect(
      failure(
        await apply(replaced, {
          kind: 'setCheckoutAllocations',
          allocations: [],
        }),
      ).code,
    ).toBe('CHECKOUT_CASH_ONLY');
  });
});

describe('no side effects and the status guard', () => {
  test('drafts create no invoice numbers, payments or stock movements', async () => {
    const { item } = await pricedItem('65000', '111');
    value(
      await h.call(
        C.inventory.openBalance,
        { requestId: uuid(), catalogItemId: item.id, quantity: 10 },
        ADMIN,
      ),
    );
    const ledgerBefore = count(
      'SELECT COUNT(*) AS n FROM stock_ledger_entries',
    );
    const draft = value(await createDraft());
    let v = await applyOk(draft, {
      kind: 'addCatalogLine',
      barcode: '111',
      quantity: 3,
    });
    v = await applyOk(v, {
      kind: 'addCustomLine',
      type: 'NON_STOCK_ITEM',
      title: 'Seal',
      unitPrice: '5000',
    });
    v = await applyOk(v, {
      kind: 'setCashPayment',
      amount: '200000',
    });
    v = await applyOk(v, { kind: 'removeLine', lineId: v.lines[1]!.id });
    expect(count('SELECT COUNT(*) AS n FROM stock_ledger_entries')).toBe(
      ledgerBefore,
    );
    expect(
      value(
        await h.call<{ quantity: number }>(
          C.inventory.getStock,
          { catalogItemId: item.id },
          CASHIER,
        ),
      ).quantity,
    ).toBe(10);
    expect(
      rows(
        'SELECT status, invoice_number, finalized_at, cashier_id FROM invoices',
      ),
    ).toEqual([
      {
        status: 'DRAFT',
        invoice_number: null,
        finalized_at: null,
        cashier_id: null,
      },
    ]);
    expect(
      count(`SELECT COUNT(*) AS n FROM invoices WHERE status <> 'DRAFT'`),
    ).toBe(0);
  });

  test('the schema freezes finalized invoices except for the void transition', async () => {
    const { draft, line } = await draftWithLine('65000');
    const finalize = h.db.prepare(
      `UPDATE invoices SET status = 'FINALIZED', invoice_number = 'INV-20260930-0001', cashier_id = ?,
         finalized_at = ?, channel_label_snapshot = 'Bengkel', cashier_name_snapshot = 'Siti',
         shop_identity_snapshot = '{}' WHERE id = ?`,
    );
    // A draft cannot become FINALIZED without its number and snapshots.
    expect(() =>
      h.db
        .prepare(`UPDATE invoices SET status = 'FINALIZED' WHERE id = ?`)
        .run(draft.id),
    ).toThrow(/CHECK/);
    // Nor jump straight to VOID.
    expect(() =>
      h.db
        .prepare(
          `UPDATE invoices SET status = 'VOID', voided_at = ?, voided_by_cashier_id = ?, void_reason = 'x' WHERE id = ?`,
        )
        .run(at(T0), cashierId, draft.id),
    ).toThrow(/transition/);
    finalize.run(cashierId, at(T0), draft.id);
    expect(() =>
      h.db
        .prepare('UPDATE invoices SET amount = 1, subtotal = 1 WHERE id = ?')
        .run(draft.id),
    ).toThrow(/finalized/);
    expect(() =>
      h.db
        .prepare('UPDATE invoice_items SET quantity = 2 WHERE id = ?')
        .run(line.id),
    ).toThrow(/open draft/);
    expect(() =>
      h.db
        .prepare(
          `UPDATE invoices SET status = 'DRAFT', invoice_number = NULL, cashier_id = NULL, finalized_at = NULL WHERE id = ?`,
        )
        .run(draft.id),
    ).toThrow();
    // Draft commands refuse it.
    expect(
      failure(
        await apply(
          { id: draft.id, version: draft.version },
          { kind: 'discard' },
        ),
      ).code,
    ).toBe('INVOICE_NOT_DRAFT');
    expect(failure(await getDraft(draft.id)).code).toBe('INVOICE_NOT_DRAFT');
    expect(value(await listDrafts())).toEqual([]);
    // FINALIZED -> VOID with the void fields is permitted, then terminal.
    h.db
      .prepare(
        `UPDATE invoices SET status = 'VOID', voided_at = ?, voided_by_cashier_id = ?, void_reason = 'Salah input',
         voided_by_name_snapshot = 'Siti', version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(at(T0 + HOUR), cashierId, at(T0 + HOUR), draft.id);
    expect(() =>
      h.db
        .prepare('UPDATE invoices SET void_reason = ? WHERE id = ?')
        .run('lain', draft.id),
    ).toThrow(/void invoice/);
    expect(() =>
      h.db.prepare('DELETE FROM invoices WHERE id = ?').run(draft.id),
    ).toThrow(/cannot be deleted/);
    expect(() => h.db.prepare('DELETE FROM invoice_items').run()).toThrow(
      /cannot be deleted/,
    );
  });

  test('price history is append-only', async () => {
    const { draft, line } = await draftWithLine('65000');
    await applyOk(draft, {
      kind: 'updateLine',
      lineId: line.id,
      unitPrice: '1',
    });
    expect(() =>
      h.db.prepare('UPDATE invoice_item_price_changes SET new_price = 2').run(),
    ).toThrow(/append-only/);
    expect(() =>
      h.db.prepare('DELETE FROM invoice_item_price_changes').run(),
    ).toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// Forced-process recovery: a child Electron-as-Node process applies commands
// and is killed with SIGKILL; every acknowledged save must be on disk.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
let bundleDir: string;
let writerBundle: string;

describe('forced-process recovery', () => {
  beforeAll(async () => {
    bundleDir = mkdtempSync(path.join(tmpdir(), 'bengkelin-writer-'));
    await build({
      configFile: false,
      root: repoRoot,
      logLevel: 'silent',
      resolve: {
        alias: { '@': path.join(repoRoot, 'src') },
        conditions: ['node'],
        mainFields: ['module', 'jsnext:main'],
      },
      build: {
        outDir: bundleDir,
        emptyOutDir: false,
        copyPublicDir: false,
        minify: false,
        lib: {
          entry: path.join(
            repoRoot,
            'tests/integration/fixtures/draft-writer.ts',
          ),
          formats: ['cjs'],
          fileName: () => 'draft-writer.cjs',
        },
        rollupOptions: {
          external: [
            'better-sqlite3',
            'electron',
            ...builtinModules.flatMap((m) => [m, `node:${m}`]),
          ],
        },
      },
    });
    writerBundle = path.join(bundleDir, 'draft-writer.cjs');
  }, 120_000);
  afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

  test('every acknowledged command survives SIGKILL', async () => {
    const draft = value(await createDraft());
    h.db.close();

    const child = spawn(process.execPath, [writerBundle], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: path.join(repoRoot, 'node_modules'),
        BENGKELIN_DRAFT_WRITER: JSON.stringify({
          dbPath: h.file,
          logDir: path.join(h.dir, 'child-logs'),
          cashierId,
          draftId: draft.id,
          version: draft.version,
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const acks: { version: number; lines: number }[] = [];
    let stderr = '';
    let buffer = '';
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.on('exit', (_code, signal) => resolve(signal)),
    );
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const match = /^ACK (\d+) (\d+)$/.exec(line);
        if (match)
          acks.push({ version: Number(match[1]), lines: Number(match[2]) });
        newline = buffer.indexOf('\n');
      }
      // Kill it while it is still writing.
      if (acks.length >= 25 && child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    });
    const signal = await exited;
    // macOS Electron emits this diagnostic even when the child succeeds.
    expect(
      stderr.replace(
        /^\[\d+\/\d+\.\d+:ERROR:electron\/shell\/common\/mac\/codesign_util\.cc:79\] task_name_for_pid: \(os\/kern\) failure \(5\)\r?\n/gm,
        '',
      ),
    ).toBe('');
    expect(signal).toBe('SIGKILL');
    expect(acks.length).toBeGreaterThanOrEqual(25);

    // Reopen as a restarted app would.
    const db = openDatabase(h.file);
    try {
      const services = createApplicationServices({
        db,
        clock: { now: () => toInstant(nowMs) },
        logDir: path.join(h.dir, 'logs-2'),
        openPath: async () => '',
      });
      const session = {
        windowId: 1,
        cashierId,
        username: 'siti',
        displayName: 'Siti',
        role: 'CASHIER' as const,
        language: 'id' as const,
        appearance: 'SYSTEM' as const,
        numberFormat: 'ID' as const,
      };
      const recovered = services.drafts.get(session, draft.id);
      const last = acks[acks.length - 1]!;
      // Every acknowledged save is there; at most the one in flight may follow.
      expect(recovered.version).toBeGreaterThanOrEqual(last.version);
      expect(recovered.version).toBeLessThanOrEqual(last.version + 1);
      expect(recovered.lines).toHaveLength(recovered.version - 1);
      expect(recovered.lines.slice(0, last.lines).map((l) => l.title)).toEqual(
        Array.from({ length: last.lines }, (_, i) => `Jasa ${i + 1}`),
      );
      expect(recovered.totals.amount).toBe(
        String(1000 * recovered.lines.length),
      );
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  }, 120_000);
});

describe('invoice number reservation', () => {
  test('creation reserves a stable number and retries consume no extra number', async () => {
    const requestId = uuid();
    const first = value(await createDraft({}, CASHIER, requestId));
    const replay = value(await createDraft({}, CASHIER, requestId));
    expect(first).toHaveProperty('invoiceNumber', 'INV-20260930-0001');
    expect(replay).toHaveProperty('invoiceNumber', 'INV-20260930-0001');
    const second = value(await createDraft());
    expect(second).toHaveProperty('invoiceNumber', 'INV-20260930-0002');
  });
});

test('tax number is trimmed and persisted without changing the reservation', async () => {
  const initial = value(await createDraft());
  const updated = value(
    await apply(initial, {
      kind: 'updateHeader',
      changes: { taxInvoiceNumber: '  TAX-123  ', invoiceDate: '2026-09-29' },
    } as DraftOperation),
  );
  expect(updated).toHaveProperty('taxInvoiceNumber', 'TAX-123');
  expect(updated).toHaveProperty('invoiceNumber', 'INV-20260930-0001');
});

test('discarded reservations leave a gap and reopening or backdating retains the number', async () => {
  const first = value(await createDraft());
  value(await apply(first, { kind: 'discard' }));
  const second = value(await createDraft());
  const updated = value(
    await apply(second, {
      kind: 'updateHeader',
      changes: { invoiceDate: '2026-09-29' },
    }),
  );
  expect(updated.invoiceNumber).toBe('INV-20260930-0002');
  expect(
    value(await h.call<DraftView>(C.drafts.get, updated.id, CASHIER))
      .invoiceNumber,
  ).toBe(updated.invoiceNumber);
});

test('legacy reservation command is idempotent and read-only get does not reserve', async () => {
  const draft = value(await createDraft());
  h.db.exec('DROP TRIGGER invoices_reservation_immutable');
  h.db
    .prepare('UPDATE invoices SET reserved_invoice_number = NULL WHERE id = ?')
    .run(draft.id);
  const read = value(await h.call<DraftView>(C.drafts.get, draft.id, CASHIER));
  expect(read.invoiceNumber).toBeNull();
  const requestId = uuid();
  const reserved = value(
    await apply(read, { kind: 'reserveInvoiceNumber' }, { requestId }),
  );
  const replay = value(
    await apply(read, { kind: 'reserveInvoiceNumber' }, { requestId }),
  );
  expect(reserved.invoiceNumber).toBe('INV-20260930-0002');
  expect(replay.invoiceNumber).toBe(reserved.invoiceNumber);
});

test('adding an unpriced product inserts zero immediately and requires confirmation', async () => {
  const item = await newItem();
  const draft = value(await createDraft());
  const added = value(
    await apply(draft, { kind: 'addCatalogLine', catalogItemId: item.id }),
  );
  expect(added.lines[0]).toMatchObject({
    unitPrice: '0',
    priceEntryConfirmed: false,
  });
  const confirmed = value(
    await apply(added, {
      kind: 'confirmLineZeroPrice',
      lineId: added.lines[0]!.id,
    }),
  );
  expect(confirmed.lines[0]).toHaveProperty('priceEntryConfirmed', true);
});

test('finalization preview groups an unconfirmed zero price for acknowledgment', async () => {
  const item = await newItem();
  const draft = value(await createDraft());
  const added = value(
    await apply(draft, { kind: 'addCatalogLine', catalogItemId: item.id }),
  );
  const preview = value(
    await h.call<{ errors: { code: string }[]; warnings: unknown[] }>(
      C.invoices.previewFinalize,
      { invoiceId: added.id },
      CASHIER,
    ),
  );
  expect(preview.errors).toEqual([]);
  expect(preview.warnings).toContainEqual({
    code: 'ZERO_UNIT_PRICE',
    params: {
      lines: [
        {
          lineId: added.lines[0]!.id,
          title: added.lines[0]!.title,
          quantity: 1,
          storedUnitPrice: null,
        },
      ],
    },
  });
});

test('entry price preview resolves draft context without changing the draft', async () => {
  const { item } = await pricedItem('65000');
  const draft = value(await createDraft());
  const preview = h.services.drafts.previewCatalogPrice(
    h.services.sessions.get(CASHIER),
    { invoiceId: draft.id, catalogItemId: item.id },
  );
  expect(preview).toMatchObject({
    version: draft.version,
    unitPrice: '65000',
    channelId: bengkel,
    pricingAt: at(T0),
  });
  expect(
    value(await h.call<DraftView>(C.drafts.get, draft.id, CASHIER)),
  ).toEqual(draft);
});

test('price preview handles missing prices, authentication and channel changes', async () => {
  const item = await newItem();
  const draft = value(await createDraft());
  const input = { invoiceId: draft.id, catalogItemId: item.id };
  expect(
    h.services.drafts.previewCatalogPrice(
      h.services.sessions.get(CASHIER),
      input,
    ),
  ).toMatchObject({ unitPrice: '0', resolvedPriceId: null });
  expect(() =>
    h.services.drafts.previewCatalogPrice(undefined, input),
  ).toThrow();
  await addPrice({
    itemId: item.id,
    channelId: shopee,
    start: at(T0 - DAY),
    price: '12345',
  });
  const changed = value(
    await apply(draft, {
      kind: 'updateHeader',
      changes: { channelId: shopee },
    }),
  );
  expect(
    h.services.drafts.previewCatalogPrice(
      h.services.sessions.get(CASHIER),
      input,
    ),
  ).toMatchObject({
    unitPrice: '12345',
    version: changed.version,
    channelId: shopee,
  });
});

test('positive manual price clears provisional state and zero confirmation persists', async () => {
  const item = await newItem();
  const draft = value(await createDraft());
  const added = value(
    await apply(draft, { kind: 'addCatalogLine', catalogItemId: item.id }),
  );
  const lineId = added.lines[0]!.id;
  const priced = value(
    await apply(added, { kind: 'updateLine', lineId, unitPrice: '1000' }),
  );
  expect(priced.lines[0]!.priceEntryConfirmed).toBe(true);
  const zero = value(
    await apply(priced, { kind: 'updateLine', lineId, unitPrice: '0' }),
  );
  expect(zero.lines[0]!.priceEntryConfirmed).toBe(false);
  const confirmed = value(
    await apply(zero, { kind: 'confirmLineZeroPrice', lineId }),
  );
  expect(
    value(await h.call<DraftView>(C.drafts.get, confirmed.id, CASHIER))
      .lines[0]!.priceEntryConfirmed,
  ).toBe(true);
});

test('cash received is capped to the invoice amount and survives total edits', async () => {
  const { draft } = await draftWithLine('100000');
  const paid = value(
    await apply(draft, {
      kind: 'setCashPayment',
      amount: '120000',
    } as DraftOperation),
  );
  expect(paid).toHaveProperty('cashReceived', '120000');
  expect(paid.checkoutAllocations).toMatchObject([
    { method: 'CASH', amount: '100000' },
  ]);
  const changed = value(
    await apply(paid, {
      kind: 'updateLine',
      lineId: paid.lines[0]!.id,
      unitPrice: '50000',
    }),
  );
  expect(changed).toHaveProperty('cashReceived', '120000');
  expect(changed.checkoutAllocations).toMatchObject([
    { method: 'CASH', amount: '50000' },
  ]);
});

test('TOP zero requires full cash and positive TOP allows credit', async () => {
  const { draft } = await draftWithLine('100000');
  const partial = value(
    await apply(draft, { kind: 'setCashPayment', amount: '40000' }),
  );
  const before = value(
    await h.call<{ errors: { code: string }[] }>(
      C.invoices.previewFinalize,
      { invoiceId: partial.id },
      CASHIER,
    ),
  );
  expect(before.errors.map((e) => e.code)).toContain(
    'CASH_PAYMENT_INSUFFICIENT',
  );
  const credit = value(
    await apply(partial, { kind: 'updateHeader', changes: { topDays: 30 } }),
  );
  const after = value(
    await h.call<{ errors: { code: string }[] }>(
      C.invoices.previewFinalize,
      { invoiceId: credit.id },
      CASHIER,
    ),
  );
  expect(after.errors).toEqual([]);
  expect(credit.totals.unallocatedAmount).toBe('60000');
});

test('explicit zero requires checkout acknowledgment even after legacy confirmation', async () => {
  const item = await newItem();
  const initial = value(await createDraft());
  const added = value(
    await apply(initial, {
      kind: 'addCatalogLine',
      catalogItemId: item.id,
      unitPrice: '0',
    }),
  );
  expect(added.lines[0]!.priceEntryConfirmed).toBe(false);
  const blocked = value(
    await h.call<{ errors: { code: string }[] }>(
      C.invoices.previewFinalize,
      { invoiceId: added.id },
      CASHIER,
    ),
  );
  expect(blocked.errors).toEqual([]);
  expect(
    failure(
      await h.call(
        C.invoices.finalize,
        {
          requestId: uuid(),
          invoiceId: added.id,
          expectedVersion: added.version,
          acknowledgedWarnings: [],
        },
        CASHIER,
      ),
    ).code,
  ).toBe('FINALIZE_WARNINGS_CHANGED');
  const confirmed = value(
    await apply(added, {
      kind: 'confirmLineZeroPrice',
      lineId: added.lines[0]!.id,
    }),
  );
  expect(
    value(await h.call<DraftView>(C.drafts.get, confirmed.id, CASHIER))
      .lines[0]!.priceEntryConfirmed,
  ).toBe(true);
  expect(
    h.db
      .prepare(
        "SELECT action FROM audit_log WHERE entity_id = ? AND action = 'DRAFT_ZERO_PRICE_CONFIRMED'",
      )
      .all(confirmed.id),
  ).toHaveLength(1);
  const ready = value(
    await h.call<{
      draftVersion: number;
      warnings: unknown[];
      errors: unknown[];
    }>(C.invoices.previewFinalize, { invoiceId: confirmed.id }, CASHIER),
  );
  expect(ready.errors).toEqual([]);
  expect(
    value(
      await h.call<{ invoiceNumber: string }>(
        C.invoices.finalize,
        {
          requestId: uuid(),
          invoiceId: confirmed.id,
          expectedVersion: ready.draftVersion,
          acknowledgedWarnings: ready.warnings,
        },
        CASHIER,
      ),
    ).invoiceNumber,
  ).toBe(confirmed.invoiceNumber);
});
