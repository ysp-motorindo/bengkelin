import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApplicationServices } from '@/main/compose';
import { openDatabase, type AppDatabase } from '@/main/database/connection';
import {
  bundledMigrations,
  migrateDatabase,
  readSchemaVersion,
} from '@/main/database/migrate';
import type { Session } from '@/main/features/auth/sessions';
import { InvoiceService } from '@/main/features/invoices/service';
import {
  normalizePhone,
  normalizePlate,
} from '@/main/features/vehicles/normalization';
import { executeCommand } from '@/main/platform/command';
import { buildCommands } from '@/main/platform/commands';
import { CHANNELS } from '@/shared/channels';
import type {
  CatalogItemDto,
  DraftOperation,
  DraftView,
  FinalizePreviewDto,
  InvoicePage,
  InvoiceSearchFilters,
  InvoiceView,
  PricePreviewDto,
  ReceivablesPage,
  ReferenceDto,
  SaveCustomerResult,
  SaveVehicleResult,
} from '@/shared/contracts';
import type { Instant, Result } from '@/shared/primitives';
import { toInstant } from '@/shared/time';
import {
  ADMIN_PASSWORD,
  createHarness,
  failure,
  validSetup,
  value,
  type Harness,
} from './helpers/harness';

/**
 * Task 11: later payments, voids, receivables and history. Shop timezone is
 * Asia/Jakarta (UTC+7); the clock is injected. T0 = 2026-09-30 10:00 WIB.
 */

