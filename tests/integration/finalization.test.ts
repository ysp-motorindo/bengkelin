import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readSaleEntriesForInvoice } from '@/main/features/inventory/ledger';
import {
  FINALIZE_STEPS,
  InvoiceService,
  type FinalizeStep,
} from '@/main/features/invoices/service';
import { CHANNELS } from '@/shared/channels';
import {
  finalizeInputSchema,
  type CatalogItemDto,
  type DraftOperation,
  type DraftView,
  type FinalizePreviewDto,
  type FinalizeWarning,
  type InvoiceView,
  type PricePreviewDto,
  type ReferenceDto,
  type SaveCustomerResult,
  type SaveVehicleResult,
} from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';
import { businessDay, toInstant } from '@/shared/time';
import {
  ADMIN_PASSWORD,
  createHarness,
  failure,
  validSetup,
  value,
  type Harness,
} from './helpers/harness';

/**
 * Task 10: atomic finalization and checkout payments. Shop timezone is
 * Asia/Jakarta (UTC+7); the clock is injected. T0 = 2026-09-30 10:00 WIB.
 */

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
/** When set, successive clock reads return these instants (last repeats). */
let scripted: number[] | null = null;
let counter = 0;
let adminId: string;
let cashierId: string;
let bengkel: string;
let pcs: string;
let serviceUnit: string;

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
  scripted = null;
  counter = 0;
  h = createHarness({
    clock: {
      now: () =>
        toInstant(
          scripted && scripted.length > 0
            ? scripted.length > 1
              ? scripted.shift()!
              : scripted[0]!
            : nowMs,
        ),
    },
  });
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

// ---- master data ----

async function newItem(overrides: Record<string, unknown> = {}) {
  return value(
    await h.call<CatalogItemDto>(
      C.catalog.save,
      { type: 'STOCK_ITEM', title: 'Oli MPX2', unitId: pcs, ...overrides },
      ADMIN,
    ),
  );
}

async function setPrice(itemId: string, price: string, start: Instant) {
  const preview = value(
    await h.call<PricePreviewDto>(
      C.catalog.previewPriceChange,
      {
        catalogItemId: itemId,
        channelId: bengkel,
        effectiveStartAt: start,
        price,
      },
      ADMIN,
    ),
  );
  value(
    await h.call(C.catalog.applyPriceChange, { token: preview.token }, ADMIN),
  );
}

/** A priced catalog item (price valid since yesterday). */
async function pricedItem(
  price = '65000',
  overrides: Record<string, unknown> = {},
) {
  const item = await newItem(overrides);
  await setPrice(item.id, price, at(T0 - DAY));
  return item;
}

async function openBalance(itemId: string, quantity: number) {
  value(
    await h.call(
      C.inventory.openBalance,
      { requestId: uuid(), catalogItemId: itemId, quantity },
      ADMIN,
    ),
  );
}

async function receive(itemId: string, quantity: number) {
  value(
    await h.call(
      C.inventory.receive,
      { requestId: uuid(), catalogItemId: itemId, quantity },
      ADMIN,
    ),
  );
}

async function customer(name: string, phoneNumber?: string) {
  const saved = value(
    await h.call<SaveCustomerResult>(
      C.customers.save,
      { name, ...(phoneNumber ? { phoneNumber } : {}) },
      CASHIER,
    ),
  );
  if (!saved.saved) throw new Error('not saved');
  return saved.customer;
}

async function vehicle(plateNumber: string, ownerCustomerId: string) {
  return value(
    await h.call<SaveVehicleResult>(
      C.vehicles.save,
      { plateNumber, ownerCustomerId },
      CASHIER,
    ),
  ).vehicle;
}

// ---- drafts ----

async function createDraft(
  overrides: Record<string, unknown> = {},
  windowId = CASHIER,
) {
  const draft = value(
    await h.call<DraftView>(
      C.drafts.create,
      {
        requestId: uuid(),
        channelId: bengkel,
        invoiceDate: '2026-09-30',
        pricingAt: at(nowMs),
        ...overrides,
      },
      windowId,
    ),
  );
  return applyOk(draft, { kind: 'updateHeader', changes: { topDays: 30 } });
}

async function applyOk(
  draft: { id: string; version: number },
  op: DraftOperation,
  windowId = CASHIER,
) {
  return value(
    await h.call<DraftView>(
      C.drafts.apply,
      {
        requestId: uuid(),
        invoiceId: draft.id,
        expectedVersion: draft.version,
        op,
      },
      windowId,
    ),
  );
}

async function draftWith(
  lines: { itemId: string; quantity?: number }[],
  overrides: Record<string, unknown> = {},
) {
  let draft = await createDraft(overrides);
  for (const line of lines) {
    draft = await applyOk(draft, {
      kind: 'addCatalogLine',
      catalogItemId: line.itemId,
      ...(line.quantity ? { quantity: line.quantity } : {}),
    });
  }
  return draft;
}

// ---- finalization ----

const preview = (invoiceId: string, windowId = CASHIER) =>
  h.call<FinalizePreviewDto>(
    C.invoices.previewFinalize,
    { invoiceId },
    windowId,
  );

function finalize(
  draft: { id: string; version: number },
  options: {
    requestId?: string;
    acknowledgedWarnings?: FinalizeWarning[];
    windowId?: number;
  } = {},
) {
  return h.call<InvoiceView>(
    C.invoices.finalize,
    {
      requestId: options.requestId ?? uuid(),
      invoiceId: draft.id,
      expectedVersion: draft.version,
      acknowledgedWarnings: options.acknowledgedWarnings ?? [],
    },
    options.windowId ?? CASHIER,
  );
}

/** Preview, then finalize acknowledging exactly what the preview showed. */
async function finalizeOk(
  draft: { id: string },
  options: { requestId?: string; windowId?: number } = {},
) {
  const shown = value(await preview(draft.id, options.windowId));
  expect(shown.errors).toEqual([]);
  return value(
    await finalize(
      { id: draft.id, version: shown.draftVersion },
      { ...options, acknowledgedWarnings: shown.warnings },
    ),
  );
}

const invoiceRow = (id: string) =>
  h.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
const paymentRows = (invoiceId: string) =>
  rows('SELECT * FROM payments WHERE invoice_id = ? ORDER BY rowid', invoiceId);
const getInvoice = (invoiceId: string, windowId = CASHIER) =>
  h.call<InvoiceView>(C.invoices.get, { invoiceId }, windowId);

/** Everything finalization could touch, for "nothing changed" checks. */
function dump() {
  return {
    invoices: rows('SELECT * FROM invoices ORDER BY id'),
    items: rows('SELECT * FROM invoice_items ORDER BY id'),
    itemDiscounts: rows('SELECT * FROM invoice_item_discounts ORDER BY id'),
    invoiceDiscounts: rows('SELECT * FROM invoice_discounts ORDER BY id'),
    allocations: rows('SELECT * FROM draft_checkout_allocations ORDER BY id'),
    priceChanges: rows('SELECT * FROM invoice_item_price_changes ORDER BY id'),
    counters: rows('SELECT * FROM invoice_daily_counters ORDER BY 1'),
    ledger: rows('SELECT * FROM stock_ledger_entries ORDER BY rowid'),
    payments: rows('SELECT * FROM payments ORDER BY rowid'),
    receipts: rows('SELECT * FROM command_receipts ORDER BY request_id'),
    audit: rows('SELECT * FROM audit_log ORDER BY id'),
  };
}

/** A priced tracked item with stock 10 and a draft with `quantity` of it. */
async function stockedDraft(quantity = 2, price = '65000') {
  const item = await pricedItem(price);
  await openBalance(item.id, 10);
  const draft = await draftWith([{ itemId: item.id, quantity }]);
  return { item, draft };
}

