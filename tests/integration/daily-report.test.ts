import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { formatCsv, csvInteger } from '@/main/features/csv/writer';
import { REPORT_LABELS } from '@/main/features/reports/labels';
import { REPORT_QUERIES } from '@/main/features/reports/repository';
import { CHANNELS } from '@/shared/channels';
import {
  PAYMENT_METHODS,
  type DailyReport,
  type DailyReportInput,
  type DraftOperation,
  type DraftView,
  type FinalizePreviewDto,
  type InvoiceView,
  type ReferenceDto,
  type ReportOutcomeDto,
  type ReportPreviewDto,
} from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';
import { businessDay, toInstant } from '@/shared/time';
import { parseCsv } from './helpers/csv';
import { FakeDialogs, FakePrintDriver } from './helpers/fake-print';
import {
  ADMIN_PASSWORD,
  createHarness,
  failure,
  validSetup,
  value,
  type Harness,
} from './helpers/harness';

/**
 * Task 13: calendar-day sales and receipt reports (spec 33, 59; Part A
 * "Void reporting"). Shop timezone Asia/Jakarta (UTC+7); the clock is
 * injected. Every fixture is built through the real commands (finalize,
 * recordPayment, void), never raw SQL.
 */

const C = CHANNELS;
const ADMIN = 1;
const SITI = 2;
const JOKO = 3;
const NOBODY = 99;
const TZ = 'Asia/Jakarta';
const L = REPORT_LABELS.id;

/** A wall-clock time in Jakarta as epoch ms. */
const wib = (date: string, time: string) =>
  Date.parse(`${date}T${time}:00.000+07:00`);

let h: Harness;
let driver: FakePrintDriver;
let dialogs: FakeDialogs;
let nowMs = wib('2026-09-29', '08:00');
let counter = 0;
let adminId: string;
let sitiId: string;
let jokoId: string;
let bengkel: string;
let shopee: string;

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

async function createCashier(username: string, displayName: string) {
  value(
    await h.call(
      C.cashiers.create,
      {
        username,
        displayName,
        password: `${username}-password-1`,
        role: 'CASHIER',
      },
      ADMIN,
    ),
  );
}

beforeEach(async () => {
  nowMs = wib('2026-09-29', '08:00');
  counter = 0;
  driver = new FakePrintDriver();
  dialogs = new FakeDialogs();
  h = createHarness({
    clock: { now: () => toInstant(nowMs) },
    printDriver: driver,
    dialogs,
  });
  value(await h.call(C.settings.completeSetup, validSetup()));
  adminId = await login('admin', ADMIN_PASSWORD, ADMIN);
  await createCashier('siti', 'Siti');
  await createCashier('joko', 'Joko');
  sitiId = await login('siti', 'siti-password-1', SITI);
  jokoId = await login('joko', 'joko-password-1', JOKO);
  const channels = value(
    await h.call<ReferenceDto[]>(C.references.list, { entity: 'channel' }),
  );
  bengkel = channels.find((c) => c.code === 'BENGKEL')!.id;
  shopee = channels.find((c) => c.code === 'ONLINE')!.id;
});
afterEach(() => h.close());

// ---- issuing invoices through the real commands ----

interface IssueOptions {
  /** Custom line prices (one line each). Default: one line of `amount`. */
  lines?: { price: string; stages?: number[] }[];
  invoiceStages?: number[];
  channelId?: string;
  /** Checkout payments. */
  pay?: { method?: string; amount: string }[];
  windowId?: number;
}