const C = CHANNELS;
const ADMIN = 1;
const CASHIER = 2;
const NOBODY = 99;
const T0 = Date.UTC(2026, 8, 30, 3, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
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

async function loginBoth() {
  adminId = await login('admin', ADMIN_PASSWORD, ADMIN);
  cashierId = await login('siti', 'siti-password-1', CASHIER);
}

beforeEach(async () => {
  nowMs = T0;
  counter = 0;
  itemSeq = 0;
  defaultItem = undefined;
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
  shopee = channels.find((c) => c.code === 'SHOPEE')!.id;
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

function errorOf<T>(result: Result<T>) {
  if (result.ok) throw new Error('Expected an error result');
  return result;
}

// ---- master data ----

let itemSeq = 0;
async function pricedItem(price: string, stock = 100) {
  itemSeq += 1;
  const item = value(
    await h.call<CatalogItemDto>(
      C.catalog.save,
      { type: 'STOCK_ITEM', title: `Barang ${itemSeq}`, unitId: pcs },
      ADMIN,
    ),
  );
  for (const channelId of [bengkel, shopee]) {
    const preview = value(
      await h.call<PricePreviewDto>(
        C.catalog.previewPriceChange,
        {
          catalogItemId: item.id,
          channelId,
          effectiveStartAt: at(T0 - 30 * DAY),
          price,
        },
        ADMIN,
      ),
    );
    value(
      await h.call(C.catalog.applyPriceChange, { token: preview.token }, ADMIN),
    );
  }
  if (stock > 0) {
    value(
      await h.call(
        C.inventory.openBalance,
        { requestId: uuid(), catalogItemId: item.id, quantity: stock },
        ADMIN,
      ),
    );
  }
  return item;
}

async function serviceItem(price: string) {
  const item = value(
    await h.call<CatalogItemDto>(
      C.catalog.save,
      { type: 'SERVICE', title: 'Servis ringan', unitId: serviceUnit },
      ADMIN,
    ),
  );
  const preview = value(
    await h.call<PricePreviewDto>(
      C.catalog.previewPriceChange,
      {
        catalogItemId: item.id,
        channelId: bengkel,
        effectiveStartAt: at(T0 - 30 * DAY),
        price,
      },
      ADMIN,
    ),
  );
  value(
    await h.call(C.catalog.applyPriceChange, { token: preview.token }, ADMIN),
  );
  return item;
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

// ---- issuing invoices ----

interface IssueOptions {
  lines?: { itemId: string; quantity?: number }[];
  customerId?: string;
  vehicleId?: string;
  channelId?: string;
  invoiceDate?: string;
  topDays?: number;
  /** Checkout payments (become CHECKOUT payments at finalization). */
  pay?: string[];
  windowId?: number;
}

let defaultItem: CatalogItemDto | undefined;

/** Creates a draft and finalizes it; returns the issued InvoiceView. */
async function issue(options: IssueOptions = {}): Promise<InvoiceView> {
  const windowId = options.windowId ?? CASHIER;
  defaultItem ??= await pricedItem('100000');
  const lines = options.lines ?? [{ itemId: defaultItem.id }];
  let draft = value(
    await h.call<DraftView>(
      C.drafts.create,
      {
        requestId: uuid(),
        channelId: options.channelId ?? bengkel,
        invoiceDate: options.invoiceDate ?? '2026-09-30',
        pricingAt: at(nowMs),
      },
      windowId,
    ),
  );
  const apply = async (op: DraftOperation) => {
    draft = value(
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
  };
  for (const line of lines) {
    await apply({
      kind: 'addCatalogLine',
      catalogItemId: line.itemId,
      ...(line.quantity ? { quantity: line.quantity } : {}),
    });
  }
  const changes: Record<string, unknown> = {};
  if (options.customerId) changes.customerId = options.customerId;
  if (options.vehicleId) changes.vehicleId = options.vehicleId;
  if (options.topDays !== undefined) changes.topDays = options.topDays;
  if (Object.keys(changes).length > 0) {
    await apply({ kind: 'updateHeader', changes } as DraftOperation);
  }
  if (options.pay?.length) {
    await apply({
      kind: 'setCheckoutAllocations',
      allocations: options.pay.map((amount) => ({ method: 'CASH', amount })),
    });
  }
  const shown = value(
    await h.call<FinalizePreviewDto>(
      C.invoices.previewFinalize,
      { invoiceId: draft.id },
      windowId,
    ),
  );
  expect(shown.errors).toEqual([]);
  return value(
    await h.call<InvoiceView>(
      C.invoices.finalize,
      {
        requestId: uuid(),
        invoiceId: draft.id,
        expectedVersion: shown.draftVersion,
        acknowledgedWarnings: shown.warnings,
      },
      windowId,
    ),
  );
}

// ---- T11 commands ----

function pay(
  invoiceId: string,
  amount: string,
  options: {
    requestId?: string;
    method?: string;
    reference?: string;
    note?: string;
    windowId?: number;
  } = {},
) {
  return h.call<InvoiceView>(
    C.invoices.recordPayment,
    {
      requestId: options.requestId ?? uuid(),
      invoiceId,
      method: options.method ?? 'CASH',
      amount,
      ...(options.reference !== undefined
        ? { reference: options.reference }
        : {}),
      ...(options.note !== undefined ? { note: options.note } : {}),
    },
    options.windowId ?? CASHIER,
  );
}

function voidInvoice(
  invoiceId: string,
  reason: string,
  options: { requestId?: string; windowId?: number } = {},
) {
  return h.call<InvoiceView>(
    C.invoices.void,
    { requestId: options.requestId ?? uuid(), invoiceId, reason },
    options.windowId ?? CASHIER,
  );
}

function search(
  filters: InvoiceSearchFilters = {},
  page?: { number?: number; size?: number },
  windowId = CASHIER,
) {
  return h.call<InvoicePage>(
    C.invoices.search,
    { filters, ...(page ? { page } : {}) },
    windowId,
  );
}

async function numbersOf(filters: InvoiceSearchFilters) {
  return value(await search(filters, { size: 100 }))
    .items.map((row) => row.invoiceNumber)
    .sort();
}

function receivables(
  kind: 'OUTSTANDING' | 'OVERDUE',
  page?: { number?: number; size?: number },
) {
  return h.call<ReceivablesPage>(
    C.invoices.receivables,
    { kind, ...(page ? { page } : {}) },
    CASHIER,
  );
}

const getInvoice = (invoiceId: string, windowId = CASHIER) =>
  h.call<InvoiceView>(C.invoices.get, { invoiceId }, windowId);

const reversalCount = (invoiceId: string) =>
  count(
    `SELECT COUNT(*) AS n FROM stock_ledger_entries
     WHERE movement_type = 'VOID_REVERSAL' AND reference_type = 'INVOICE' AND reference_id = ?`,
    invoiceId,
  );
const paymentCount = (invoiceId: string) =>
  count('SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?', invoiceId);
const stockOf = async (catalogItemId: string) =>
  value(
    await h.call<{ quantity: number }>(
      C.inventory.getStock,
      { catalogItemId },
      CASHIER,
    ),
  ).quantity;

/** Everything a payment or void could touch, for "nothing changed" checks. */
function dump() {
  return {
    invoices: rows('SELECT * FROM invoices ORDER BY id'),
    payments: rows('SELECT * FROM payments ORDER BY id'),
    ledger: rows('SELECT * FROM stock_ledger_entries ORDER BY id'),
    audit: rows('SELECT * FROM audit_log ORDER BY id'),
    receipts: rows('SELECT * FROM command_receipts ORDER BY request_id'),
  };
}

// =====================================================================

describe('later payments', () => {
  test('partial payments reach PAID, with receiver, time and source LATER', async () => {
    const invoice = await issue({ topDays: 7 });
    expect(invoice.paymentStatus).toBe('UNPAID');

    nowMs = T0 + HOUR;
    const first = value(
      await pay(invoice.id, '30000', {
        method: 'BANK_TRANSFER',
        reference: '  TRF-001 ',
        note: 'Cicilan 1',
      }),
    );
    expect(first.paymentStatus).toBe('PARTIALLY_PAID');
    expect(first.paidAmount).toBe('30000');
    expect(first.outstandingAmount).toBe('70000');
    expect(first.payments).toEqual([
      {
        id: expect.any(String),
        method: 'BANK_TRANSFER',
        amount: '30000',
        paidAt: at(T0 + HOUR),
        reference: 'TRF-001',
        note: 'Cicilan 1',
        receivedBy: { id: cashierId, displayName: 'Siti' },
        source: 'LATER',
      },
    ]);
    // The invoice header is untouched by a payment.
    expect(first.version).toBe(invoice.version);
    expect(first.totals).toEqual(invoice.totals);

    nowMs = T0 + 2 * DAY;
    const second = value(
      await pay(invoice.id, '70000', { method: 'QRIS', windowId: ADMIN }),
    );
    expect(second.paymentStatus).toBe('PAID');
    expect(second.paidAmount).toBe('100000');
    expect(second.outstandingAmount).toBe('0');
    expect(second.payments.map((p) => [p.amount, p.receivedBy])).toEqual([
      ['30000', { id: cashierId, displayName: 'Siti' }],
      ['70000', { id: adminId, displayName: 'Pak Budi' }],
    ]);
    expect(value(await getInvoice(invoice.id))).toEqual(second);

    expect(
      rows(
        `SELECT amount, paid_at, source, received_by_cashier_id, received_by_name_snapshot, reference, note
         FROM payments WHERE invoice_id = ? ORDER BY rowid`,
        invoice.id,
      ),
    ).toEqual([
      {
        amount: 30000n,
        paid_at: at(T0 + HOUR),
        source: 'LATER',
        received_by_cashier_id: cashierId,
        received_by_name_snapshot: 'Siti',
        reference: 'TRF-001',
        note: 'Cicilan 1',
      },
      {
        amount: 70000n,
        paid_at: at(T0 + 2 * DAY),
        source: 'LATER',
        received_by_cashier_id: adminId,
        received_by_name_snapshot: 'Pak Budi',
        reference: null,
        note: null,
      },
    ]);
    const audit = rows(
      `SELECT cashier_id, action, entity_type, entity_id, metadata FROM audit_log
       WHERE action = 'INVOICE_PAYMENT_RECORDED' ORDER BY id`,
    );
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      cashier_id: cashierId,
      entity_type: 'invoice',
      entity_id: invoice.id,
    });
    expect(JSON.parse(audit[0]!.metadata as string)).toMatchObject({
      invoiceNumber: invoice.invoiceNumber,
      method: 'BANK_TRANSFER',
      amount: '30000',
      outstandingAmount: '70000',
    });
  });

  test('a later payment adds to checkout payments', async () => {
    const invoice = await issue({ pay: ['40000'], topDays: 3 });
    expect(invoice.paymentStatus).toBe('PARTIALLY_PAID');
    const paid = value(await pay(invoice.id, '60000'));
    expect(paid.paymentStatus).toBe('PAID');
    expect(paid.payments.map((p) => p.source)).toEqual(['CHECKOUT', 'LATER']);
  });

  test('overpayment is rejected and nothing is written', async () => {
    const invoice = await issue({ topDays: 7 });
    value(await pay(invoice.id, '25000'));
    const before = dump();
    const overpayment = errorOf(await pay(invoice.id, '75001'));
    expect(overpayment.error.code).toBe('PAYMENT_EXCEEDS_OUTSTANDING');
    expect(overpayment.error.messageKey).toBe(
      'errors.PAYMENT_EXCEEDS_OUTSTANDING',
    );
    expect(overpayment.error.params).toEqual({ outstandingAmount: '75000' });
    expect(dump()).toEqual(before);

    // Exactly the outstanding amount is fine; after that even Rp 1 is refused.
    expect(value(await pay(invoice.id, '75000')).paymentStatus).toBe('PAID');
    const onPaid = failure(await pay(invoice.id, '1'));
    expect(onPaid.code).toBe('PAYMENT_EXCEEDS_OUTSTANDING');
    expect(onPaid.params).toEqual({ outstandingAmount: '0' });

    // A zero or malformed amount never reaches the service.
    for (const amount of ['0', '-1', '1.5', 'abc']) {
      expect(failure(await pay(invoice.id, amount)).code).toBe(
        'VALIDATION_FAILED',
      );
    }
  });

  test('a zero-total invoice is PAID and refuses payments', async () => {
    const free = await pricedItem('0');
    const invoice = await issue({ lines: [{ itemId: free.id }] });
    expect(invoice.paymentStatus).toBe('PAID');
    expect(failure(await pay(invoice.id, '1')).code).toBe(
      'PAYMENT_EXCEEDS_OUTSTANDING',
    );
  });

  test('payment on a VOID, DRAFT or unknown invoice is rejected', async () => {
    const invoice = await issue({ topDays: 7 });
    value(await voidInvoice(invoice.id, 'Salah input'));
    const before = dump();
    expect(failure(await pay(invoice.id, '1000')).code).toBe('INVOICE_VOID');
    expect(dump()).toEqual(before);

    const draft = value(
      await h.call<DraftView>(
        C.drafts.create,
        {
          requestId: uuid(),
          channelId: bengkel,
          invoiceDate: '2026-09-30',
          pricingAt: at(nowMs),
        },
        CASHIER,
      ),
    );
    expect(failure(await pay(draft.id, '1000')).code).toBe(
      'INVOICE_NOT_FINALIZED',
    );
    expect(failure(await pay(uuid(), '1000')).code).toBe('INVOICE_NOT_FOUND');
  });

  test('a retried payment (same requestId) has one effect', async () => {
    const invoice = await issue({ topDays: 7 });
    const requestId = uuid();
    const first = value(await pay(invoice.id, '40000', { requestId }));
    nowMs += MINUTE;
    const retry = value(await pay(invoice.id, '40000', { requestId }));
    expect(retry).toEqual(first);
    const retriedPayment = { paymentCount: paymentCount(invoice.id) };
    expect(retriedPayment.paymentCount).toBe(1);
    expect(
      count(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'INVOICE_PAYMENT_RECORDED'`,
      ),
    ).toBe(1);
    // The same key for a different payment is refused, not replayed.
    expect(failure(await pay(invoice.id, '40001', { requestId })).code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(paymentCount(invoice.id)).toBe(1);
  });

  test('double click: two submissions for the full outstanding amount pay once', async () => {
    const invoice = await issue({ topDays: 7 });
    const [a, b] = await Promise.all([
      pay(invoice.id, '100000'),
      pay(invoice.id, '100000'),
    ]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const rejected = results.find((r) => !r.ok)!;
    expect(errorOf(rejected).error.code).toBe('PAYMENT_EXCEEDS_OUTSTANDING');
    expect(paymentCount(invoice.id)).toBe(1);
    expect(value(await getInvoice(invoice.id)).paymentStatus).toBe('PAID');
  });

  test('lost responses: payment and void retried after an app restart replay', async () => {
    const credit = await issue({ topDays: 7 });
    const toVoid = await issue({ topDays: 7 });
    const payRequest = uuid();
    const voidRequest = uuid();
    // The responses are "lost": the renderer never saw them.
    const paid = value(
      await pay(credit.id, '100000', { requestId: payRequest }),
    );
    const voided = value(
      await voidInvoice(toVoid.id, 'Pelanggan batal', {
        requestId: voidRequest,
      }),
    );
    const before = dump();

    h.reopen();
    nowMs += HOUR;
    await loginBoth();
    const loginAudit = rows('SELECT * FROM audit_log ORDER BY id').length;

    expect(
      value(await pay(credit.id, '100000', { requestId: payRequest })),
    ).toEqual(paid);
    expect(
      value(
        await voidInvoice(toVoid.id, 'Pelanggan batal', {
          requestId: voidRequest,
        }),
      ),
    ).toEqual(voided);
    const after = dump();
    expect(after.payments).toEqual(before.payments);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.invoices).toEqual(before.invoices);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.audit).toHaveLength(loginAudit);
  });

  test('every T11 channel requires a session', async () => {
    const invoice = await issue();
    for (const [channel, input] of [
      [
        C.invoices.recordPayment,
        {
          requestId: uuid(),
          invoiceId: invoice.id,
          method: 'CASH',
          amount: '1',
        },
      ],
      [
        C.invoices.void,
        { requestId: uuid(), invoiceId: invoice.id, reason: 'x' },
      ],
      [C.invoices.search, { filters: {} }],
      [C.invoices.receivables, { kind: 'OUTSTANDING' }],
    ] as const) {
      expect(failure(await h.call(channel, input, NOBODY)).code).toBe(
        'UNAUTHENTICATED',
      );
    }
  });
});

// =====================================================================

describe('void', () => {
  test('a CASHIER voids an unpaid invoice: VOID marking, exact reversal, audit', async () => {
    const oil = await pricedItem('50000', 10);
    const filter = await pricedItem('25000', 5);
    const labour = await serviceItem('30000');
    const invoice = await issue({
      lines: [
        { itemId: oil.id, quantity: 2 },
        { itemId: filter.id },
        { itemId: labour.id },
        { itemId: oil.id, quantity: 1 },
      ],
      topDays: 14,
    });
    expect(await stockOf(oil.id)).toBe(7);
    expect(await stockOf(filter.id)).toBe(4);

    nowMs = T0 + 3 * HOUR;
    const voided = value(await voidInvoice(invoice.id, '  Salah input  '));
    expect(voided.status).toBe('VOID');
    expect(voided.void).toEqual({
      voidedAt: at(T0 + 3 * HOUR),
      voidedBy: { id: cashierId, displayName: 'Siti' },
      reason: 'Salah input',
    });
    expect(voided.version).toBe(invoice.version + 1);
    // Number, lines, totals, payments and snapshots are preserved.
    const { status: _s, version: _v, void: _vd, ...kept } = voided;
    const { status: _s0, version: _v0, void: _vd0, ...original } = invoice;
    expect(kept).toEqual(original);

    expect(await stockOf(oil.id)).toBe(10);
    expect(await stockOf(filter.id)).toBe(5);
    const reversals = rows(
      `SELECT r.catalog_item_id, r.quantity_delta, r.reverses_entry_id, s.quantity_delta AS sale_delta,
         r.created_by_cashier_id, r.created_at
       FROM stock_ledger_entries r JOIN stock_ledger_entries s ON s.id = r.reverses_entry_id
       WHERE r.movement_type = 'VOID_REVERSAL' AND r.reference_id = ?
       ORDER BY r.quantity_delta`,
      invoice.id,
    );
    expect(reversals).toEqual([
      {
        catalog_item_id: filter.id,
        quantity_delta: 1n,
        reverses_entry_id: expect.any(String),
        sale_delta: -1n,
        created_by_cashier_id: cashierId,
        created_at: at(T0 + 3 * HOUR),
      },
      {
        catalog_item_id: oil.id,
        quantity_delta: 3n,
        reverses_entry_id: expect.any(String),
        sale_delta: -3n,
        created_by_cashier_id: cashierId,
        created_at: at(T0 + 3 * HOUR),
      },
    ]);
    expect(
      rows(
        `SELECT status, voided_at, voided_by_cashier_id, voided_by_name_snapshot, void_reason
         FROM invoices WHERE id = ?`,
        invoice.id,
      ),
    ).toEqual([
      {
        status: 'VOID',
        voided_at: at(T0 + 3 * HOUR),
        voided_by_cashier_id: cashierId,
        voided_by_name_snapshot: 'Siti',
        void_reason: 'Salah input',
      },
    ]);
    const audit = rows(
      `SELECT cashier_id, entity_id, metadata FROM audit_log WHERE action = 'INVOICE_VOIDED'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      cashier_id: cashierId,
      entity_id: invoice.id,
    });
    expect(JSON.parse(audit[0]!.metadata as string)).toMatchObject({
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.totals.amount,
      reversalCount: 2,
      reason: 'Salah input',
    });
    expect(value(await getInvoice(invoice.id, ADMIN))).toEqual(voided);
  });

  test('an ADMIN voids an unpaid invoice (and one with no stock lines)', async () => {
    const labour = await serviceItem('30000');
    const invoice = await issue({ lines: [{ itemId: labour.id }] });
    const voided = value(
      await voidInvoice(invoice.id, 'Dobel input', { windowId: ADMIN }),
    );
    expect(voided.void?.voidedBy).toEqual({
      id: adminId,
      displayName: 'Pak Budi',
    });
    expect(reversalCount(invoice.id)).toBe(0);
  });

  test('the reason is required', async () => {
    const invoice = await issue();
    const before = dump();
    for (const reason of ['', '   ']) {
      expect(failure(await voidInvoice(invoice.id, reason)).code).toBe(
        'VOID_REASON_REQUIRED',
      );
    }
    expect(dump()).toEqual(before);
    expect(failure(await voidInvoice(invoice.id, 'x'.repeat(501))).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  test('any payment, including partial, blocks the void', async () => {
    const partial = await issue({ topDays: 7 });
    value(await pay(partial.id, '1'));
    const before = dump();
    const paidVoid = errorOf(await voidInvoice(partial.id, 'Batal'));
    expect(paidVoid.error.code).toBe('PAID_INVOICE_CANNOT_BE_VOIDED');
    expect(dump()).toEqual(before);

    const checkoutPaid = await issue({ pay: ['100000'] });
    expect(
      failure(await voidInvoice(checkoutPaid.id, 'Batal', { windowId: ADMIN }))
        .code,
    ).toBe('PAID_INVOICE_CANNOT_BE_VOIDED');
    expect(value(await getInvoice(checkoutPaid.id)).status).toBe('FINALIZED');
    // The schema refuses it too.
    expect(() =>
      h.db
        .prepare(
          `UPDATE invoices SET status = 'VOID', voided_at = ?, voided_by_cashier_id = ?,
             voided_by_name_snapshot = 'Siti', void_reason = 'x' WHERE id = ?`,
        )
        .run(at(nowMs), cashierId, partial.id),
    ).toThrow(/payments cannot be voided/);
  });

  test('void reverses stock exactly once: retry replays, a new request is ALREADY_VOID', async () => {
    const oil = await pricedItem('50000', 10);
    const invoice = await issue({ lines: [{ itemId: oil.id, quantity: 4 }] });
    const requestId = uuid();
    const first = value(await voidInvoice(invoice.id, 'Salah', { requestId }));
    nowMs += MINUTE;
    const again = value(await voidInvoice(invoice.id, 'Salah', { requestId }));
    expect(again).toEqual(first);
    const voidRetry = { reversalCount: reversalCount(invoice.id) };
    expect(voidRetry.reversalCount).toBe(1);

    const before = dump();
    expect(failure(await voidInvoice(invoice.id, 'Salah')).code).toBe(
      'INVOICE_ALREADY_VOID',
    );
    expect(dump()).toEqual(before);
    expect(reversalCount(invoice.id)).toBe(1);
    expect(await stockOf(oil.id)).toBe(10);
    expect(
      count(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'INVOICE_VOIDED'`,
      ),
    ).toBe(1);
  });

  test('VOID is terminal and keeps number and totals', async () => {
    const invoice = await issue({ topDays: 7 });
    value(await voidInvoice(invoice.id, 'Salah'));
    const view = value(await getInvoice(invoice.id));
    expect(view.invoiceNumber).toBe(invoice.invoiceNumber);
    expect(view.totals).toEqual(invoice.totals);
    expect(view.lines).toEqual(invoice.lines);
    expect(() =>
      h.db
        .prepare(`UPDATE invoices SET void_reason = 'lain' WHERE id = ?`)
        .run(invoice.id),
    ).toThrow(/void invoice/);
    // The number is never reused: the next invoice gets the next number.
    const next = await issue();
    expect(next.invoiceNumber).toBe('INV-20260930-0002');
  });

  test('a draft or an unknown id cannot be voided', async () => {
    const draft = value(
      await h.call<DraftView>(
        C.drafts.create,
        {
          requestId: uuid(),
          channelId: bengkel,
          invoiceDate: '2026-09-30',
          pricingAt: at(nowMs),
        },
        CASHIER,
      ),
    );
    expect(failure(await voidInvoice(draft.id, 'x')).code).toBe(
      'INVOICE_NOT_FINALIZED',
    );
    expect(failure(await voidInvoice(uuid(), 'x')).code).toBe(
      'INVOICE_NOT_FOUND',
    );
  });
});

// =====================================================================

describe('payment / void race (two connections, BEGIN IMMEDIATE)', () => {
  let other: AppDatabase;
  let otherService: InvoiceService;
  const session = (): Session => ({
    windowId: 7,
    cashierId: adminId,
    username: 'admin',
    displayName: 'Pak Budi',
    role: 'ADMIN',
  });

  beforeEach(() => {
    other = openDatabase(h.file);
    otherService = new InvoiceService({
      db: other,
      clock: { now: () => toInstant(nowMs) },
    });
  });
  afterEach(() => other.close());

  test('void commits first: the waiting payment then sees VOID', async () => {
    const invoice = await issue({ topDays: 7 });
    // The other connection holds the write lock while it voids.
    other.exec('BEGIN IMMEDIATE');
    otherService.void(session(), {
      requestId: uuid(),
      invoiceId: invoice.id,
      reason: 'Batal',
    });
    h.db.pragma('busy_timeout = 0');
    const requestId = uuid();
    const blocked = failure(await pay(invoice.id, '100000', { requestId }));
    expect(blocked.code).toBe('INTERNAL_ERROR');
    other.exec('COMMIT');
    h.db.pragma('busy_timeout = 5000');
    // The same submission retried now runs on the committed VOID.
    expect(failure(await pay(invoice.id, '100000', { requestId })).code).toBe(
      'INVOICE_VOID',
    );
    expect(paymentCount(invoice.id)).toBe(0);
    expect(reversalCount(invoice.id)).toBe(1);
  });

  test('payment commits first: the waiting void is refused', async () => {
    const oil = await pricedItem('50000', 10);
    const invoice = await issue({ lines: [{ itemId: oil.id }], topDays: 7 });
    other.exec('BEGIN IMMEDIATE');
    otherService.recordPayment(session(), {
      requestId: uuid(),
      invoiceId: invoice.id,
      method: 'CASH',
      amount: '10000',
      reference: null,
      note: null,
    });
    h.db.pragma('busy_timeout = 0');
    const requestId = uuid();
    expect(
      failure(await voidInvoice(invoice.id, 'Batal', { requestId })).code,
    ).toBe('INTERNAL_ERROR');
    other.exec('COMMIT');
    h.db.pragma('busy_timeout = 5000');
    expect(
      failure(await voidInvoice(invoice.id, 'Batal', { requestId })).code,
    ).toBe('PAID_INVOICE_CANNOT_BE_VOIDED');
    expect(reversalCount(invoice.id)).toBe(0);
    expect(await stockOf(oil.id)).toBe(9);
    expect(value(await getInvoice(invoice.id)).status).toBe('FINALIZED');
  });

  test('a view loaded before a void on another connection cannot be paid', async () => {
    const invoice = await issue({ topDays: 7 });
    const stale = value(await getInvoice(invoice.id));
    expect(stale.outstandingAmount).toBe('100000');
    otherService.void(session(), {
      requestId: uuid(),
      invoiceId: invoice.id,
      reason: 'Batal',
    });
    expect(failure(await pay(invoice.id, stale.outstandingAmount)).code).toBe(
      'INVOICE_VOID',
    );
  });
});

// =====================================================================

describe('receivables', () => {
  test('outstanding and overdue exclude VOID and PAID; due today is not overdue', async () => {
    // Due today (TOP 0 on today's date).
    const dueToday = await issue({ invoiceDate: '2026-09-30', topDays: 0 });
    // Due yesterday (backdated, TOP 0).
    const dueYesterday = await issue({ invoiceDate: '2026-09-29', topDays: 0 });
    // Partly paid, due long ago.
    const partial = await issue({ invoiceDate: '2026-09-13', topDays: 7 });
    value(await pay(partial.id, '40000'));
    // Paid in full at checkout, due yesterday.
    await issue({ invoiceDate: '2026-09-29', pay: ['100000'] });
    // Voided, unpaid and overdue.
    const voided = await issue({ invoiceDate: '2026-09-01', topDays: 0 });
    value(await voidInvoice(voided.id, 'Batal'));
    // Not yet due.
    const later = await issue({ invoiceDate: '2026-09-30', topDays: 30 });

    const outstanding = value(await receivables('OUTSTANDING'));
    expect(outstanding.items.map((r) => r.invoiceNumber)).toEqual([
      partial.invoiceNumber,
      dueYesterday.invoiceNumber,
      dueToday.invoiceNumber,
      later.invoiceNumber,
    ]);
    expect(outstanding.total).toBe(4);
    expect(outstanding.totalOutstanding).toBe('360000');
    expect(outstanding.today).toBe('2026-09-30');
    expect(outstanding.items[0]).toMatchObject({
      status: 'FINALIZED',
      paymentStatus: 'PARTIALLY_PAID',
      amount: '100000',
      paidAmount: '40000',
      outstandingAmount: '60000',
      dueDate: '2026-09-20',
    });

    const overdue = value(await receivables('OVERDUE'));
    expect(overdue.items.map((r) => r.invoiceNumber)).toEqual([
      partial.invoiceNumber,
      dueYesterday.invoiceNumber,
    ]);
    expect(overdue.totalOutstanding).toBe('160000');

    // Last millisecond of 2026-09-30 in Jakarta: still not overdue.
    nowMs = Date.UTC(2026, 8, 30, 16, 59, 59, 999);
    expect(
      value(await receivables('OVERDUE')).items.map((r) => r.invoiceNumber),
    ).not.toContain(dueToday.invoiceNumber);
    // Local midnight: due yesterday now.
    nowMs = Date.UTC(2026, 8, 30, 17, 0, 0, 0);
    const nextDay = value(await receivables('OVERDUE'));
    expect(nextDay.today).toBe('2026-10-01');
    expect(nextDay.items.map((r) => r.invoiceNumber)).toContain(
      dueToday.invoiceNumber,
    );
    expect(nextDay.items.map((r) => r.invoiceNumber)).not.toContain(
      later.invoiceNumber,
    );

    // Paying off removes an invoice from both lists.
    value(await pay(dueYesterday.id, '100000'));
    expect(
      value(await receivables('OUTSTANDING')).items.map((r) => r.id),
    ).not.toContain(dueYesterday.id);
  });
});

// =====================================================================

describe('history search', () => {
  interface Fixture {
    andiInvoice: InvoiceView;
    budiInvoice: InvoiceView;
    anonymous: InvoiceView;
    voided: InvoiceView;
    andi: { id: string };
    budi: { id: string };
    motorB: { id: string };
    motorD: { id: string };
  }

  async function fixture(): Promise<Fixture> {
    const andi = await customer('Andi Wijaya', '0812-3456-7890');
    const budi = await customer('Budi Santoso', '+62 813 1111 2222');
    const motorB = await vehicle('B 1234 XYZ', andi.id);
    const motorD = await vehicle('D 5678 ABC', budi.id);

    const andiInvoice = await issue({
      customerId: andi.id,
      vehicleId: motorB.id,
      topDays: 7,
    });
    nowMs += MINUTE;
    const budiInvoice = await issue({
      customerId: budi.id,
      vehicleId: motorD.id,
      channelId: shopee,
      pay: ['100000'],
      windowId: ADMIN,
    });
    nowMs += MINUTE;
    const anonymous = await issue({ invoiceDate: '2026-09-28', topDays: 3 });
    value(await pay(anonymous.id, '10000'));
    nowMs += MINUTE;
    const voided = await issue({
      customerId: andi.id,
      vehicleId: motorB.id,
    });
    value(await voidInvoice(voided.id, 'Salah'));
    // An open draft never shows in history.
    value(
      await h.call<DraftView>(
        C.drafts.create,
        {
          requestId: uuid(),
          channelId: bengkel,
          invoiceDate: '2026-09-30',
          pricingAt: at(nowMs),
        },
        CASHIER,
      ),
    );
    return {
      andiInvoice,
      budiInvoice,
      anonymous,
      voided,
      andi,
      budi,
      motorB,
      motorD,
    };
  }

  test('finalization writes the normalized search snapshots', async () => {
    const f = await fixture();
    expect(
      rows(
        `SELECT customer_phone_normalized_snapshot AS phone, plate_number_normalized_snapshot AS plate
         FROM invoices WHERE id IN (?, ?, ?) ORDER BY invoice_number`,
        f.andiInvoice.id,
        f.budiInvoice.id,
        f.anonymous.id,
      ),
    ).toEqual([
      { phone: '6281234567890', plate: 'B1234XYZ' },
      { phone: '6281311112222', plate: 'D5678ABC' },
      { phone: null, plate: null },
    ]);
  });

  test('returns summaries of FINALIZED and VOID invoices only, newest first', async () => {
    const f = await fixture();
    const page = value(await search());
    expect(page.items.map((r) => r.id)).toEqual([
      f.voided.id,
      f.anonymous.id,
      f.budiInvoice.id,
      f.andiInvoice.id,
    ]);
    expect(page.total).toBe(4);
    expect(page.hasMore).toBe(false);
    expect(page.items[3]).toEqual({
      id: f.andiInvoice.id,
      invoiceNumber: f.andiInvoice.invoiceNumber,
      invoiceDate: '2026-09-30',
      dueDate: '2026-10-07',
      finalizedAt: f.andiInvoice.finalizedAt,
      voidedAt: null,
      customerName: 'Andi Wijaya',
      customerPhone: '0812-3456-7890',
      plateNumber: 'B 1234 XYZ',
      channel: { id: bengkel, label: f.andiInvoice.channel.label },
      cashier: { id: cashierId, displayName: 'Siti' },
      amount: '100000',
      paidAmount: '0',
      outstandingAmount: '100000',
      status: 'FINALIZED',
      paymentStatus: 'UNPAID',
    });
    expect(page.items[0]).toMatchObject({
      status: 'VOID',
      voidedAt: f.voided.finalizedAt,
    });
  });

  test('every filter matches the frozen snapshots after master data changed', async () => {
    const f = await fixture();

    // Master data changes after the sales.
    nowMs += HOUR;
    value(
      await h.call(
        C.customers.save,
        {
          id: f.andi.id,
          name: 'Andi Baru',
          phoneNumber: '0899-0000-1111',
        },
        CASHIER,
      ),
    );
    value(
      await h.call(
        C.vehicles.transferOwnership,
        { requestId: uuid(), vehicleId: f.motorB.id, newCustomerId: f.budi.id },
        CASHIER,
      ),
    );
    value(
      await h.call(
        C.vehicles.save,
        { id: f.motorD.id, plateNumber: 'D 9999 ZZZ' },
        CASHIER,
      ),
    );
    const andiRow = rows(
      'SELECT * FROM invoices WHERE id = ?',
      f.andiInvoice.id,
    );

    const andiNumbers = [
      f.andiInvoice.invoiceNumber,
      f.voided.invoiceNumber,
    ].sort();

    // Invoice number: exact, prefix, case-insensitive.
    expect(
      await numbersOf({ invoiceNumber: f.budiInvoice.invoiceNumber }),
    ).toEqual([f.budiInvoice.invoiceNumber]);
    expect(
      (await numbersOf({ invoiceNumber: 'inv-20260930-000' })).length,
    ).toBe(4);
    expect(await numbersOf({ invoiceNumber: 'INV-2026093%' })).toEqual([]);

    // Date range on invoiceDate (inclusive).
    expect(
      await numbersOf({ dateFrom: '2026-09-28', dateTo: '2026-09-28' }),
    ).toEqual([f.anonymous.invoiceNumber]);
    expect((await numbersOf({ dateFrom: '2026-09-29' })).length).toBe(3);
    expect(await numbersOf({ dateTo: '2026-09-27' })).toEqual([]);

    // Customer name: case-insensitive substring of the snapshot.
    expect(await numbersOf({ customerName: 'andi' })).toEqual(andiNumbers);
    expect(await numbersOf({ customerName: 'WIJAYA' })).toEqual(andiNumbers);
    expect(await numbersOf({ customerName: 'Baru' })).toEqual([]);
    expect(await numbersOf({ customerName: '%' })).toEqual([]);
    expect(await numbersOf({ customerName: '_' })).toEqual([]);

    // Phone: normalized on both sides.
    for (const phone of ['081234567890', '+6281234567890', '0812 3456 7890']) {
      expect(await numbersOf({ phone })).toEqual(andiNumbers);
    }
    expect(await numbersOf({ phone: '0899-0000-1111' })).toEqual([]);
    expect(await numbersOf({ phone: '0813-1111-2222' })).toEqual([
      f.budiInvoice.invoiceNumber,
    ]);
    expect(await numbersOf({ phone: 'abc' })).toEqual([]);

    // Plate: normalized substring.
    for (const plate of ['B 1234 XYZ', 'b1234xyz', 'B-1234-XYZ', '1234']) {
      expect(await numbersOf({ plate })).toEqual(andiNumbers);
    }
    expect(await numbersOf({ plate: 'D 5678' })).toEqual([
      f.budiInvoice.invoiceNumber,
    ]);
    expect(await numbersOf({ plate: 'D 9999 ZZZ' })).toEqual([]);

    // Channel, cashier (finalizer), status, payment status.
    expect(await numbersOf({ channelId: shopee })).toEqual([
      f.budiInvoice.invoiceNumber,
    ]);
    expect(await numbersOf({ cashierId: adminId })).toEqual([
      f.budiInvoice.invoiceNumber,
    ]);
    expect((await numbersOf({ cashierId })).length).toBe(3);
    expect(await numbersOf({ status: 'VOID' })).toEqual([
      f.voided.invoiceNumber,
    ]);
    expect(await numbersOf({ status: 'FINALIZED' })).toHaveLength(3);
    expect(await numbersOf({ paymentStatus: 'PAID' })).toEqual([
      f.budiInvoice.invoiceNumber,
    ]);
    expect(await numbersOf({ paymentStatus: 'PARTIALLY_PAID' })).toEqual([
      f.anonymous.invoiceNumber,
    ]);
    expect(
      await numbersOf({ paymentStatus: 'UNPAID', status: 'FINALIZED' }),
    ).toEqual([f.andiInvoice.invoiceNumber]);

    // Combined filters.
    expect(
      await numbersOf({ customerName: 'andi', status: 'VOID', plate: 'B1234' }),
    ).toEqual([f.voided.invoiceNumber]);

    // Ownership transfer and edits never rewrite old invoices (spec 60).
    expect(
      rows('SELECT * FROM invoices WHERE id = ?', f.andiInvoice.id),
    ).toEqual(andiRow);
    const view = value(await getInvoice(f.andiInvoice.id));
    expect(view).toEqual(f.andiInvoice);
    expect(view.customer).toEqual({
      id: f.andi.id,
      name: 'Andi Wijaya',
      phoneNumber: '0812-3456-7890',
    });
    expect(value(await getInvoice(f.budiInvoice.id)).vehicle?.plateNumber).toBe(
      'D 5678 ABC',
    );
  });

  test('invalid filters are validation errors', async () => {
    for (const filters of [
      { dateFrom: '2026-13-01' },
      { channelId: 'nope' },
      { status: 'DRAFT' },
      { paymentStatus: 'LUNAS' },
      { unknown: 1 },
    ]) {
      expect(
        failure(await h.call(C.invoices.search, { filters }, CASHIER)).code,
      ).toBe('VALIDATION_FAILED');
    }
    expect(failure(await search({}, { size: 101 })).code).toBe(
      'VALIDATION_FAILED',
    );
    expect(failure(await search({}, { number: 0 })).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  test('pagination is deterministic and stable across pages', async () => {
    const issued: InvoiceView[] = [];
    // Several invoices share one finalization instant (ties break on id).
    for (let i = 0; i < 5; i += 1) issued.push(await issue());
    nowMs += MINUTE;
    for (let i = 0; i < 4; i += 1) issued.push(await issue());

    const all = value(await search({}, { size: 100 })).items;
    expect(all).toHaveLength(9);
    const expected = [...issued]
      .sort((a, b) =>
        a.finalizedAt === b.finalizedAt
          ? a.id < b.id
            ? 1
            : -1
          : a.finalizedAt < b.finalizedAt
            ? 1
            : -1,
      )
      .map((v) => v.id);
    expect(all.map((r) => r.id)).toEqual(expected);

    const collected: string[] = [];
    for (let number = 1; number <= 4; number += 1) {
      const page = value(await search({}, { number, size: 2 }));
      expect(page.total).toBe(9);
      expect(page.pageNumber).toBe(number);
      expect(page.pageSize).toBe(2);
      expect(page.hasMore).toBe(true);
      collected.push(...page.items.map((r) => r.id));
    }
    const last = value(await search({}, { number: 5, size: 2 }));
    expect(last.hasMore).toBe(false);
    collected.push(...last.items.map((r) => r.id));
    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(9);
    // Asking the same page again gives the same rows.
    expect(value(await search({}, { number: 2, size: 2 })).items).toEqual(
      value(await search({}, { number: 2, size: 2 })).items,
    );
    // Past the end: empty.
    expect(value(await search({}, { number: 9, size: 2 })).items).toEqual([]);
    // Default page size.
    expect(value(await search()).pageSize).toBe(25);
  });

  test('renaming a cashier does not change receiver, voider or finalizer names', async () => {
    const paid = await issue({ topDays: 7 });
    value(await pay(paid.id, '5000'));
    const voided = await issue();
    value(await voidInvoice(voided.id, 'Salah'));

    value(
      await h.call(
        C.cashiers.updateDisplayName,
        { cashierId, displayName: 'Siti Rahma' },
        ADMIN,
      ),
    );

    const paidView = value(await getInvoice(paid.id));
    expect(paidView.payments[0]!.receivedBy).toEqual({
      id: cashierId,
      displayName: 'Siti',
    });
    expect(paidView.cashier.displayName).toBe('Siti');
    const voidView = value(await getInvoice(voided.id));
    expect(voidView.void?.voidedBy).toEqual({
      id: cashierId,
      displayName: 'Siti',
    });
    const summary = value(await search({ cashierId })).items;
    expect(summary.every((r) => r.cashier.displayName === 'Siti')).toBe(true);
    // New actions use the new name.
    value(await pay(paid.id, '5000'));
    expect(
      value(await getInvoice(paid.id)).payments.map(
        (p) => p.receivedBy.displayName,
      ),
    ).toEqual(['Siti', 'Siti Rahma']);
  });
});

// =====================================================================

describe('migration 008 on a populated version-7 database', () => {
  const v7 = bundledMigrations.filter((m) => m.version <= 7);

  function triggerSql(db: AppDatabase) {
    return Object.fromEntries(
      (
        db
          .prepare(
            `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
          )
          .all() as { name: string; sql: string }[]
      ).map((t) => [t.name, t.sql]),
    );
  }

  test('backfills name and search snapshots and keeps every guard', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bengkelin-v7-'));
    const file = path.join(dir, 'db.sqlite');
    const clock = { now: () => toInstant(nowMs) };
    try {
      // ---- a real version-7 database, driven by the app's own commands ----
      let db = openDatabase(file);
      migrateDatabase(db, v7);
      expect(readSchemaVersion(db)).toBe(7);
      const services = createApplicationServices({
        db,
        clock,
        logDir: path.join(dir, 'logs'),
        openPath: async () => '',
      });
      const commands = new Map(
        buildCommands(services).map((c) => [c.channel, c]),
      );
      const call = async <T>(channel: string, input?: unknown, windowId = 1) =>
        (await executeCommand(
          commands.get(channel)!,
          { windowId },
          input,
          services.logger,
        )) as Result<T>;
      value(await call(C.settings.completeSetup, validSetup()));
      const admin = value(
        await call<{ cashierId: string }>(C.auth.login, {
          username: 'admin',
          password: ADMIN_PASSWORD,
        }),
      ).cashierId;
      const channel = value(
        await call<ReferenceDto[]>(C.references.list, { entity: 'channel' }),
      ).find((c) => c.code === 'BENGKEL')!;
      const saved = value(
        await call<SaveCustomerResult>(C.customers.save, {
          name: 'Andi',
          phoneNumber: '+62 812-3456-7890',
        }),
      );
      if (!saved.saved) throw new Error('not saved');
      const motor = value(
        await call<SaveVehicleResult>(C.vehicles.save, {
          plateNumber: 'b 1234-xyz',
          ownerCustomerId: saved.customer.id,
        }),
      ).vehicle;
      const drafts: DraftView[] = [];
      for (let i = 0; i < 4; i += 1) {
        let draft = value(
          await call<DraftView>(C.drafts.create, {
            requestId: uuid(),
            channelId: channel.id,
            invoiceDate: '2026-09-30',
            pricingAt: at(nowMs),
          }),
        );
        draft = value(
          await call<DraftView>(C.drafts.apply, {
            requestId: uuid(),
            invoiceId: draft.id,
            expectedVersion: draft.version,
            op: {
              kind: 'addCustomLine',
              type: 'SERVICE',
              title: 'Servis',
              unitPrice: '50000',
            },
          }),
        );
        if (i < 2) {
          draft = value(
            await call<DraftView>(C.drafts.apply, {
              requestId: uuid(),
              invoiceId: draft.id,
              expectedVersion: draft.version,
              op: {
                kind: 'updateHeader',
                changes: { customerId: saved.customer.id, vehicleId: motor.id },
              },
            }),
          );
        }
        drafts.push(draft);
      }
      // Finalize three of them as version 7 did (the 007 columns only).
      const finalizeV7 = db.prepare(
        `UPDATE invoices SET customer_name_snapshot = ?, customer_phone_snapshot = ?,
           plate_number_snapshot = ?, vehicle_description_snapshot = NULL,
           channel_label_snapshot = ?, cashier_name_snapshot = 'Pak Budi',
           shop_identity_snapshot = '{"name":"Bengkel"}', status = 'FINALIZED',
           invoice_number = ?, cashier_id = ?, finalized_at = ?, version = version + 1
         WHERE id = ?`,
      );
      drafts.slice(0, 3).forEach((draft, index) => {
        const named = index < 2;
        finalizeV7.run(
          named ? 'Andi' : null,
          named ? '+62 812-3456-7890' : null,
          named ? 'b 1234-xyz' : null,
          channel.label,
          `INV-20260930-000${index + 1}`,
          admin,
          at(nowMs),
          draft.id,
        );
      });
      db.prepare(
        `INSERT INTO payments (id, invoice_id, method, amount, paid_at, received_by_cashier_id, source, created_at)
         VALUES (?, ?, 'CASH', 20000, ?, ?, 'CHECKOUT', ?)`,
      ).run(uuid(), drafts[0]!.id, at(nowMs), admin, at(nowMs));
      db.prepare(
        `INSERT INTO payments (id, invoice_id, method, amount, paid_at, received_by_cashier_id, source, created_at)
         VALUES (?, ?, 'QRIS', 30000, ?, ?, 'LATER', ?)`,
      ).run(uuid(), drafts[0]!.id, at(nowMs + HOUR), admin, at(nowMs + HOUR));
      db.prepare(
        `UPDATE invoices SET status = 'VOID', voided_at = ?, voided_by_cashier_id = ?,
           void_reason = 'Salah', version = version + 1 WHERE id = ?`,
      ).run(at(nowMs + HOUR), admin, drafts[2]!.id);

      const invoicesV7 = db
        .prepare('SELECT * FROM invoices ORDER BY id')
        .all() as Record<string, unknown>[];
      const paymentsV7 = db
        .prepare('SELECT * FROM payments ORDER BY id')
        .all() as Record<string, unknown>[];
      const triggersV7 = triggerSql(db);
      // Everything else (other tables) must be unchanged too.
      const otherTablesV7 = (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table'
             AND name NOT IN ('invoices', 'payments') ORDER BY name`,
          )
          .all() as { name: string }[]
      ).map(({ name }) => [
        name,
        db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      ]);
      db.close();

      // ---- upgrade ----
      db = openDatabase(file);
      // Exactly the 008 upgrade (later migrations have their own tests).
      migrateDatabase(
        db,
        bundledMigrations.filter((m) => m.version <= 8),
      );
      expect(readSchemaVersion(db)).toBe(8);

      // Pre-existing columns are unchanged; only the new ones were filled.
      const invoices8 = db
        .prepare('SELECT * FROM invoices ORDER BY id')
        .all() as Record<string, unknown>[];
      expect(
        invoices8.map((row) => {
          const {
            voided_by_name_snapshot: _a,
            customer_phone_normalized_snapshot: _b,
            plate_number_normalized_snapshot: _c,
            ...rest
          } = row;
          return rest;
        }),
      ).toEqual(invoicesV7);
      const payments8 = db
        .prepare('SELECT * FROM payments ORDER BY id')
        .all() as Record<string, unknown>[];
      expect(
        payments8.map(({ received_by_name_snapshot: _n, ...rest }) => rest),
      ).toEqual(paymentsV7);
      expect(
        (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type = 'table'
               AND name NOT IN ('invoices', 'payments') ORDER BY name`,
            )
            .all() as { name: string }[]
        ).map(({ name }) => [
          name,
          db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
        ]),
      ).toEqual(otherTablesV7);

      // Backfilled values.
      expect(payments8.map((p) => p.received_by_name_snapshot)).toEqual([
        'Pak Budi',
        'Pak Budi',
      ]);
      for (const row of invoices8) {
        const phone = row.customer_phone_snapshot as string | null;
        const plate = row.plate_number_snapshot as string | null;
        expect(row.customer_phone_normalized_snapshot).toBe(
          phone === null ? null : normalizePhone(phone),
        );
        expect(row.plate_number_normalized_snapshot).toBe(
          plate === null ? null : normalizePlate(plate),
        );
        expect(row.voided_by_name_snapshot).toBe(
          row.status === 'VOID' ? 'Pak Budi' : null,
        );
      }
      expect(
        invoices8
          .filter((r) => r.customer_phone_snapshot !== null)
          .map((r) => [
            r.customer_phone_normalized_snapshot,
            r.plate_number_normalized_snapshot,
          ]),
      ).toEqual([
        ['6281234567890', 'B1234XYZ'],
        ['6281234567890', 'B1234XYZ'],
      ]);

      // ---- trigger equivalence ----
      const triggers8 = triggerSql(db);
      // Recreated triggers have exactly the version-7 text.
      expect(triggers8.payments_no_update).toBe(triggersV7.payments_no_update);
      expect(triggers8.invoices_void_immutable).toBe(
        triggersV7.invoices_void_immutable,
      );
      // Every other version-7 trigger is untouched, except the finalized
      // guard, which gains exactly the two new search snapshot columns.
      for (const [name, sql] of Object.entries(triggersV7)) {
        if (name === 'invoices_finalized_immutable') continue;
        expect(triggers8[name], name).toBe(sql);
      }
      const oldGuard = triggersV7.invoices_finalized_immutable!;
      const newGuard = triggers8.invoices_finalized_immutable!;
      const clauses = (sql: string) =>
        sql
          .split('\n')
          .map((line) => line.trim())
          .filter(
            (line) => line.startsWith('OR NEW.') || line.startsWith('NEW.'),
          );
      expect(
        clauses(newGuard).filter((c) => !clauses(oldGuard).includes(c)),
      ).toEqual([
        'OR NEW.customer_phone_normalized_snapshot IS NOT OLD.customer_phone_normalized_snapshot',
        'OR NEW.plate_number_normalized_snapshot IS NOT OLD.plate_number_normalized_snapshot',
      ]);
      expect(
        clauses(oldGuard).filter((c) => !clauses(newGuard).includes(c)),
      ).toEqual([]);

      // Behaviour: payments stay append-only.
      expect(() => db.prepare('UPDATE payments SET amount = 1').run()).toThrow(
        /append-only/,
      );
      expect(() =>
        db
          .prepare('UPDATE payments SET received_by_name_snapshot = ?')
          .run('X'),
      ).toThrow(/append-only/);
      expect(() => db.prepare('DELETE FROM payments').run()).toThrow(
        /append-only/,
      );
      // VOID stays terminal, including the new columns.
      for (const column of [
        'void_reason',
        'voided_by_name_snapshot',
        'customer_phone_normalized_snapshot',
      ]) {
        expect(() =>
          db
            .prepare(`UPDATE invoices SET ${column} = 'x' WHERE id = ?`)
            .run(drafts[2]!.id),
        ).toThrow(/void invoice/);
      }
      // FINALIZED: every column except the void transition's is frozen.
      const allowed = new Set([
        'status',
        'voided_at',
        'voided_by_cashier_id',
        'void_reason',
        'voided_by_name_snapshot',
        'version',
        'updated_at',
      ]);
      const columns = db.prepare('PRAGMA table_info(invoices)').all() as {
        name: string;
        type: string;
      }[];
      const finalizedId = drafts[0]!.id;
      const current = db
        .prepare('SELECT * FROM invoices WHERE id = ?')
        .get(finalizedId) as Record<string, unknown>;
      for (const { name, type } of columns) {
        if (allowed.has(name)) continue;
        const different =
          current[name] === null ? (type === 'INTEGER' ? 1 : 'x') : null;
        expect(
          () =>
            db
              .prepare(`UPDATE invoices SET "${name}" = ? WHERE id = ?`)
              .run(different, finalizedId),
          name,
        ).toThrow(/finalized invoice cannot change/);
      }
      // The void name exists only together with the VOID transition.
      expect(() =>
        db
          .prepare(
            `UPDATE invoices SET voided_by_name_snapshot = 'X' WHERE id = ?`,
          )
          .run(drafts[1]!.id),
      ).toThrow(/CHECK/);
      expect(() =>
        db
          .prepare(
            `UPDATE invoices SET status = 'VOID', voided_at = ?, voided_by_cashier_id = ?,
               void_reason = 'x' WHERE id = ?`,
          )
          .run(at(nowMs), admin, drafts[1]!.id),
      ).toThrow(/void name/);
      // A new payment must carry its receiver name.
      expect(() =>
        db
          .prepare(
            `INSERT INTO payments (id, invoice_id, method, amount, paid_at, received_by_cashier_id, source, created_at)
             VALUES (?, ?, 'CASH', 1, ?, ?, 'LATER', ?)`,
          )
          .run(uuid(), drafts[1]!.id, at(nowMs), admin, at(nowMs)),
      ).toThrow(/receiver name/);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');

      // The upgraded database works with the new services.
      const upgraded = new InvoiceService({ db, clock });
      const session: Session = {
        windowId: 1,
        cashierId: admin,
        username: 'admin',
        displayName: 'Pak Budi',
        role: 'ADMIN',
      };
      const found = upgraded.search(session, {
        filters: { phone: '0812 3456 7890' },
        page: { number: 1, size: 25 },
      });
      expect(found.items.map((r) => r.invoiceNumber).sort()).toEqual([
        'INV-20260930-0001',
        'INV-20260930-0002',
      ]);
      expect(
        upgraded.get(session, { invoiceId: drafts[2]!.id }).void?.voidedBy,
      ).toEqual({ id: admin, displayName: 'Pak Budi' });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