// ---------------------------------------------------------------------------

describe('required assertions', () => {
  test('first number of the day, idempotent retry, one sale entry, rollback on failure', async () => {
    const { item, draft } = await stockedDraft(2);
    const requestId = uuid();
    const shown = value(await preview(draft.id));
    const first = value(
      await finalize(draft, {
        requestId,
        acknowledgedWarnings: shown.warnings,
      }),
    );
    const retry = value(
      await finalize(draft, {
        requestId,
        acknowledgedWarnings: shown.warnings,
      }),
    );
    const saleEntries = readSaleEntriesForInvoice(h.db, draft.id);

    // A second draft whose finalization fails inside SQLite (a trigger).
    const other = await draftWith([{ itemId: item.id }]);
    const withPlan = await applyOk(other, {
      kind: 'setCashPayment',
      amount: '65000',
    });
    h.db.exec(
      `CREATE TEMP TRIGGER fail_payment BEFORE INSERT ON payments
       BEGIN SELECT RAISE(ABORT, 'injected payment failure'); END`,
    );
    const failed = await finalize(withPlan);
    h.db.exec('DROP TRIGGER temp.fail_payment');
    const failedAttempt = {
      error: failure(failed),
      invoice: invoiceRow(other.id),
      payments: paymentRows(other.id),
    };

    expect(first.invoiceNumber).toBe('INV-20260930-0001');
    expect(retry.invoiceNumber).toBe(first.invoiceNumber);
    expect(saleEntries).toHaveLength(1);
    expect(failedAttempt.invoice.status).toBe('DRAFT');
    expect(failedAttempt.payments).toHaveLength(0);

    expect(failedAttempt.error.code).toBe('INTERNAL_ERROR');
    expect(failedAttempt.invoice.invoice_number).toBeNull();
    expect(
      rows(
        'SELECT method, amount FROM draft_checkout_allocations WHERE invoice_id = ?',
        other.id,
      ),
    ).toEqual([{ method: 'CASH', amount: 65000n }]);
    expect(readSaleEntriesForInvoice(h.db, other.id)).toEqual([]);
    expect(saleEntries[0]).toMatchObject({
      catalogItemId: item.id,
      quantity: 2,
    });
  });
});