async function issue(options: IssueOptions = {}): Promise<InvoiceView> {
  const windowId = options.windowId ?? SITI;
  let draft = value(
    await h.call<DraftView>(
      C.drafts.create,
      {
        requestId: uuid(),
        channelId: options.channelId ?? bengkel,
        invoiceDate: businessDay(toInstant(nowMs), currentTimezone()),
        pricingAt: toInstant(nowMs),
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
  for (const [i, line] of (options.lines ?? [{ price: '100000' }]).entries()) {
    await apply({
      kind: 'addCustomLine',
      type: 'NON_STOCK_ITEM',
      title: `Barang ${i + 1}`,
      unitPrice: line.price,
    });
    if (line.stages?.length) {
      await apply({
        kind: 'setLineDiscounts',
        lineId: draft.lines[draft.lines.length - 1]!.id,
        stages: line.stages,
      });
    }
  }
  if (options.invoiceStages?.length) {
    await apply({ kind: 'setInvoiceDiscounts', stages: options.invoiceStages });
  }
  if (options.pay?.length) {
    await apply({
      kind: 'setCheckoutAllocations',
      allocations: options.pay.map((p) => ({
        method: (p.method ?? 'CASH') as 'CASH',
        amount: p.amount,
      })),
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

let timezone = TZ;
const currentTimezone = () => timezone;

async function pay(
  invoiceId: string,
  amount: string,
  windowId = SITI,
  method = 'CASH',
) {
  return value(
    await h.call<InvoiceView>(
      C.invoices.recordPayment,
      { requestId: uuid(), invoiceId, method, amount },
      windowId,
    ),
  );
}

async function voidInvoice(
  invoiceId: string,
  reason: string,
  windowId = ADMIN,
) {
  return value(
    await h.call<InvoiceView>(
      C.invoices.void,
      { requestId: uuid(), invoiceId, reason },
      windowId,
    ),
  );
}

async function daily(input: DailyReportInput, windowId = ADMIN) {
  const report = value(
    await h.call<DailyReport>(C.reports.daily, input, windowId),
  );
  expectConsistent(report);
  return report;
}

const sum = (values: string[]) =>
  values.reduce((total, v) => total + BigInt(v), 0n).toString();

/** Invariants every report must satisfy (all bigint arithmetic). */
function expectConsistent(report: DailyReport) {
  const s = report.sales;
  expect(
    (
      BigInt(s.grossSubtotal) -
      BigInt(s.itemDiscounts) -
      BigInt(s.invoiceDiscounts)
    ).toString(),
  ).toBe(s.netBeforeVoids);
  expect(
    (BigInt(s.netBeforeVoids) - BigInt(report.voids.deduction)).toString(),
  ).toBe(report.netAfterVoids);
  expect(sum(s.byChannel.map((r) => r.netBeforeVoids))).toBe(s.netBeforeVoids);
  expect(sum(s.byCashier.map((r) => r.netBeforeVoids))).toBe(s.netBeforeVoids);
  expect(s.byChannel.reduce((n, r) => n + r.invoiceCount, 0)).toBe(
    s.invoiceCount,
  );
  expect(s.byCashier.reduce((n, r) => n + r.invoiceCount, 0)).toBe(
    s.invoiceCount,
  );
  expect(report.voids.count).toBe(report.voids.invoices.length);
  expect(sum(report.voids.invoices.map((v) => v.amount))).toBe(
    report.voids.deduction,
  );
  const p = report.payments;
  expect(p.byMethod.map((m) => m.method)).toEqual([...PAYMENT_METHODS]);
  expect(sum(p.byMethod.map((m) => m.amount))).toBe(p.received);
  expect(p.byMethod.reduce((n, m) => n + m.count, 0)).toBe(p.count);
  expect(sum([p.sameDayInvoices, p.olderInvoices])).toBe(p.received);
  // Money is a canonical integer string; only netAfterVoids may be negative.
  const money = [
    s.grossSubtotal,
    s.itemDiscounts,
    s.invoiceDiscounts,
    s.netBeforeVoids,
    report.voids.deduction,
    p.received,
    p.sameDayInvoices,
    p.olderInvoices,
    ...s.byChannel.map((r) => r.netBeforeVoids),
    ...s.byCashier.map((r) => r.netBeforeVoids),
    ...report.voids.invoices.map((v) => v.amount),
    ...p.byMethod.map((m) => m.amount),
  ];
  for (const m of money) expect(m).toMatch(/^(0|[1-9]\d*)$/);
  expect(report.netAfterVoids).toMatch(/^(0|-?[1-9]\d*)$/);
}

function method(report: DailyReport, name: string) {
  return report.payments.byMethod.find((m) => m.method === name)!;
}

// ---- the mandatory fixture (spec 59) ----

/**
 * Sep 29: Invoice A = 1.000.000 with a 400.000 checkout payment.
 * Sep 30: Invoice B = 500.000 paid 500.000, and 600.000 more on A.
 */
async function spec59() {
  nowMs = wib('2026-09-29', '10:00');
  const a = await issue({
    lines: [{ price: '1000000' }],
    pay: [{ amount: '400000' }],
  });
  nowMs = wib('2026-09-30', '09:00');
  const b = await issue({
    lines: [{ price: '500000' }],
    pay: [{ amount: '500000' }],
  });
  nowMs = wib('2026-09-30', '14:00');
  await pay(a.id, '600000');
  return { a, b };
}

describe('spec 59: sales and receipts are separate', () => {
  test('September 30 reports sales 500000 and receipts 1100000', async () => {
    await spec59();
    nowMs = wib('2026-10-01', '08:00');
    const september30 = await daily({ date: '2026-09-30' });

    expect(september30.sales.netBeforeVoids).toBe('500000');
    expect(september30.payments.received).toBe('1100000');
    expect(september30.payments.olderInvoices).toBe('600000');
    expect(september30.payments.sameDayInvoices).toBe('500000');

    expect(september30.date).toBe('2026-09-30');
    expect(september30.timezone).toBe(TZ);
    expect(september30.generatedAt).toBe(toInstant(nowMs));
    expect(september30.range).toEqual({
      start: '2026-09-29T17:00:00.000Z',
      end: '2026-09-30T17:00:00.000Z',
    });
    expect(september30.filters).toEqual({ cashier: null, channel: null });
    expect(september30.sales).toMatchObject({
      invoiceCount: 1,
      grossSubtotal: '500000',
      itemDiscounts: '0',
      invoiceDiscounts: '0',
    });
    expect(september30.voids).toEqual({
      count: 0,
      deduction: '0',
      invoices: [],
    });
    expect(september30.netAfterVoids).toBe('500000');
    expect(method(september30, 'CASH')).toEqual({
      method: 'CASH',
      count: 2,
      amount: '1100000',
    });
    expect(september30.payments.count).toBe(2);

    const september29 = await daily({ date: '2026-09-29' });
    expect(september29.sales.netBeforeVoids).toBe('1000000');
    expect(september29.sales.invoiceCount).toBe(1);
    expect(september29.payments.received).toBe('400000');
    expect(september29.payments.sameDayInvoices).toBe('400000');
    expect(september29.payments.olderInvoices).toBe('0');
  });

  test('sales group by channel and finalizing cashier; payments by method', async () => {
    nowMs = wib('2026-09-30', '09:00');
    await issue({
      lines: [{ price: '120000' }],
      pay: [{ amount: '120000', method: 'QRIS' }],
    });
    await issue({
      lines: [{ price: '80000' }],
      channelId: shopee,
      windowId: JOKO,
      pay: [
        { amount: '30000', method: 'BANK_TRANSFER' },
        { amount: '50000', method: 'CASH' },
      ],
    });
    await issue({ lines: [{ price: '45000' }], windowId: JOKO });
    const report = await daily({ date: '2026-09-30' }, SITI);
    expect(report.sales.byChannel).toEqual([
      {
        channel: { id: bengkel, label: 'Bengkel' },
        invoiceCount: 2,
        netBeforeVoids: '165000',
      },
      {
        channel: { id: shopee, label: 'Online' },
        invoiceCount: 1,
        netBeforeVoids: '80000',
      },
    ]);
    expect(report.sales.byCashier).toEqual([
      {
        cashier: { id: jokoId, displayName: 'Joko' },
        invoiceCount: 2,
        netBeforeVoids: '125000',
      },
      {
        cashier: { id: sitiId, displayName: 'Siti' },
        invoiceCount: 1,
        netBeforeVoids: '120000',
      },
    ]);
    expect(report.payments.byMethod).toEqual([
      { method: 'CASH', count: 1, amount: '50000' },
      { method: 'QRIS', count: 1, amount: '120000' },
      { method: 'BANK_TRANSFER', count: 1, amount: '30000' },
      { method: 'DEBIT_CARD', count: 0, amount: '0' },
      { method: 'CREDIT_CARD', count: 0, amount: '0' },
      { method: 'OTHER', count: 0, amount: '0' },
    ]);
    expect(report.payments.received).toBe('200000');
  });
});

// ---- voids ----

describe('void reporting', () => {
  test('a later void keeps the original-day sale and deducts on the void day', async () => {
    nowMs = wib('2026-09-30', '10:00');
    const c = await issue({ lines: [{ price: '250000' }], windowId: JOKO });
    nowMs = wib('2026-10-02', '11:30');
    await voidInvoice(c.id, 'Salah input pelanggan');

    const september30 = await daily({ date: '2026-09-30' });
    expect(september30.sales.invoiceCount).toBe(1);
    expect(september30.sales.netBeforeVoids).toBe('250000');
    expect(september30.voids.deduction).toBe('0');
    expect(september30.netAfterVoids).toBe('250000');

    const october1 = await daily({ date: '2026-10-01' });
    expect(october1.sales.netBeforeVoids).toBe('0');
    expect(october1.voids.count).toBe(0);

    const october2 = await daily({ date: '2026-10-02' });
    expect(october2.sales.invoiceCount).toBe(0);
    expect(october2.sales.netBeforeVoids).toBe('0');
    expect(october2.voids.count).toBe(1);
    expect(october2.voids.deduction).toBe('250000');
    // Negative effect: the one money field that carries a '-' sign.
    expect(october2.netAfterVoids).toBe('-250000');
    expect(october2.voids.invoices).toEqual([
      {
        invoiceId: c.id,
        invoiceNumber: c.invoiceNumber,
        finalizedAt: c.finalizedAt,
        finalizedDate: '2026-09-30',
        voidedAt: toInstant(wib('2026-10-02', '11:30')),
        voidedAtLocal: '2026-10-02 11:30',
        amount: '250000',
        reason: 'Salah input pelanggan',
        voidedBy: { id: adminId, displayName: 'Pak Budi' },
        channel: { id: bengkel, label: 'Bengkel' },
      },
    ]);
    // Payments never involve a VOID invoice.
    expect(october2.payments.received).toBe('0');
  });

  test('a same-day void is a sale and a deduction on that day', async () => {
    nowMs = wib('2026-09-30', '10:00');
    const d = await issue({ lines: [{ price: '100000' }] });
    await issue({ lines: [{ price: '300000' }], pay: [{ amount: '300000' }] });
    nowMs = wib('2026-09-30', '11:00');
    await voidInvoice(d.id, 'Pelanggan batal', SITI);

    const report = await daily({ date: '2026-09-30' });
    expect(report.sales.invoiceCount).toBe(2);
    expect(report.sales.netBeforeVoids).toBe('400000');
    expect(report.voids.count).toBe(1);
    expect(report.voids.deduction).toBe('100000');
    expect(report.netAfterVoids).toBe('300000');
    expect(report.voids.invoices[0]).toMatchObject({
      invoiceNumber: d.invoiceNumber,
      finalizedDate: '2026-09-30',
      voidedBy: { id: sitiId, displayName: 'Siti' },
    });
    expect(report.payments.received).toBe('300000');
  });
});

// ---- day boundaries in the shop timezone ----

describe('timezone boundaries', () => {
  test('16:59:59.999Z is September 30 and 17:00:00.000Z is October 1 (WIB)', async () => {
    nowMs = Date.parse('2026-09-30T16:59:59.999Z');
    const f = await issue({
      lines: [{ price: '70000' }],
      pay: [{ amount: '20000' }],
    });
    expect(f.finalizedAt).toBe('2026-09-30T16:59:59.999Z');
    // A later payment on the same invoice, still September 30.
    await pay(f.id, '10000');
    nowMs = Date.parse('2026-09-30T17:00:00.000Z');
    const g = await issue({
      lines: [{ price: '90000' }],
      pay: [{ amount: '90000' }],
    });
    expect(g.finalizedAt).toBe('2026-09-30T17:00:00.000Z');
    // Midnight exactly: a payment on the September 30 invoice is October 1.
    await pay(f.id, '15000');

    const september30 = await daily({ date: '2026-09-30' });
    expect(september30.sales.invoiceCount).toBe(1);
    expect(september30.sales.netBeforeVoids).toBe('70000');
    expect(september30.payments.received).toBe('30000');
    expect(september30.payments.sameDayInvoices).toBe('30000');

    const october1 = await daily({ date: '2026-10-01' });
    expect(october1.sales.invoiceCount).toBe(1);
    expect(october1.sales.netBeforeVoids).toBe('90000');
    expect(october1.payments.received).toBe('105000');
    expect(october1.payments.sameDayInvoices).toBe('90000');
    expect(october1.payments.olderInvoices).toBe('15000');
  });

  test('a changed shop timezone applies to later report queries and is shown', async () => {
    nowMs = Date.parse('2026-09-30T16:30:00.000Z'); // 23:30 WIB, 00:30 WITA
    await issue({ lines: [{ price: '70000' }], pay: [{ amount: '70000' }] });
    expect((await daily({ date: '2026-09-30' })).sales.invoiceCount).toBe(1);

    value(
      await h.call(
        C.settings.updateShop,
        {
          name: 'Bengkel Maju Jaya',
          address: 'Jl. Merdeka No. 1, Bandung',
          phoneNumber: '081234567890',
          timezone: 'Asia/Makassar',
        },
        ADMIN,
      ),
    );
    timezone = 'Asia/Makassar';
    try {
      const september30 = await daily({ date: '2026-09-30' });
      expect(september30.timezone).toBe('Asia/Makassar');
      expect(september30.range).toEqual({
        start: '2026-09-29T16:00:00.000Z',
        end: '2026-09-30T16:00:00.000Z',
      });
      expect(september30.sales.invoiceCount).toBe(0);
      const october1 = await daily({ date: '2026-10-01' });
      expect(october1.sales.netBeforeVoids).toBe('70000');
      expect(october1.payments.received).toBe('70000');
      const preview = value(
        await h.call<ReportPreviewDto>(C.reports.preview, {
          date: '2026-10-01',
        }),
      );
      expect(preview.html).toContain('Asia/Makassar');
    } finally {
      timezone = TZ;
    }
  });
});

describe('empty day', () => {
  test('every figure is "0" and every list is empty (six zero methods)', async () => {
    nowMs = wib('2026-09-30', '10:00');
    await issue({ pay: [{ amount: '100000' }] });
    const report = await daily({ date: '2026-09-28' });
    expect(report.sales).toEqual({
      invoiceCount: 0,
      grossSubtotal: '0',
      itemDiscounts: '0',
      invoiceDiscounts: '0',
      netBeforeVoids: '0',
      byChannel: [],
      byCashier: [],
    });
    expect(report.voids).toEqual({ count: 0, deduction: '0', invoices: [] });
    expect(report.netAfterVoids).toBe('0');
    expect(report.payments).toEqual({
      received: '0',
      count: 0,
      sameDayInvoices: '0',
      olderInvoices: '0',
      byMethod: PAYMENT_METHODS.map((m) => ({
        method: m,
        count: 0,
        amount: '0',
      })),
    });
  });
});

// ---- filters ----

describe('filters', () => {
  test('channel filter uses the invoice channel in all three sections', async () => {
    nowMs = wib('2026-09-29', '10:00');
    const oldShopee = await issue({
      lines: [{ price: '400000' }],
      channelId: shopee,
    });
    const oldBengkel = await issue({ lines: [{ price: '300000' }] });
    nowMs = wib('2026-09-30', '09:00');
    await issue({
      lines: [{ price: '50000' }],
      channelId: shopee,
      pay: [{ amount: '50000' }],
    });
    await issue({ lines: [{ price: '60000' }], pay: [{ amount: '60000' }] });
    await pay(oldShopee.id, '100000');
    await pay(oldBengkel.id, '200000');
    const voidedShopee = await issue({
      lines: [{ price: '25000' }],
      channelId: shopee,
    });
    await voidInvoice(voidedShopee.id, 'Duplikat');
    const voidedBengkel = await issue({ lines: [{ price: '35000' }] });
    await voidInvoice(voidedBengkel.id, 'Duplikat');

    const all = await daily({ date: '2026-09-30' });
    expect(all.sales.netBeforeVoids).toBe('170000');
    expect(all.payments.received).toBe('410000');
    expect(all.voids.deduction).toBe('60000');

    const onlyShopee = await daily({ date: '2026-09-30', channelId: shopee });
    expect(onlyShopee.filters).toEqual({
      cashier: null,
      channel: { id: shopee, label: 'Online' },
    });
    expect(onlyShopee.sales.invoiceCount).toBe(2);
    expect(onlyShopee.sales.netBeforeVoids).toBe('75000');
    expect(onlyShopee.sales.byChannel.map((r) => r.channel.id)).toEqual([
      shopee,
    ]);
    expect(onlyShopee.payments.received).toBe('150000');
    expect(onlyShopee.payments.sameDayInvoices).toBe('50000');
    expect(onlyShopee.payments.olderInvoices).toBe('100000');
    expect(onlyShopee.voids.invoices.map((v) => v.invoiceNumber)).toEqual([
      voidedShopee.invoiceNumber,
    ]);
    expect(onlyShopee.voids.deduction).toBe('25000');
    expect(onlyShopee.netAfterVoids).toBe('50000');
  });

  test('cashier filter: finalizer for sales, receiver for payments, voider for voids', async () => {
    nowMs = wib('2026-09-30', '09:00');
    // Siti finalizes H (credit) and J (paid at checkout by Siti).
    const hInv = await issue({ lines: [{ price: '100000' }], windowId: SITI });
    await issue({
      lines: [{ price: '40000' }],
      windowId: SITI,
      pay: [{ amount: '40000' }],
    });
    // Joko receives a later payment on Siti's invoice H.
    await pay(hInv.id, '70000', JOKO, 'QRIS');
    // Siti finalizes I; ADMIN voids it.
    const iInv = await issue({ lines: [{ price: '15000' }], windowId: SITI });
    await voidInvoice(iInv.id, 'Tidak jadi', ADMIN);

    const siti = await daily({ date: '2026-09-30', cashierId: sitiId }, SITI);
    expect(siti.filters.cashier).toEqual({ id: sitiId, displayName: 'Siti' });
    expect(siti.sales.invoiceCount).toBe(3);
    expect(siti.sales.netBeforeVoids).toBe('155000');
    expect(siti.payments.received).toBe('40000');
    expect(siti.payments.count).toBe(1);
    expect(siti.voids.count).toBe(0);
    expect(siti.netAfterVoids).toBe('155000');

    const joko = await daily({ date: '2026-09-30', cashierId: jokoId }, SITI);
    expect(joko.sales.invoiceCount).toBe(0);
    expect(joko.payments.received).toBe('70000');
    expect(method(joko, 'QRIS').amount).toBe('70000');
    expect(joko.payments.sameDayInvoices).toBe('70000');
    expect(joko.voids.count).toBe(0);

    const admin = await daily({ date: '2026-09-30', cashierId: adminId }, SITI);
    expect(admin.sales.invoiceCount).toBe(0);
    expect(admin.payments.received).toBe('0');
    expect(admin.voids.invoices.map((v) => v.invoiceNumber)).toEqual([
      iInv.invoiceNumber,
    ]);
    expect(admin.voids.deduction).toBe('15000');
    expect(admin.netAfterVoids).toBe('-15000');

    const both = await daily(
      { date: '2026-09-30', cashierId: sitiId, channelId: shopee },
      SITI,
    );
    expect(both.sales.invoiceCount).toBe(0);
  });

  test('unknown filter ids and invalid input are rejected', async () => {
    const missing = '9f1b7c2e-0000-4000-8000-000000000001';
    expect(
      failure(
        await h.call(C.reports.daily, {
          date: '2026-09-30',
          cashierId: missing,
        }),
      ).code,
    ).toBe('CASHIER_NOT_FOUND');
    expect(
      failure(
        await h.call(C.reports.daily, {
          date: '2026-09-30',
          channelId: missing,
        }),
      ).code,
    ).toBe('CHANNEL_NOT_FOUND');
    for (const bad of [
      { date: '2026-02-30' },
      { date: '30/09/2026' },
      { date: '' },
      {},
      { date: '2026-09-30', extra: 1 },
      { date: '2026-09-30', cashierId: 'x' },
    ]) {
      expect(failure(await h.call(C.reports.daily, bad)).code).toBe(
        'VALIDATION_FAILED',
      );
    }
  });
});

// ---- spec 58 in reports ----

describe('critical calculation in reports', () => {
  test('report preview and paper use cashier formatting while CSV stays numeric', async () => {
    nowMs = wib('2026-09-30', '10:00');
    await issue({ lines: [{ price: '100000', stages: [3000, 5000, 1000] }] });
    value(
      await h.call(C.settings.updatePreferences, {
        language: 'id',
        appearance: 'SYSTEM',
        numberFormat: 'US',
      }),
    );
    const input = { date: '2026-09-30' };
    const preview = value(
      await h.call<ReportPreviewDto>(C.reports.preview, input),
    );
    expect(preview.html).toContain('Rp 31,500');
    value(await h.call(C.reports.print, input));
    expect(driver.printCalls.at(-1)?.html).toBe(preview.html);
    const target = path.join(h.dir, 'us-format.csv');
    dialogs.csvAnswers.push(target);
    value(await h.call(C.reports.exportCsv, input));
    expect(
      csvReport(readFileSync(target, 'utf8')).summary[L.netBeforeVoids],
    ).toBe('31500');
  });

  test('the 30/50/10% invoice appears as 31500 on screen, CSV and print', async () => {
    nowMs = wib('2026-09-30', '10:00');
    await issue({ lines: [{ price: '100000', stages: [3000, 5000, 1000] }] });
    const target = path.join(h.dir, 'critical.csv');
    dialogs.csvAnswers.push(target);
    const report = await daily({ date: '2026-09-30' });
    expect(report.sales).toMatchObject({
      grossSubtotal: '100000',
      itemDiscounts: '68500',
      invoiceDiscounts: '0',
      netBeforeVoids: '31500',
    });
    const preview = value(
      await h.call<ReportPreviewDto>(C.reports.preview, { date: '2026-09-30' }),
    );
    expect(scrapeHtml(preview.html).money['sales.netBeforeVoids']).toBe(
      '31500',
    );
    expect(preview.html).toContain('Rp 31.500');
    value(await h.call(C.reports.exportCsv, { date: '2026-09-30' }));
    const csv = csvReport(readFileSync(target, 'utf8'));
    expect(csv.summary[L.netBeforeVoids]).toBe('31500');
  });

  test('item and invoice discounts are reported as separate categories', async () => {
    nowMs = wib('2026-09-30', '10:00');
    await issue({ lines: [{ price: '100000', stages: [3000, 5000, 1000] }] });
    await issue({ lines: [{ price: '200000' }], invoiceStages: [1000] });
    const report = await daily({ date: '2026-09-30' });
    expect(report.sales).toMatchObject({
      invoiceCount: 2,
      grossSubtotal: '300000',
      itemDiscounts: '68500',
      invoiceDiscounts: '20000',
      netBeforeVoids: '211500',
    });
  });
});

// ---- screen / CSV / print agreement ----

interface CsvReport {
  header: Record<string, string>;
  summary: Record<string, string>;
  byChannel: string[][];
  byCashier: string[][];
  voids: string[][];
  byMethod: string[][];
  split: Record<string, string>;
}

/** Reads the sectioned CSV back: blocks separated by empty records. */
function csvReport(text: string): CsvReport {
  expect(text.startsWith('﻿')).toBe(true);
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  const rows = parseCsv(text);
  const blocks: string[][][] = [[]];
  for (const row of rows) {
    if (row.length === 1 && row[0] === '') blocks.push([]);
    else blocks[blocks.length - 1]!.push(row);
  }
  const header = blocks[0]!;
  expect(header[0]).toEqual([L.title]);
  const section = (title: string) => {
    const block = blocks.find((b) => b[0]?.[0] === title);
    if (!block) throw new Error(`No section ${title}`);
    return block.slice(2); // title row, column headers
  };
  const pairs = (list: string[][]) =>
    Object.fromEntries(list.map((r) => [r[0]!, r[1]!]));
  return {
    header: pairs(header.slice(1)),
    summary: pairs(section(L.salesSummary)),
    byChannel: section(L.byChannel),
    byCashier: section(L.byCashier),
    voids: section(L.voids),
    byMethod: section(L.paymentsByMethod),
    split: pairs(section(L.paymentSplit)),
  };
}

/** `Rp 1.100.000` / `-Rp 250.000` back to a Rupiah string. */
function unformat(text: string): string {
  const match = /^(-?)Rp ([\d.]+)$/.exec(text.trim());
  if (!match) throw new Error(`Not money: ${text}`);
  return `${match[1]}${match[2]!.replace(/\./g, '')}`;
}

function scrapeHtml(html: string) {
  const money: Record<string, string> = {};
  for (const m of html.matchAll(/data-money="([^"]+)">([^<]*)</g)) {
    expect(money[m[1]!], `duplicate ${m[1]}`).toBeUndefined();
    money[m[1]!] = unformat(m[2]!);
  }
  const counts: Record<string, number> = {};
  for (const m of html.matchAll(/data-count="([^"]+)">([^<]*)</g)) {
    counts[m[1]!] = Number(m[2]!.replace(/\./g, ''));
  }
  return { money, counts };
}

/** The CSV's formula guard: a leading apostrophe on text. Money is digits. */
const csvText = (cell: string) => (cell.startsWith("'") ? cell.slice(1) : cell);

describe('screen, CSV and print agree', () => {
  async function busyDay() {
    await spec59();
    nowMs = wib('2026-09-30', '15:00');
    await issue({
      lines: [{ price: '100000', stages: [3000, 5000, 1000] }],
      channelId: shopee,
      windowId: JOKO,
      pay: [{ amount: '31500', method: 'QRIS' }],
    });
    await issue({ lines: [{ price: '200000' }], invoiceStages: [1000] });
    const voided = await issue({ lines: [{ price: '45000' }], windowId: JOKO });
    await voidInvoice(voided.id, 'Salah kanal', JOKO);
    nowMs = wib('2026-09-30', '20:00');
  }

  test('every figure in the CSV and the printed document equals the DTO', async () => {
    await busyDay();
    const input = { date: '2026-09-30' };
    const report = await daily(input);
    const target = path.join(h.dir, 'laporan.csv');
    dialogs.csvAnswers.push(target);
    const exported = value(
      await h.call<ReportOutcomeDto>(C.reports.exportCsv, input),
    );
    expect(exported).toEqual({ outcome: 'PRINTED', fileName: 'laporan.csv' });
    expect(dialogs.csvCalls).toEqual(['laporan-harian-2026-09-30.csv']);
    const preview = value(
      await h.call<ReportPreviewDto>(C.reports.preview, input),
    );
    expect(preview.pageInfo).toMatchObject({ format: 'A4', paginated: true });
    const printed = value(
      await h.call<ReportOutcomeDto>(C.reports.print, input),
    );
    expect(printed.outcome).toBe('PRINTED');
    // Print sends exactly the previewed document.
    expect(driver.printCalls).toHaveLength(1);
    expect(driver.printCalls[0]!.html).toBe(preview.html);
    expect(driver.printCalls[0]!.options).toEqual({
      format: 'A4',
      silent: false,
    });

    // ---- CSV ----
    const csv = csvReport(readFileSync(target, 'utf8'));
    expect(csv.header[L.date]).toBe('2026-09-30');
    expect(csv.header[L.timezone]).toBe(TZ);
    expect(csv.header[L.generatedAt]).toBe('2026-09-30 20:00');
    expect(csv.header[L.cashierFilter]).toBe(L.all);
    expect(csv.summary).toEqual({
      [L.invoiceCount]: String(report.sales.invoiceCount),
      [L.grossSubtotal]: report.sales.grossSubtotal,
      [L.itemDiscounts]: report.sales.itemDiscounts,
      [L.invoiceDiscounts]: report.sales.invoiceDiscounts,
      [L.netBeforeVoids]: report.sales.netBeforeVoids,
      [L.voidCount]: String(report.voids.count),
      [L.voidDeduction]: report.voids.deduction,
      [L.netAfterVoids]: report.netAfterVoids,
    });
    expect(csv.byChannel).toEqual(
      report.sales.byChannel.map((r) => [
        r.channel.label,
        String(r.invoiceCount),
        r.netBeforeVoids,
      ]),
    );
    expect(csv.byCashier).toEqual(
      report.sales.byCashier.map((r) => [
        r.cashier.displayName,
        String(r.invoiceCount),
        r.netBeforeVoids,
      ]),
    );
    expect(csv.voids.map((r) => r.map(csvText))).toEqual(
      report.voids.invoices.map((v) => [
        v.invoiceNumber,
        v.finalizedDate,
        v.voidedAtLocal,
        v.voidedBy.displayName,
        v.channel.label,
        v.reason,
        v.amount,
      ]),
    );
    expect(csv.byMethod).toEqual(
      report.payments.byMethod.map((m) => [
        L.paymentMethod[m.method],
        String(m.count),
        m.amount,
      ]),
    );
    expect(csv.split).toEqual({
      [L.received]: report.payments.received,
      [L.sameDayInvoices]: report.payments.sameDayInvoices,
      [L.olderInvoices]: report.payments.olderInvoices,
      [L.paymentCount]: String(report.payments.count),
    });

    // ---- print ----
    const { money, counts } = scrapeHtml(preview.html);
    const expected: Record<string, string> = {
      'sales.grossSubtotal': report.sales.grossSubtotal,
      'sales.itemDiscounts': report.sales.itemDiscounts,
      'sales.invoiceDiscounts': report.sales.invoiceDiscounts,
      'sales.netBeforeVoids': report.sales.netBeforeVoids,
      'voids.deduction': report.voids.deduction,
      netAfterVoids: report.netAfterVoids,
      'payments.received': report.payments.received,
      'payments.sameDayInvoices': report.payments.sameDayInvoices,
      'payments.olderInvoices': report.payments.olderInvoices,
    };
    report.sales.byChannel.forEach((r, i) => {
      expected[`sales.byChannel.${i}.netBeforeVoids`] = r.netBeforeVoids;
    });
    report.sales.byCashier.forEach((r, i) => {
      expected[`sales.byCashier.${i}.netBeforeVoids`] = r.netBeforeVoids;
    });
    report.voids.invoices.forEach((v, i) => {
      expected[`voids.invoices.${i}.amount`] = v.amount;
    });
    report.payments.byMethod.forEach((m) => {
      expected[`payments.byMethod.${m.method}.amount`] = m.amount;
    });
    expect(money).toEqual(expected);
    expect(counts).toMatchObject({
      'sales.invoiceCount': report.sales.invoiceCount,
      'voids.count': report.voids.count,
      'payments.count': report.payments.count,
    });
    expect(preview.html).toContain(TZ);
    expect(preview.html).toContain('30/09/2026 20:00');
    for (const v of report.voids.invoices) {
      expect(preview.html).toContain(v.invoiceNumber);
    }
    expect(preview.html).not.toMatch(/<script|https?:\/\/|@import|url\(/i);
  });

  test('a negative net after voids renders safely in CSV and print', async () => {
    nowMs = wib('2026-09-30', '10:00');
    const c = await issue({ lines: [{ price: '250000' }] });
    nowMs = wib('2026-10-02', '10:00');
    await voidInvoice(c.id, 'Batal');
    const target = path.join(h.dir, 'negatif.csv');
    dialogs.csvAnswers.push(target);
    value(await h.call(C.reports.exportCsv, { date: '2026-10-02' }));
    const text = readFileSync(target, 'utf8');
    const csv = csvReport(text);
    // The only signed field: emitted as guarded text, never a live '-' cell.
    expect(csv.summary[L.netAfterVoids]).toBe("'-250000");
    expect(text).not.toMatch(/(^|,)-\d/m);
    const preview = value(
      await h.call<ReportPreviewDto>(C.reports.preview, { date: '2026-10-02' }),
    );
    expect(scrapeHtml(preview.html).money.netAfterVoids).toBe('-250000');
    expect(preview.html).toContain('-Rp 250.000');
  });
});

// ---- CSV formula safety and export mechanics ----

describe('CSV export', () => {
  test('formula-like reasons and names are prefixed; money stays plain digits', async () => {
    const hostileName = '=HYPERLINK("http://evil.example","klik")';
    value(
      await h.call(
        C.cashiers.create,
        {
          username: 'eve',
          displayName: hostileName,
          password: 'eve-password-1',
          role: 'CASHIER',
        },
        ADMIN,
      ),
    );
    const eveId = await login('eve', 'eve-password-1', 4);
    nowMs = wib('2026-09-30', '10:00');
    const x = await issue({ lines: [{ price: '65000' }], windowId: 4 });
    const reason = '=HYPERLINK("http://evil.example","<b>klik</b>")';
    await voidInvoice(x.id, reason, 4);
    await issue({
      lines: [{ price: '10000' }],
      windowId: 4,
      pay: [{ amount: '10000' }],
    });

    const target = path.join(h.dir, 'aman.csv');
    dialogs.csvAnswers.push(target);
    value(
      await h.call(C.reports.exportCsv, {
        date: '2026-09-30',
        cashierId: eveId,
      }),
    );
    const text = readFileSync(target, 'utf8');
    const csv = csvReport(text);
    expect(csv.header[L.cashierFilter]).toBe(`'${hostileName}`);
    expect(csv.byCashier).toEqual([[`'${hostileName}`, '2', '75000']]);
    expect(csv.voids[0]![3]).toBe(`'${hostileName}`);
    expect(csv.voids[0]![5]).toBe(`'${reason}`);
    expect(csv.voids[0]![6]).toBe('65000');
    // RFC 4180 on disk: quotes doubled inside a quoted field.
    expect(text).toContain(
      '"\'=HYPERLINK(""http://evil.example"",""<b>klik</b>"")"',
    );
    // No cell anywhere starts with a formula trigger.
    for (const row of parseCsv(text)) {
      for (const cell of row) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    }
    // Print escapes the same values.
    const preview = value(
      await h.call<ReportPreviewDto>(C.reports.preview, {
        date: '2026-09-30',
        cashierId: eveId,
      }),
    );
    expect(preview.html).not.toContain('<b>klik</b>');
    expect(preview.html).toContain('&lt;b&gt;klik&lt;/b&gt;');
  });

  test('the reusable writer: BOM, CRLF, RFC 4180 quoting, formula guard', () => {
    const text = formatCsv([
      ['a,b', 'say "hi"', 'line\nbreak', null, ''],
      ['=1+1', '+62812', '-5', '@x', '\tTab', '\rCR'],
      [csvInteger(0n), csvInteger('31500'), csvInteger(7), csvInteger(-3n)],
      [],
    ]);
    expect(text).toBe(
      '﻿' +
        '"a,b","say ""hi""","line\nbreak",,\r\n' +
        "'=1+1,'+62812,'-5,'@x,'\tTab,\"'\rCR\"\r\n" +
        "0,31500,7,'-3\r\n" +
        '\r\n',
    );
    expect(() => csvInteger('12.5')).toThrow();
    expect(() => csvInteger('1e3')).toThrow();
  });

  test('cancelling the save dialog writes nothing and is not audited', async () => {
    dialogs.csvAnswers.push(null);
    const outcome = value(
      await h.call<ReportOutcomeDto>(C.reports.exportCsv, {
        date: '2026-09-30',
      }),
    );
    expect(outcome).toEqual({ outcome: 'CANCELLED' });
    expect(auditActions()).not.toContain('DAILY_REPORT_EXPORTED');
  });

  test('a write failure is an outcome, not a crash', async () => {
    dialogs.csvAnswers.push(path.join(h.dir, 'missing-dir', 'x.csv'));
    const outcome = value(
      await h.call<ReportOutcomeDto>(C.reports.exportCsv, {
        date: '2026-09-30',
      }),
    );
    expect(outcome).toEqual({ outcome: 'FAILED', code: 'EXPORT_FAILED' });
    expect(auditActions()).not.toContain('DAILY_REPORT_EXPORTED');
  });
});

// ---- printing ----

describe('printing the report', () => {
  async function configureA4(name: string | null) {
    value(
      await h.call(
        C.printing.updateSettings,
        {
          defaultInvoiceFormat: 'THERMAL',
          thermalPaperWidthMm: 58,
          defaultA4PrinterName: name,
          defaultThermalPrinterName: 'POS58',
          autoPrintAfterFinalize: false,
        },
        ADMIN,
      ),
    );
  }

  test('prints silently to the configured A4 printer', async () => {
    await configureA4('HP_LaserJet');
    driver.printers = [
      { name: 'POS58', displayName: 'POS58', isDefault: true },
      { name: 'HP_LaserJet', displayName: 'HP', isDefault: false },
    ];
    const outcome = value(
      await h.call<ReportOutcomeDto>(
        C.reports.print,
        { date: '2026-09-30' },
        SITI,
      ),
    );
    expect(outcome).toEqual({ outcome: 'PRINTED' });
    expect(driver.printCalls[0]!.options).toEqual({
      format: 'A4',
      deviceName: 'HP_LaserJet',
      silent: true,
    });
  });

  test('a missing A4 printer is PRINTER_NOT_FOUND with nothing sent elsewhere', async () => {
    await configureA4('HP_LaserJet');
    driver.printers = [
      { name: 'POS58', displayName: 'POS58', isDefault: true },
    ];
    const outcome = value(
      await h.call<ReportOutcomeDto>(C.reports.print, { date: '2026-09-30' }),
    );
    expect(outcome).toEqual({
      outcome: 'FAILED',
      code: 'PRINTER_NOT_FOUND',
      params: { printerName: 'HP_LaserJet' },
    });
    expect(driver.printCalls).toHaveLength(0);
    expect(auditActions()).not.toContain('DAILY_REPORT_PRINTED');
  });

  test('a cancelled or failed print is reported and not audited', async () => {
    driver.willReturn({ outcome: 'CANCELLED' }, new Error('driver down'));
    expect(
      value(
        await h.call<ReportOutcomeDto>(C.reports.print, { date: '2026-09-30' }),
      ),
    ).toEqual({ outcome: 'CANCELLED' });
    expect(
      value(
        await h.call<ReportOutcomeDto>(C.reports.print, { date: '2026-09-30' }),
      ),
    ).toEqual({ outcome: 'FAILED', code: 'PRINT_FAILED' });
    expect(auditActions()).not.toContain('DAILY_REPORT_PRINTED');
  });
});

// ---- authorization and audit ----

function auditActions(): string[] {
  return (
    h.db.prepare('SELECT action FROM audit_log ORDER BY rowid').all() as {
      action: string;
    }[]
  ).map((r) => r.action);
}

describe('authorization and audit', () => {
  test('signed-out callers are UNAUTHENTICATED on every report channel', async () => {
    for (const channel of [
      C.reports.daily,
      C.reports.preview,
      C.reports.print,
      C.reports.exportCsv,
    ]) {
      expect(
        failure(await h.call(channel, { date: '2026-09-30' }, NOBODY)).code,
      ).toBe('UNAUTHENTICATED');
    }
    expect(driver.printCalls).toHaveLength(0);
    expect(dialogs.csvCalls).toHaveLength(0);
  });

  test('a CASHIER may view, export and print; exports and prints are audited', async () => {
    nowMs = wib('2026-09-30', '10:00');
    await issue({ pay: [{ amount: '100000' }] });
    const report = await daily(
      { date: '2026-09-30', channelId: bengkel },
      SITI,
    );
    expect(report.sales.netBeforeVoids).toBe('100000');
    value(await h.call(C.reports.preview, { date: '2026-09-30' }, SITI));
    const target = path.join(h.dir, 'kasir.csv');
    dialogs.csvAnswers.push(target);
    value(
      await h.call(
        C.reports.exportCsv,
        { date: '2026-09-30', channelId: bengkel },
        SITI,
      ),
    );
    value(await h.call(C.reports.print, { date: '2026-09-30' }, SITI));
    const audits = h.db
      .prepare(
        `SELECT action, cashier_id, entity_type, entity_id, metadata, created_at FROM audit_log
          WHERE action LIKE 'DAILY_REPORT_%' ORDER BY rowid`,
      )
      .all() as Record<string, string>[];
    expect(
      audits.map((a) => ({ ...a, metadata: JSON.parse(a.metadata!) })),
    ).toEqual([
      {
        action: 'DAILY_REPORT_EXPORTED',
        cashier_id: sitiId,
        entity_type: 'daily_report',
        entity_id: '2026-09-30',
        metadata: {
          date: '2026-09-30',
          timezone: TZ,
          cashierId: null,
          channelId: bengkel,
          fileName: 'kasir.csv',
        },
        created_at: toInstant(nowMs),
      },
      {
        action: 'DAILY_REPORT_PRINTED',
        cashier_id: sitiId,
        entity_type: 'daily_report',
        entity_id: '2026-09-30',
        metadata: {
          date: '2026-09-30',
          timezone: TZ,
          cashierId: null,
          channelId: null,
        },
        created_at: toInstant(nowMs),
      },
    ]);
  });

  test('reading a report writes nothing', async () => {
    nowMs = wib('2026-09-30', '10:00');
    await issue({ pay: [{ amount: '100000' }] });
    const before = h.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get();
    await daily({ date: '2026-09-30' });
    value(await h.call(C.reports.preview, { date: '2026-09-30' }));
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()).toEqual(
      before,
    );
  });
});

// ---- performance ----

describe('query plans', () => {
  test('each section is an indexed range scan on its own instant', () => {
    const range = {
      start: '2026-09-29T17:00:00.000Z' as Instant,
      end: '2026-09-30T17:00:00.000Z' as Instant,
    };
    const plan = (query: { sql: string; params: unknown[] }) =>
      (
        h.db
          .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
          .all(...query.params) as {
          detail: string;
        }[]
      )
        .map((r) => r.detail)
        .join('\n');
    const sales = plan(REPORT_QUERIES.sales(range, {}));
    expect(sales).toMatch(
      /SEARCH i USING INDEX invoices_finalized_order \(finalized_at>\? AND finalized_at<\?\)/,
    );
    const voids = plan(REPORT_QUERIES.voids(range, {}));
    expect(voids).toMatch(
      /SEARCH i USING INDEX invoices_voided_at \(voided_at>\? AND voided_at<\?\)/,
    );
    const payments = plan(REPORT_QUERIES.paymentsByMethod(range, {}));
    expect(payments).toMatch(
      /SEARCH p USING INDEX payments_paid_at \(paid_at>\? AND paid_at<\?\)/,
    );
    // Invoices are reached by primary key; nothing scans every invoice.
    for (const detail of [sales, voids, payments]) {
      expect(detail).not.toMatch(/\bSCAN (i|p|invoices|payments)\b/);
    }
  });
});