describe('idempotency and duplicates', () => {
  test('a retry with the same requestId returns the identical view and adds nothing', async () => {
    const { draft } = await stockedDraft(2, '65000');
    const planned = await applyOk(draft, {
      kind: 'setCashPayment',
      amount: '100000',
    });
    const requestId = uuid();
    const first = await finalizeOk(planned, { requestId });
    const before = dump();
    nowMs += HOUR; // a late retry
    const retry = value(
      await finalize(planned, { requestId, acknowledgedWarnings: [] }),
    );
    expect(retry).toEqual(first);
    expect(dump()).toEqual(before);
    expect(count('SELECT COUNT(*) AS n FROM payments')).toBe(1);
    expect(
      count(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'INVOICE_FINALIZED'`,
      ),
    ).toBe(1);
    expect(rows('SELECT * FROM invoice_daily_counters')).toEqual([
      { business_date: '2026-09-30', last_sequence: 1n },
    ]);
  });

  test('a new requestId on a finalized invoice is INVOICE_NOT_DRAFT and allocates nothing', async () => {
    const { draft } = await stockedDraft();
    const first = await finalizeOk(draft);
    const before = dump();
    const again = failure(
      await finalize({ id: draft.id, version: first.version }),
    );
    expect(again.code).toBe('INVOICE_NOT_DRAFT');
    expect(failure(await preview(draft.id)).code).toBe('INVOICE_NOT_DRAFT');
    expect(dump()).toEqual(before);
  });

  test('reusing a requestId for another invoice is refused', async () => {
    const { item, draft } = await stockedDraft();
    const requestId = uuid();
    await finalizeOk(draft, { requestId });
    const other = await draftWith([{ itemId: item.id }]);
    expect(failure(await finalize(other, { requestId })).code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(invoiceRow(other.id).status).toBe('DRAFT');
  });

  test('draft checks: missing, discarded, stale version, empty', async () => {
    expect(failure(await finalize({ id: uuid(), version: 1 })).code).toBe(
      'DRAFT_NOT_FOUND',
    );
    const empty = await createDraft();
    const shown = value(await preview(empty.id));
    expect(shown.errors).toEqual([{ code: 'DRAFT_EMPTY', params: {} }]);
    expect(failure(await finalize(empty)).code).toBe('DRAFT_EMPTY');

    const { draft } = await stockedDraft();
    expect(
      failure(await finalize({ id: draft.id, version: draft.version - 1 }))
        .code,
    ).toBe('DRAFT_VERSION_CONFLICT');

    const discarded = await applyOk(empty, { kind: 'discard' });
    expect(failure(await finalize(discarded)).code).toBe('DRAFT_DISCARDED');
    expect(failure(await preview(empty.id)).code).toBe('DRAFT_DISCARDED');
    expect(count('SELECT COUNT(*) AS n FROM invoice_daily_counters')).toBe(0);
  });

  test('preview is read-only', async () => {
    const { draft } = await stockedDraft(20);
    const before = dump();
    const shown = value(await preview(draft.id));
    expect(shown.draftVersion).toBe(draft.version);
    expect(shown.warnings.map((w) => w.code)).toEqual(['NEGATIVE_STOCK']);
    expect(dump()).toEqual(before);
  });
});

describe('numbering', () => {
  test('midnight in the shop timezone decides the business day', async () => {
    const item = await pricedItem();
    nowMs = Date.UTC(2026, 8, 30, 16, 59, 59, 999); // 23:59:59.999 WIB
    const late = await finalizeOk(await draftWith([{ itemId: item.id }]));
    expect(late.invoiceNumber).toBe('INV-20260930-0001');
    nowMs = Date.UTC(2026, 8, 30, 17, 0, 0, 0); // 00:00 WIB on Oct 1
    const early = await finalizeOk(await draftWith([{ itemId: item.id }]));
    expect(early.invoiceNumber).toBe('INV-20261001-0001');
    expect(early.invoiceDate).toBe('2026-09-30');
    expect(early.finalizedAt).toBe('2026-09-30T17:00:00.000Z');
  });

  test('one clock read per finalization: number date, finalized_at and payments agree across midnight', async () => {
    const { draft } = await stockedDraft(2, '65000');
    const withPlan = await applyOk(draft, {
      kind: 'setCashPayment',
      amount: '80000',
    });
    const shown = value(await preview(withPlan.id));
    // The first read is 23:59:59.999 WIB; every later read is past midnight.
    scripted = [
      Date.UTC(2026, 8, 30, 16, 59, 59, 999),
      Date.UTC(2026, 8, 30, 17, 0, 0, 0),
      Date.UTC(2026, 8, 30, 17, 0, 1, 0),
    ];
    const view = value(
      await finalize(
        { id: withPlan.id, version: shown.draftVersion },
        { acknowledgedWarnings: shown.warnings },
      ),
    );
    const finalizedAt = view.finalizedAt as string;
    const day = businessDay(finalizedAt as Instant, 'Asia/Jakarta').replaceAll(
      '-',
      '',
    );
    expect(view.invoiceNumber).toBe(`INV-${day}-0001`);
    const payments = paymentRows(withPlan.id);
    expect(payments).toHaveLength(1);
    for (const payment of payments) {
      expect(payment.paid_at).toBe(finalizedAt);
    }
    const audit = h.db
      .prepare(
        "SELECT created_at FROM audit_log WHERE action = 'INVOICE_FINALIZED'",
      )
      .get() as { created_at: string };
    expect(audit.created_at).toBe(finalizedAt);
  });

  test('the sequence increments within a day, resets per day and never wraps', async () => {
    const item = await pricedItem();
    const numbers: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      numbers.push(
        (await finalizeOk(await draftWith([{ itemId: item.id }])))
          .invoiceNumber!,
      );
    }
    expect(numbers).toEqual([
      'INV-20260930-0001',
      'INV-20260930-0002',
      'INV-20260930-0003',
    ]);
    nowMs = T0 + DAY;
    expect(
      (await finalizeOk(await draftWith([{ itemId: item.id }]))).invoiceNumber,
    ).toBe('INV-20261001-0001');

    nowMs = T0 + 2 * DAY;
    h.db
      .prepare(
        `INSERT INTO invoice_daily_counters (business_date, last_sequence) VALUES ('2026-10-02', 9999)`,
      )
      .run();
    expect(
      (await finalizeOk(await draftWith([{ itemId: item.id }]))).invoiceNumber,
    ).toBe('INV-20261002-10000');
    expect(
      (await finalizeOk(await draftWith([{ itemId: item.id }]))).invoiceNumber,
    ).toBe('INV-20261002-10001');
  });

  test('counters only move forward and cannot be deleted', async () => {
    const item = await pricedItem();
    await finalizeOk(await draftWith([{ itemId: item.id }]));
    expect(() =>
      h.db
        .prepare(
          `UPDATE invoice_daily_counters SET last_sequence = 0 WHERE business_date = '2026-09-30'`,
        )
        .run(),
    ).toThrow(/counter/);
    expect(() =>
      h.db.prepare('DELETE FROM invoice_daily_counters').run(),
    ).toThrow(/counter/);
    expect(() =>
      h.db
        .prepare(
          `INSERT INTO invoice_daily_counters (business_date, last_sequence) VALUES ('2026-10-09', -1)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    // Moving forward is allowed (restore keeps the maximum).
    h.db
      .prepare(
        `UPDATE invoice_daily_counters SET last_sequence = 50 WHERE business_date = '2026-09-30'`,
      )
      .run();
    expect(
      (await finalizeOk(await draftWith([{ itemId: item.id }]))).invoiceNumber,
    ).toBe('INV-20260930-0051');
  });

  test('a backdated invoice is numbered by the finalization day', async () => {
    const item = await pricedItem();
    const draft = await draftWith([{ itemId: item.id }], {
      invoiceDate: '2026-09-25',
    });
    const withTop = await applyOk(draft, {
      kind: 'updateHeader',
      changes: { topDays: 7 },
    });
    const view = await finalizeOk(withTop);
    expect(view.invoiceNumber).toBe('INV-20260930-0001');
    expect(view.invoiceDate).toBe('2026-09-25');
    expect(view.dueDate).toBe('2026-10-02');
  });

  test('a pricing time later than the finalize instant is rejected (M1)', async () => {
    const item = await pricedItem();
    const later = at(nowMs + 60 * 60_000); // one hour ahead, same day
    const draft = await draftWith([{ itemId: item.id }], {
      pricingAt: later,
    });
    const shown = value(await preview(draft.id));
    expect(shown.errors).toEqual([
      { code: 'PRICING_AT_IN_FUTURE', params: { pricingAt: later } },
    ]);
    const before = dump();
    const error = failure(await finalize(draft));
    expect(error.code).toBe('PRICING_AT_IN_FUTURE');
    expect(error.messageKey).toBe('errors.PRICING_AT_IN_FUTURE');
    expect(dump()).toEqual(before);
    // Exactly at the pricing time it is no longer in the future.
    nowMs += 60 * 60_000;
    expect(value(await preview(draft.id)).errors).toEqual([]);
    expect((await finalizeOk(draft)).status).toBe('FINALIZED');
  });

  test('a future invoice date is rejected at finalization', async () => {
    const item = await pricedItem();
    const draft = await draftWith([{ itemId: item.id }], {
      invoiceDate: '2026-10-01',
    });
    const shown = value(await preview(draft.id));
    expect(shown.errors).toEqual([
      {
        code: 'INVOICE_DATE_IN_FUTURE',
        params: { invoiceDate: '2026-10-01', today: '2026-09-30' },
      },
    ]);
    const before = dump();
    const error = failure(await finalize(draft));
    expect(error.code).toBe('INVOICE_DATE_IN_FUTURE');
    expect(error.messageKey).toBe('errors.INVOICE_DATE_IN_FUTURE');
    expect(dump()).toEqual(before);
    // After local midnight the same date is today.
    nowMs = Date.UTC(2026, 8, 30, 17, 0, 0, 0);
    expect((await finalizeOk(draft)).invoiceNumber).toBe('INV-20261001-0001');
  });
});

describe('inactive references', () => {
  const deactivate = (itemId: string, isActive = false) =>
    h.call(
      C.catalog.save,
      {
        id: itemId,
        type: 'STOCK_ITEM',
        title: 'Oli MPX2',
        unitId: pcs,
        isActive,
      },
      ADMIN,
    );

  test('a catalog item deactivated after it was added blocks preview and finalize', async () => {
    const { item, draft } = await stockedDraft(2);
    const planned = await applyOk(draft, {
      kind: 'setCashPayment',
      amount: '50000',
    });
    // Previewed while still active...
    const earlier = value(await preview(planned.id));
    expect(earlier.errors).toEqual([]);
    // ...then deactivated before Finalize: the in-transaction check refuses.
    value(await deactivate(item.id));
    const before = dump();
    const error = failure(
      await finalize(planned, { acknowledgedWarnings: earlier.warnings }),
    );
    expect(error).toMatchObject({
      code: 'CATALOG_ITEM_INACTIVE',
      messageKey: 'errors.CATALOG_ITEM_INACTIVE',
      params: { catalogItemId: item.id, title: 'Oli MPX2' },
    });
    expect(dump()).toEqual(before);
    expect(invoiceRow(planned.id)).toMatchObject({
      status: 'DRAFT',
      invoice_number: null,
      version: BigInt(planned.version),
    });
    expect(readSaleEntriesForInvoice(h.db, planned.id)).toEqual([]);
    expect(paymentRows(planned.id)).toHaveLength(0);
    expect(count('SELECT COUNT(*) AS n FROM invoice_daily_counters')).toBe(0);
    expect(
      count(
        'SELECT COUNT(*) AS n FROM draft_checkout_allocations WHERE invoice_id = ?',
        planned.id,
      ),
    ).toBe(1);

    const shown = value(await preview(planned.id));
    expect(shown.errors).toEqual([
      {
        code: 'CATALOG_ITEM_INACTIVE',
        params: { catalogItemId: item.id, title: 'Oli MPX2' },
      },
    ]);
    expect(shown.paymentStatusAfterCheckout).toBeNull();

    // Reactivated: it finalizes normally.
    value(await deactivate(item.id, true));
    expect((await finalizeOk(planned)).invoiceNumber).toBe('INV-20260930-0001');
  });

  test('inactive ad-hoc references, mechanics and units do not block', async () => {
    const mechanic = value(
      await h.call<ReferenceDto>(
        C.references.save,
        { entity: 'mechanic', name: 'Joko' },
        ADMIN,
      ),
    );
    const { draft } = await stockedDraft(1);
    let next = await applyOk(draft, {
      kind: 'addCustomLine',
      type: 'SERVICE',
      title: 'Las bracket',
      unitPrice: '35000',
      unitId: serviceUnit,
    });
    next = await applyOk(next, {
      kind: 'updateLine',
      lineId: next.lines[1]!.id,
      mechanicId: mechanic.id,
    });
    h.db.prepare('UPDATE ad_hoc_item_references SET is_active = 0').run();
    h.db
      .prepare('UPDATE mechanics SET is_active = 0 WHERE id = ?')
      .run(mechanic.id);
    h.db
      .prepare('UPDATE units SET is_active = 0 WHERE id IN (?, ?)')
      .run(pcs, serviceUnit);
    expect(value(await preview(next.id)).errors).toEqual([]);
    const view = await finalizeOk(next);
    expect(view.lines.map((l) => [l.title, l.mechanicName])).toEqual([
      ['Oli MPX2', null],
      ['Las bracket', 'Joko'],
    ]);
  });
});

describe('stock', () => {
  test('demand is aggregated per item across lines: one SALE of the sum', async () => {
    const item = await pricedItem('65000');
    await openBalance(item.id, 10);
    let draft = await draftWith([{ itemId: item.id, quantity: 2 }]);
    // An override makes the next add a separate line.
    draft = await applyOk(draft, {
      kind: 'updateLine',
      lineId: draft.lines[0]!.id,
      unitPrice: '60000',
    });
    draft = await applyOk(draft, {
      kind: 'addCatalogLine',
      catalogItemId: item.id,
      quantity: 3,
    });
    expect(draft.lines).toHaveLength(2);
    const view = await finalizeOk(draft);
    expect(view.lines.map((l) => l.quantity)).toEqual([2, 3]);
    expect(
      rows(
        `SELECT movement_type, quantity_delta, reference_type, reference_id, created_by_cashier_id, created_at
         FROM stock_ledger_entries WHERE movement_type = 'SALE'`,
      ),
    ).toEqual([
      {
        movement_type: 'SALE',
        quantity_delta: -5n,
        reference_type: 'INVOICE',
        reference_id: draft.id,
        created_by_cashier_id: cashierId,
        created_at: at(T0),
      },
    ]);
    expect(
      value(
        await h.call<{ quantity: number }>(
          C.inventory.getStock,
          { catalogItemId: item.id },
          CASHIER,
        ),
      ).quantity,
    ).toBe(5);
  });

  test('services, custom lines and untracked items produce no stock entries', async () => {
    const service = await pricedItem('50000', {
      type: 'SERVICE',
      title: 'Servis Ringan',
      unitId: serviceUnit,
    });
    const untracked = await pricedItem('10000', {
      title: 'Stiker',
      trackInventory: false,
    });
    let draft = await draftWith([
      { itemId: service.id },
      { itemId: untracked.id, quantity: 4 },
    ]);
    draft = await applyOk(draft, {
      kind: 'addCustomLine',
      type: 'SERVICE',
      title: 'Las bracket',
      unitPrice: '35000',
    });
    draft = await applyOk(draft, {
      kind: 'addCustomLine',
      type: 'NON_STOCK_ITEM',
      title: 'Baut bekas',
      unitPrice: '5000',
      quantity: 2,
    });
    const shown = value(await preview(draft.id));
    expect(shown.warnings).toEqual([]);
    const view = await finalizeOk(draft);
    expect(view.lines).toHaveLength(4);
    expect(count('SELECT COUNT(*) AS n FROM stock_ledger_entries')).toBe(0);
  });

  test('a negative-stock acknowledgement is bound to the observed balances', async () => {
    const item = await pricedItem('65000', { title: 'Kampas Rem' });
    await openBalance(item.id, 1);
    const draft = await draftWith([{ itemId: item.id, quantity: 3 }]);
    const first = value(await preview(draft.id));
    const warning: FinalizeWarning = {
      code: 'NEGATIVE_STOCK',
      params: {
        catalogItemId: item.id,
        title: 'Kampas Rem',
        observedStock: 1,
        demand: 3,
        resultingStock: -2,
      },
    };
    expect(first.warnings).toEqual([warning]);
    expect(first.errors).toEqual([]);

    // Not acknowledged.
    expect(failure(await finalize(draft)).code).toBe(
      'FINALIZE_WARNINGS_CHANGED',
    );
    // Stock moved after the preview: the old acknowledgement is stale.
    await receive(item.id, 1);
    const before = dump();
    expect(
      failure(await finalize(draft, { acknowledgedWarnings: first.warnings }))
        .code,
    ).toBe('FINALIZE_WARNINGS_CHANGED');
    expect(dump()).toEqual(before);

    const second = value(await preview(draft.id));
    expect(second.warnings).toEqual([
      {
        code: 'NEGATIVE_STOCK',
        params: { ...warning.params, observedStock: 2, resultingStock: -1 },
      },
    ]);
    const view = value(
      await finalize(draft, { acknowledgedWarnings: second.warnings }),
    );
    expect(view.status).toBe('FINALIZED');
    expect(
      value(
        await h.call<{ quantity: number }>(
          C.inventory.getStock,
          { catalogItemId: item.id },
          CASHIER,
        ),
      ).quantity,
    ).toBe(-1);
    // Acknowledging a warning that no longer applies is also a change.
    await receive(item.id, 10);
    const next = await draftWith([{ itemId: item.id }]);
    expect(
      failure(await finalize(next, { acknowledgedWarnings: second.warnings }))
        .code,
    ).toBe('FINALIZE_WARNINGS_CHANGED');
  });
});

describe('warnings from customer and vehicle', () => {
  test('a lower odometer than the previous finalized visit warns but does not block', async () => {
    const item = await pricedItem();
    await openBalance(item.id, 100);
    const andi = await customer('Andi', '081211112222');
    const bike = await vehicle('B 1234 XYZ', andi.id);
    const firstVisit = await draftWith([{ itemId: item.id }], {});
    const visit1 = await applyOk(firstVisit, {
      kind: 'updateHeader',
      changes: { customerId: andi.id, vehicleId: bike.id, odometerKm: 12000 },
    });
    expect(value(await preview(visit1.id)).warnings).toEqual([]);
    await finalizeOk(visit1);

    const secondVisit = await draftWith([{ itemId: item.id }]);
    const visit2 = await applyOk(secondVisit, {
      kind: 'updateHeader',
      changes: { customerId: andi.id, vehicleId: bike.id, odometerKm: 11000 },
    });
    const shown = value(await preview(visit2.id));
    expect(shown.warnings).toEqual([
      {
        code: 'ODOMETER_LOWER_THAN_PREVIOUS',
        params: { previousOdometer: 12000 },
      },
    ]);
    expect(failure(await finalize(visit2)).code).toBe(
      'FINALIZE_WARNINGS_CHANGED',
    );
    const view = value(
      await finalize(visit2, { acknowledgedWarnings: shown.warnings }),
    );
    expect(view.odometerKm).toBe(11000);

    const third = await applyOk(await draftWith([{ itemId: item.id }]), {
      kind: 'updateHeader',
      changes: { vehicleId: bike.id, odometerKm: 12500 },
    });
    expect(value(await preview(third.id)).warnings).toEqual([]);
  });

  test('an owner mismatch is informational and snapshots the selected customer', async () => {
    const item = await pricedItem();
    await openBalance(item.id, 100);
    const owner = await customer('Pemilik');
    const buyer = await customer('Pembeli', '081300000001');
    const bike = await vehicle('D 55 AB', owner.id);
    const draft = await applyOk(await draftWith([{ itemId: item.id }]), {
      kind: 'updateHeader',
      changes: { customerId: buyer.id, vehicleId: bike.id },
    });
    const shown = value(await preview(draft.id));
    expect(shown.warnings).toEqual([
      { code: 'OWNER_MISMATCH', params: { activeOwnerId: owner.id } },
    ]);
    expect(shown.errors).toEqual([]);
    const view = value(
      await finalize(draft, { acknowledgedWarnings: shown.warnings }),
    );
    expect(view.customer).toEqual({
      id: buyer.id,
      name: 'Pembeli',
      phoneNumber: buyer.phoneNumber,
    });
  });
});

describe('payments at checkout', () => {
  test('a zero-total invoice finalizes without payments and is PAID', async () => {
    const item = await pricedItem('50000');
    let draft = await draftWith([{ itemId: item.id }]);
    draft = await applyOk(draft, {
      kind: 'setInvoiceDiscounts',
      stages: [10000],
    });
    expect(draft.totals.amount).toBe('0');
    const view = await finalizeOk(draft);
    expect(view.totals.amount).toBe('0');
    expect(view.payments).toEqual([]);
    expect(view.paymentStatus).toBe('PAID');
    expect(view.paidAmount).toBe('0');
    expect(view.outstandingAmount).toBe('0');
  });

  test('a zero-total invoice clears applied cash without losing received cash', async () => {
    const item = await pricedItem('50000');
    let draft = await draftWith([{ itemId: item.id }]);
    draft = await applyOk(draft, { kind: 'setCashPayment', amount: '50000' });
    draft = await applyOk(draft, {
      kind: 'setInvoiceDiscounts',
      stages: [10000],
    });
    expect(draft.cashReceived).toBe('50000');
    expect(draft.checkoutAllocations).toEqual([]);
    expect((await finalizeOk(draft)).paidAmount).toBe('0');
  });

  test('partial cash payment leaves the remaining amount as credit', async () => {
    const item = await pricedItem('145000');
    let draft = await draftWith([{ itemId: item.id }]);
    draft = await applyOk(draft, { kind: 'setCashPayment', amount: '100000' });
    const view = await finalizeOk(draft);
    expect(view.paymentStatus).toBe('PARTIALLY_PAID');
    expect(view.paidAmount).toBe('100000');
    expect(view.outstandingAmount).toBe('45000');
    expect(view.payments).toMatchObject([{ method: 'CASH', amount: '100000' }]);
  });

  test('full cash with a larger tender stores only the applied amount', async () => {
    const item = await pricedItem('145000');
    let draft = await draftWith([{ itemId: item.id }]);
    // The UI tendered 150000 and showed 5000 change; only 145000 is sent.
    draft = await applyOk(draft, {
      kind: 'setCashPayment',
      amount: '145000',
    });
    const view = await finalizeOk(draft);
    expect(view.paymentStatus).toBe('PAID');
    expect(view.payments.map((p) => p.amount)).toEqual(['145000']);
    expect(view.outstandingAmount).toBe('0');
    const columns = rows('PRAGMA table_info(payments)').map((c) => c.name);
    expect(columns).not.toContain('tendered');
    expect(columns).not.toContain('change');
  });

  test('an anonymous credit sale finalizes UNPAID', async () => {
    const item = await pricedItem('80000');
    const draft = await draftWith([{ itemId: item.id }]);
    const view = await finalizeOk(draft);
    expect(view.customer).toBeNull();
    expect(view.paymentStatus).toBe('UNPAID');
    expect(view.outstandingAmount).toBe('80000');
  });

  test('a discount recap caps cash allocation before finalization', async () => {
    const item = await pricedItem('100000');
    let draft = await draftWith([{ itemId: item.id }]);
    draft = await applyOk(draft, { kind: 'setCashPayment', amount: '100000' });
    draft = await applyOk(draft, {
      kind: 'setInvoiceDiscounts',
      stages: [1000],
    });
    expect(draft.cashReceived).toBe('100000');
    expect(draft.checkoutAllocations).toMatchObject([{ amount: '90000' }]);
    expect((await finalizeOk(draft)).paidAmount).toBe('90000');
  });
});

describe('calculation and snapshots', () => {
  test('critical calculation: 100000 with 30%, 50%, 10% is 31500 persisted and in the view', async () => {
    const item = await pricedItem('100000');
    let draft = await draftWith([{ itemId: item.id }]);
    draft = await applyOk(draft, {
      kind: 'setLineDiscounts',
      lineId: draft.lines[0]!.id,
      stages: [3000, 5000, 1000],
    });
    const view = await finalizeOk(draft);
    expect(view.totals.amount).toBe('31500');
    expect(view.lines[0]!.amount).toBe('31500');
    expect(view.lines[0]!.discounts.map((d) => d.amount)).toEqual([
      '30000',
      '35000',
      '3500',
    ]);
    expect(invoiceRow(draft.id)).toMatchObject({
      subtotal: 100000n,
      discount_amount: 68500n,
      amount: 31500n,
    });
    expect(value(await getInvoice(draft.id))).toEqual(view);
  });

  test('snapshots survive later master-data edits', async () => {
    const mechanic = value(
      await h.call<ReferenceDto>(
        C.references.save,
        { entity: 'mechanic', name: 'Joko' },
        ADMIN,
      ),
    );
    const item = await pricedItem('65000', { title: 'Oli MPX2' });
    const service = await pricedItem('50000', {
      type: 'SERVICE',
      title: 'Servis Ringan',
      unitId: serviceUnit,
    });
    const andi = await customer('Andi', '081211112222');
    const other = await customer('Budi');
    const bike = await vehicle('B 1234 XYZ', andi.id);
    let draft = await draftWith([{ itemId: item.id }, { itemId: service.id }]);
    draft = await applyOk(draft, {
      kind: 'updateLine',
      lineId: draft.lines[1]!.id,
      mechanicId: mechanic.id,
    });
    draft = await applyOk(draft, {
      kind: 'updateHeader',
      changes: { customerId: andi.id, vehicleId: bike.id, odometerKm: 1000 },
    });
    await openBalance(item.id, 5);
    const finalized = await finalizeOk(draft);

    expect(finalized).toMatchObject({
      status: 'FINALIZED',
      channel: { id: bengkel, label: 'Bengkel' },
      customer: { id: andi.id, name: 'Andi', phoneNumber: andi.phoneNumber },
      vehicle: { id: bike.id, plateNumber: 'B 1234 XYZ' },
      cashier: { id: cashierId, displayName: 'Siti' },
      createdBy: { id: cashierId, displayName: 'Siti' },
      shop: {
        name: 'Bengkel Maju Jaya',
        address: 'Jl. Merdeka No. 1, Bandung',
      },
    });
    expect(
      finalized.lines.map((l) => [l.title, l.unitPrice, l.mechanicName]),
    ).toEqual([
      ['Oli MPX2', '65000', null],
      ['Servis Ringan', '50000', 'Joko'],
    ]);
    const rowBefore = invoiceRow(draft.id);
    const linesBefore = rows(
      'SELECT * FROM invoice_items WHERE invoice_id = ?',
      draft.id,
    );

    // Master data changes afterwards.
    nowMs = T0 + HOUR;
    value(
      await h.call(
        C.customers.save,
        { id: andi.id, name: 'Andi Wijaya', phoneNumber: '081299998888' },
        CASHIER,
      ),
    );
    value(
      await h.call(
        C.vehicles.transferOwnership,
        { requestId: uuid(), vehicleId: bike.id, newCustomerId: other.id },
        CASHIER,
      ),
    );
    value(
      await h.call(
        C.catalog.save,
        { id: item.id, type: 'STOCK_ITEM', title: 'Oli Baru', unitId: pcs },
        ADMIN,
      ),
    );
    await setPrice(item.id, '99000', at(T0 + 2 * HOUR));
    value(
      await h.call(
        C.references.save,
        { entity: 'mechanic', id: mechanic.id, name: 'Joko Susilo' },
        ADMIN,
      ),
    );
    value(
      await h.call(
        C.references.save,
        { entity: 'channel', id: bengkel, label: 'Bengkel Pusat' },
        ADMIN,
      ),
    );
    value(
      await h.call(
        C.settings.updateShop,
        {
          name: 'Bengkel Baru',
          address: 'Jl. Lain 2',
          timezone: 'Asia/Jakarta',
        },
        ADMIN,
      ),
    );

    nowMs = T0 + 3 * HOUR;
    expect(value(await getInvoice(draft.id))).toEqual(finalized);
    expect(invoiceRow(draft.id)).toEqual(rowBefore);
    expect(
      rows('SELECT * FROM invoice_items WHERE invoice_id = ?', draft.id),
    ).toEqual(linesBefore);
    expect(JSON.parse(rowBefore.shop_identity_snapshot as string)).toEqual({
      name: 'Bengkel Maju Jaya',
      address: 'Jl. Merdeka No. 1, Bandung',
      phoneNumber: '081234567890',
      email: null,
      invoiceFooter: null,
      logo: null,
    });
    expect(rowBefore).toMatchObject({
      customer_name_snapshot: 'Andi',
      customer_phone_snapshot: andi.phoneNumber,
      plate_number_snapshot: 'B 1234 XYZ',
      channel_label_snapshot: 'Bengkel',
      cashier_name_snapshot: 'Siti',
      cashier_id: cashierId,
    });
  });

  test('the sale is attributed to the finalizing cashier; creator is kept', async () => {
    const item = await pricedItem();
    const draft = await createDraft({}, ADMIN);
    const withLine = await applyOk(
      draft,
      { kind: 'addCatalogLine', catalogItemId: item.id },
      ADMIN,
    );
    const view = await finalizeOk(withLine, { windowId: CASHIER });
    expect(view.cashier).toEqual({ id: cashierId, displayName: 'Siti' });
    expect(view.createdBy).toEqual({ id: adminId, displayName: 'Pak Budi' });
    expect(invoiceRow(draft.id)).toMatchObject({
      cashier_id: cashierId,
      created_by_cashier_id: adminId,
      finalized_at: at(T0),
    });
    const audit = rows(
      `SELECT cashier_id, entity_id, metadata FROM audit_log WHERE action = 'INVOICE_FINALIZED'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      cashier_id: cashierId,
      entity_id: draft.id,
    });
    expect(JSON.parse(audit[0]!.metadata as string)).toMatchObject({
      invoiceNumber: 'INV-20260930-0001',
      amount: '65000',
    });
  });
});

describe('database guards', () => {
  test('stored totals that disagree with the calculation are an internal error and roll back', async () => {
    const { draft } = await stockedDraft(1, '65000');
    // Consistent with the row CHECKs, but not with the lines.
    h.db
      .prepare(
        'UPDATE invoices SET subtotal = subtotal + 1, amount = amount + 1 WHERE id = ?',
      )
      .run(draft.id);
    const before = dump();
    expect(failure(await finalize(draft)).code).toBe('INTERNAL_ERROR');
    expect(dump()).toEqual(before);
  });

  test('payments and finalized financial columns are immutable', async () => {
    const item = await pricedItem('100000');
    let draft = await draftWith([{ itemId: item.id }]);
    draft = await applyOk(draft, {
      kind: 'setCashPayment',
      amount: '40000',
    });
    const view = await finalizeOk(draft);
    const paymentId = view.payments[0]!.id;
    expect(() =>
      h.db
        .prepare('UPDATE payments SET amount = 1 WHERE id = ?')
        .run(paymentId),
    ).toThrow(/append-only/);
    expect(() =>
      h.db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId),
    ).toThrow(/append-only/);
    expect(() =>
      h.db
        .prepare('UPDATE invoices SET amount = 1, subtotal = 1 WHERE id = ?')
        .run(draft.id),
    ).toThrow(/finalized/);
    expect(() =>
      h.db
        .prepare('UPDATE invoices SET invoice_number = ? WHERE id = ?')
        .run('INV-20260930-0999', draft.id),
    ).toThrow(/finalized/);

    const insert = h.db.prepare(
      `INSERT INTO payments (id, invoice_id, method, amount, paid_at, received_by_cashier_id,
         received_by_name_snapshot, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Siti', 'LATER', ?)`,
    );
    // Overpayment: 40000 paid + 60001 > 100000.
    expect(() =>
      insert.run(uuid(), draft.id, 'CASH', 60001n, at(T0), cashierId, at(T0)),
    ).toThrow(/outstanding/);
    expect(() =>
      insert.run(uuid(), draft.id, 'CASH', 0n, at(T0), cashierId, at(T0)),
    ).toThrow(/CHECK/);
    expect(() =>
      insert.run(uuid(), draft.id, 'CHEQUE', 1n, at(T0), cashierId, at(T0)),
    ).toThrow(/CHECK/);
    // Exactly the outstanding amount is accepted by the schema.
    insert.run(uuid(), draft.id, 'QRIS', 60000n, at(T0), cashierId, at(T0));
    expect(count('SELECT COUNT(*) AS n FROM payments')).toBe(2);
  });

  test('the database rejects a payment for a DRAFT or VOID invoice', async () => {
    const item = await pricedItem('100000');
    const draft = await draftWith([{ itemId: item.id }]);
    const insert = h.db.prepare(
      `INSERT INTO payments (id, invoice_id, method, amount, paid_at, received_by_cashier_id,
         received_by_name_snapshot, source, created_at)
       VALUES (?, ?, 'CASH', 1000, ?, ?, 'Siti', 'LATER', ?)`,
    );
    expect(() =>
      insert.run(uuid(), draft.id, at(T0), cashierId, at(T0)),
    ).toThrow(/FINALIZED/);
    await finalizeOk(draft);
    h.db
      .prepare(
        `UPDATE invoices SET status = 'VOID', voided_at = ?, voided_by_cashier_id = ?, void_reason = 'x',
           voided_by_name_snapshot = 'Siti', version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(at(T0), cashierId, at(T0), draft.id);
    expect(() =>
      insert.run(uuid(), draft.id, at(T0), cashierId, at(T0)),
    ).toThrow(/FINALIZED/);
  });

  test('invoice numbers must follow the format', async () => {
    const item = await pricedItem();
    const draft = await draftWith([{ itemId: item.id }]);
    expect(() =>
      h.db
        .prepare(
          `UPDATE invoices SET status = 'FINALIZED', invoice_number = 'X-1', cashier_id = ?,
             finalized_at = ?, channel_label_snapshot = 'B', cashier_name_snapshot = 'S',
             shop_identity_snapshot = '{}' WHERE id = ?`,
        )
        .run(cashierId, at(T0), draft.id),
    ).toThrow(/INV-YYYYMMDD-NNNN/);
  });
});

describe('fault injection', () => {
  async function checkoutDraft() {
    const item = await pricedItem('145000', { title: 'Ban Depan' });
    await openBalance(item.id, 5);
    const service = await pricedItem('50000', {
      type: 'SERVICE',
      title: 'Pasang Ban',
      unitId: serviceUnit,
    });
    const andi = await customer('Andi', '081211112222');
    const bike = await vehicle('B 1234 XYZ', andi.id);
    let draft = await draftWith([
      { itemId: item.id, quantity: 2 },
      { itemId: service.id },
    ]);
    draft = await applyOk(draft, {
      kind: 'updateHeader',
      changes: { customerId: andi.id, vehicleId: bike.id },
    });
    draft = await applyOk(draft, {
      kind: 'setLineDiscounts',
      lineId: draft.lines[0]!.id,
      stages: [1000],
    });
    draft = await applyOk(draft, {
      kind: 'setInvoiceDiscounts',
      stages: [500],
    });
    draft = await applyOk(draft, {
      kind: 'setCashPayment',
      amount: '150000',
    });
    return draft;
  }

  test.each(FINALIZE_STEPS.map((step) => [step]))(
    'a failure after "%s" rolls everything back',
    async (step: FinalizeStep) => {
      const draft = await checkoutDraft();
      const service = new InvoiceService({
        db: h.db,
        clock: { now: () => at(nowMs) },
        onStep: (reached) => {
          if (reached === step) throw new Error(`injected after ${step}`);
        },
      });
      const session = h.services.sessions.get(CASHIER);
      const shown = value(await preview(draft.id));
      const input = finalizeInputSchema.parse({
        requestId: uuid(),
        invoiceId: draft.id,
        expectedVersion: draft.version,
        acknowledgedWarnings: shown.warnings,
      });
      const before = dump();
      expect(() => service.finalize(session, input)).toThrow(
        `injected after ${step}`,
      );
      expect(dump()).toEqual(before);
      const failedAttempt = {
        invoice: invoiceRow(draft.id),
        payments: paymentRows(draft.id),
      };
      expect(failedAttempt.invoice.status).toBe('DRAFT');
      expect(failedAttempt.invoice.version).toBe(BigInt(draft.version));
      expect(failedAttempt.payments).toHaveLength(0);
      expect(
        value(await h.call<DraftView>(C.drafts.get, draft.id, CASHIER)),
      ).toEqual(
        expect.objectContaining({
          version: draft.version,
          checkoutAllocations: draft.checkoutAllocations,
          lines: draft.lines.map((l) =>
            expect.objectContaining({
              id: l.id,
              quantity: l.quantity,
              amount: l.amount,
            }),
          ),
        }),
      );

      // The same request then succeeds and the number was not consumed.
      const view = value(
        await h.call<InvoiceView>(C.invoices.finalize, input, CASHIER),
      );
      expect(view.invoiceNumber).toBe('INV-20260930-0001');
      expect(view.payments).toHaveLength(1);
    },
  );

  test('the step hook sees every write boundary in order', async () => {
    const draft = await checkoutDraft();
    const seen: string[] = [];
    const service = new InvoiceService({
      db: h.db,
      clock: { now: () => at(nowMs) },
      onStep: (step) => seen.push(step),
    });
    const shown = value(await preview(draft.id));
    service.finalize(
      h.services.sessions.get(CASHIER),
      finalizeInputSchema.parse({
        requestId: uuid(),
        invoiceId: draft.id,
        expectedVersion: draft.version,
        acknowledgedWarnings: shown.warnings,
      }),
    );
    expect(seen).toEqual([...FINALIZE_STEPS]);
  });
});

describe('integrity', () => {
  test('every SALE references a finalized/void invoice and matches its tracked demand', async () => {
    const oil = await pricedItem('65000', { title: 'Oli' });
    const pads = await pricedItem('40000', { title: 'Kampas' });
    const service = await pricedItem('50000', {
      type: 'SERVICE',
      title: 'Servis',
      unitId: serviceUnit,
    });
    await openBalance(oil.id, 3);
    await openBalance(pads.id, 3);
    let a = await draftWith([
      { itemId: oil.id, quantity: 2 },
      { itemId: pads.id },
      { itemId: service.id },
    ]);
    a = await applyOk(a, {
      kind: 'updateLine',
      lineId: a.lines[0]!.id,
      unitPrice: '60000',
    });
    a = await applyOk(a, {
      kind: 'addCatalogLine',
      catalogItemId: oil.id,
      quantity: 4,
    });
    await finalizeOk(a);
    await finalizeOk(await draftWith([{ itemId: pads.id, quantity: 2 }]));
    await finalizeOk(await draftWith([{ itemId: service.id }]));
    // An open draft and a discarded draft move no stock.
    await draftWith([{ itemId: oil.id }]);
    const gone = await draftWith([{ itemId: pads.id }]);
    await applyOk(gone, { kind: 'discard' });

    expect(
      rows(
        `SELECT s.id FROM stock_ledger_entries s
         LEFT JOIN invoices i ON i.id = s.reference_id
         WHERE s.movement_type = 'SALE'
           AND (s.reference_type IS NOT 'INVOICE' OR i.status IS NULL OR i.status NOT IN ('FINALIZED', 'VOID'))`,
      ),
    ).toEqual([]);

    const finalized = rows(
      `SELECT id FROM invoices WHERE status = 'FINALIZED'`,
    ).map((r) => r.id as string);
    expect(finalized).toHaveLength(3);
    for (const id of finalized) {
      const demand = rows(
        `SELECT l.catalog_item_id AS item, SUM(l.quantity) AS quantity
         FROM invoice_items l JOIN catalog_items c ON c.id = l.catalog_item_id
         WHERE l.invoice_id = ? AND l.removed_at IS NULL
           AND c.type = 'STOCK_ITEM' AND c.track_inventory = 1
         GROUP BY l.catalog_item_id ORDER BY l.catalog_item_id`,
        id,
      );
      const sales = rows(
        `SELECT catalog_item_id AS item, -quantity_delta AS quantity
         FROM stock_ledger_entries
         WHERE movement_type = 'SALE' AND reference_type = 'INVOICE' AND reference_id = ?
         ORDER BY catalog_item_id`,
        id,
      );
      expect(sales).toEqual(demand);
    }
    expect(
      rows(
        `SELECT catalog_item_id, SUM(quantity_delta) AS stock FROM stock_ledger_entries
         GROUP BY catalog_item_id ORDER BY stock`,
      ).map((r) => r.stock),
    ).toEqual([-3n, 0n]);
  });
});

describe('authorization', () => {
  test('any signed-in cashier may preview, finalize and read; nobody else', async () => {
    const item = await pricedItem();
    const draft = await draftWith([{ itemId: item.id }]);
    expect(failure(await preview(draft.id, NOBODY)).code).toBe(
      'UNAUTHENTICATED',
    );
    expect(failure(await finalize(draft, { windowId: NOBODY })).code).toBe(
      'UNAUTHENTICATED',
    );
    expect(failure(await getInvoice(draft.id, NOBODY)).code).toBe(
      'UNAUTHENTICATED',
    );
    const byAdmin = await finalizeOk(draft, { windowId: ADMIN });
    expect(byAdmin.cashier.id).toBe(adminId);
    expect(value(await getInvoice(draft.id, CASHIER))).toEqual(byAdmin);
    // A draft is not an invoice yet.
    const open = await draftWith([{ itemId: item.id }]);
    expect(failure(await getInvoice(open.id)).code).toBe('INVOICE_NOT_FOUND');
    expect(failure(await getInvoice(uuid())).code).toBe('INVOICE_NOT_FOUND');
    expect(
      failure(
        await h.call(
          C.invoices.finalize,
          { invoiceId: draft.id, expectedVersion: 1, acknowledgedWarnings: [] },
          CASHIER,
        ),
      ).code,
    ).toBe('VALIDATION_FAILED');
  });
});

describe('optional sales and expedition selections', () => {
  test('retains deactivated selections, resolves draft renames and freezes issued names', async () => {
    const sales = value(
      await h.call<ReferenceDto>(
        C.references.save,
        { entity: 'sales', code: '001', label: 'Sales original' },
        ADMIN,
      ),
    );
    const expedition = value(
      await h.call<ReferenceDto>(
        C.references.save,
        { entity: 'expedition', code: '001', label: 'Expedition original' },
        ADMIN,
      ),
    );
    let { draft } = await stockedDraft();
    expect(draft).toMatchObject({ sales: null, expedition: null });
    draft = await applyOk(draft, {
      kind: 'updateHeader',
      changes: { salesId: sales.id, expeditionId: expedition.id },
    });
    expect(draft).toMatchObject({
      sales: { id: sales.id, name: sales.label },
      expedition: { id: expedition.id, name: expedition.label },
    });
    value(
      await h.call(
        C.references.deactivate,
        { entity: 'sales', id: sales.id },
        ADMIN,
      ),
    );
    value(
      await h.call(
        C.references.save,
        { entity: 'sales', id: sales.id, label: 'Sales at issue' },
        ADMIN,
      ),
    );
    draft = value(await h.call<DraftView>(C.drafts.get, draft.id, CASHIER));
    expect(draft.sales?.name).toBe('Sales at issue');
    h.reopen();
    await login('siti', 'siti-password-1', CASHIER);
    expect(
      value(await h.call<DraftView>(C.drafts.get, draft.id, CASHIER)).sales?.id,
    ).toBe(sales.id);
    await login('admin', ADMIN_PASSWORD, ADMIN);
    draft = await applyOk(draft, {
      kind: 'updateHeader',
      changes: { note: 'Retain references' },
    });
    const issued = await finalizeOk(draft);
    expect(issued.sales?.name).toBe('Sales at issue');
    expect(issued.expedition?.name).toBe('Expedition original');
    value(
      await h.call(
        C.references.save,
        { entity: 'sales', id: sales.id, label: 'Sales later' },
        ADMIN,
      ),
    );
    const reread = value(
      await h.call<InvoiceView>(
        C.invoices.get,
        { invoiceId: issued.id },
        CASHIER,
      ),
    );
    expect(reread.sales?.name).toBe('Sales at issue');
    for (const column of [
      'sales_id',
      'expedition_id',
      'sales_name_snapshot',
      'expedition_name_snapshot',
    ]) {
      expect(() =>
        h.db
          .prepare(`UPDATE invoices SET ${column} = NULL WHERE id = ?`)
          .run(issued.id),
      ).toThrow();
    }
  });
  test('independent selection, clearing, inactive and missing IDs, stale versions', async () => {
    const master = value(
      await h.call<ReferenceDto>(
        C.references.save,
        { entity: 'sales', code: '001', label: 'Sales' },
        ADMIN,
      ),
    );
    const original = await createDraft();
    let draft = await applyOk(original, {
      kind: 'updateHeader',
      changes: { salesId: master.id },
    });
    expect(draft.expedition).toBeNull();
    const apply = (version: number, changes: Record<string, unknown>) =>
      h.call<DraftView>(
        C.drafts.apply,
        {
          requestId: uuid(),
          invoiceId: draft.id,
          expectedVersion: version,
          op: { kind: 'updateHeader', changes },
        },
        CASHIER,
      );
    expect(failure(await apply(original.version, { salesId: null })).code).toBe(
      'DRAFT_VERSION_CONFLICT',
    );
    draft = await applyOk(draft, {
      kind: 'updateHeader',
      changes: { salesId: null },
    });
    expect(draft.sales).toBeNull();
    value(
      await h.call(
        C.references.deactivate,
        { entity: 'sales', id: master.id },
        ADMIN,
      ),
    );
    expect(
      failure(await apply(draft.version, { salesId: master.id })).code,
    ).toBe('REFERENCE_INACTIVE');
    expect(
      failure(await apply(draft.version, { expeditionId: uuid() })).code,
    ).toBe('REFERENCE_NOT_FOUND');
  });
});

test('finalization retains the number reserved when the draft was created', async () => {
  const { draft } = await stockedDraft();
  h.db
    .prepare(
      "UPDATE invoices SET reserved_invoice_number = 'INV-20260930-0042' WHERE id = ?",
    )
    .run(draft.id);
  const invoice = await finalizeOk(draft);
  expect(invoice.invoiceNumber).toBe('INV-20260930-0042');
});

test('grouped zero warning covers all sources and ignores removed and discounted positive items', async () => {
  const unpriced = await newItem({ title: 'Unpriced' });
  const listed = await pricedItem('0', { title: 'Listed zero' });
  const paid = await pricedItem('100', { title: 'Discounted' });
  let draft = await createDraft();
  for (const catalogItemId of [unpriced.id, listed.id])
    draft = await applyOk(draft, { kind: 'addCatalogLine', catalogItemId });
  draft = await applyOk(draft, {
    kind: 'addCatalogLine',
    catalogItemId: paid.id,
  });
  draft = await applyOk(draft, {
    kind: 'updateLine',
    lineId: draft.lines.at(-1)!.id,
    unitPrice: '0',
  });
  draft = await applyOk(draft, {
    kind: 'addCustomLine',
    type: 'SERVICE',
    title: 'Free service',
    quantity: 2,
    unitPrice: '0',
  });
  const storedZeroPrices = [null, '0', '100', null];
  const zeros = draft.lines.map((line, index) => ({
    lineId: line.id,
    title: line.title,
    quantity: line.quantity,
    storedUnitPrice: storedZeroPrices[index],
  }));
  draft = await applyOk(draft, {
    kind: 'addCatalogLine',
    catalogItemId: paid.id,
  });
  draft = await applyOk(draft, {
    kind: 'setLineDiscounts',
    lineId: draft.lines.at(-1)!.id,
    stages: [10000],
  });
  draft = await applyOk(draft, {
    kind: 'addCustomLine',
    type: 'SERVICE',
    title: 'Removed',
    unitPrice: '0',
  });
  draft = await applyOk(draft, {
    kind: 'removeLine',
    lineId: draft.lines.at(-1)!.id,
  });
  const shown = value(await preview(draft.id));
  expect(shown.errors).toEqual([]);
  expect(shown.warnings).toContainEqual({
    code: 'ZERO_UNIT_PRICE',
    params: { lines: zeros },
  });
  expect(failure(await finalize(draft)).code).toBe('FINALIZE_WARNINGS_CHANGED');
  expect(
    value(await finalize(draft, { acknowledgedWarnings: shown.warnings }))
      .status,
  ).toBe('FINALIZED');
});

test('stored price mismatch is grouped and cannot be finalized without acknowledgment', async () => {
  const item = await pricedItem('70000');
  let draft = await createDraft();
  draft = await applyOk(draft, {
    kind: 'addCatalogLine',
    catalogItemId: item.id,
  });
  draft = await applyOk(draft, {
    kind: 'updateLine',
    lineId: draft.lines[0]!.id,
    unitPrice: '65000',
  });
  const shown = value(await preview(draft.id));
  expect(shown.warnings).toContainEqual({
    code: 'PRICE_DIFFERS_FROM_STORED',
    params: {
      lines: [
        {
          lineId: draft.lines[0]!.id,
          title: draft.lines[0]!.title,
          quantity: 1,
          storedUnitPrice: '70000',
          unitPrice: '65000',
        },
      ],
    },
  });
});

test('stored price changes after preview require a fresh acknowledgment', async () => {
  const item = await pricedItem('70000');
  let draft = await draftWith([{ itemId: item.id }]);
  draft = await applyOk(draft, {
    kind: 'updateLine',
    lineId: draft.lines[0]!.id,
    unitPrice: '65000',
  });
  const before = value(await preview(draft.id));
  await setPrice(item.id, '75000', at(T0 - 1000));
  expect(
    failure(await finalize(draft, { acknowledgedWarnings: before.warnings }))
      .code,
  ).toBe('FINALIZE_WARNINGS_CHANGED');
  const after = value(await preview(draft.id));
  expect(after.warnings).toContainEqual(
    expect.objectContaining({
      code: 'PRICE_DIFFERS_FROM_STORED',
      params: {
        lines: [expect.objectContaining({ storedUnitPrice: '75000' })],
      },
    }),
  );
  expect(
    value(await finalize(draft, { acknowledgedWarnings: after.warnings }))
      .status,
  ).toBe('FINALIZED');
});
