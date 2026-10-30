import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApplicationServices } from '@/main/compose';
import { openDatabase } from '@/main/database/connection';
import {
  bundledMigrations,
  migrateDatabase,
  readSchemaVersion,
} from '@/main/database/migrate';
import {
  pdfOptionsFor,
  printOptionsFor,
  THERMAL_PAGE_MICRONS,
} from '@/main/features/printing/driver-options';
import { escapeHtml } from '@/main/features/printing/escape';
import { formatIdr } from '@/shared/idr';
import { executeCommand } from '@/main/platform/command';
import { buildCommands } from '@/main/platform/commands';
import { CHANNELS } from '@/shared/channels';
import type {
  DraftView,
  InvoiceView,
  LogoChoiceDto,
  PrintFormat,
  PrintOptionsDto,
  PrintOutcomeDto,
  PrintPreviewDto,
  PrintSettingsDto,
  PrinterDto,
  ReferenceDto,
} from '@/shared/contracts';
import type { Instant, Result } from '@/shared/primitives';
import { toInstant } from '@/shared/time';
import {
  acceptanceInvoice,
  ADMIN_WINDOW,
  CASHIER_WINDOW,
  criticalInvoice,
  fixtureId,
  issueInvoice,
  LONG_TITLE,
  seedPrintShop,
  stockItem,
  type PrintShop,
} from '../fixtures/print-invoices';
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
 * Task 12: invoice printing. One print model per invoice (snapshots + current
 * payments), three presentations (A4, 58 mm, 80 mm), printing strictly after
 * commit and never touching committed business state. The real Electron
 * driver is replaced by FakePrintDriver; native dialogs by FakeDialogs.
 * T0 = 2026-09-30 10:00 WIB (Asia/Jakarta).
 */

const C = CHANNELS;
const NOBODY = 99;
const T0 = Date.UTC(2026, 8, 30, 3, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FORMATS: PrintFormat[] = ['A4', 'THERMAL_58', 'THERMAL_80'];

let h: Harness;
let driver: FakePrintDriver;
let dialogs: FakeDialogs;
let nowMs = T0;
let shop: PrintShop;
let scratch: string;
const now = (): Instant => toInstant(nowMs);
const priceStart = () => toInstant(T0 - 30 * DAY);

beforeEach(async () => {
  nowMs = T0;
  driver = new FakePrintDriver();
  dialogs = new FakeDialogs();
  h = createHarness({ clock: { now }, printDriver: driver, dialogs });
  scratch = mkdtempSync(path.join(tmpdir(), 'bengkelin-print-'));
  shop = await seedPrintShop(h.call, now);
});
afterEach(() => {
  h.close();
  rmSync(scratch, { recursive: true, force: true });
});

// ---- helpers ----

const rows = (sql: string, ...params: unknown[]) =>
  h.db.prepare(sql).all(...params) as Record<string, unknown>[];

/** Committed business state that printing must never touch. */
function businessState() {
  return JSON.stringify(
    [
      'invoices',
      'invoice_items',
      'invoice_item_discounts',
      'invoice_discounts',
      'payments',
      'stock_ledger_entries',
      'invoice_daily_counters',
    ].map((table) =>
      h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ),
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
}

function preview(invoiceId: string, format: PrintFormat, w = CASHIER_WINDOW) {
  return h.call<PrintPreviewDto>(C.printing.preview, { invoiceId, format }, w);
}
function print(invoiceId: string, format: PrintFormat, w = CASHIER_WINDOW) {
  return h.call<PrintOutcomeDto>(C.printing.print, { invoiceId, format }, w);
}
function getInvoice(invoiceId: string) {
  return h.call<InvoiceView>(C.invoices.get, { invoiceId }, CASHIER_WINDOW);
}
async function updatePrintSettings(changes: Record<string, unknown>) {
  const current = value(
    await h.call<PrintSettingsDto>(
      C.printing.getSettings,
      undefined,
      ADMIN_WINDOW,
    ),
  );
  return value(
    await h.call<PrintSettingsDto>(
      C.printing.updateSettings,
      { ...current, ...changes },
      ADMIN_WINDOW,
    ),
  );
}
function printJobs(invoiceId: string) {
  return rows(
    `SELECT format, action, requested_by, requested_at, outcome, error_code, is_reprint
       FROM print_jobs WHERE invoice_id = ? ORDER BY rowid`,
    invoiceId,
  );
}

/** Every money value a template prints, keyed by its data-money field. */
function moneyFields(html: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of html.matchAll(/data-money="([^"]+)"[^>]*>([^<]*)</g)) {
    const [, key, text] = match as unknown as [string, string, string];
    if (found.has(key) && found.get(key) !== text) {
      throw new Error(`${key} printed with two values`);
    }
    found.set(key, text);
  }
  return found;
}

function pngBytes(size = 200): Buffer {
  const bytes = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
}

function writeScratch(name: string, bytes: Buffer): string {
  const file = path.join(scratch, name);
  writeFileSync(file, bytes);
  return file;
}

// ---- the brief's required assertions ----

describe('one print model, three presentations', () => {
  test('the requesting cashier format reaches every layout without altering business values', async () => {
    const invoice = await criticalInvoice(shop, priceStart());
    const before = businessState();
    value(
      await h.call(
        C.settings.updatePreferences,
        { language: 'id', appearance: 'SYSTEM', numberFormat: 'US' },
        CASHIER_WINDOW,
      ),
    );
    for (const format of FORMATS) {
      expect(
        moneyFields(value(await preview(invoice.id, format)).html).get(
          'amount',
        ),
      ).toBe('Rp 31,500');
      expect(
        moneyFields(
          value(await preview(invoice.id, format, ADMIN_WINDOW)).html,
        ).get('amount'),
      ).toBe('Rp 31.500');
    }
    value(await print(invoice.id, 'THERMAL_80'));
    expect(moneyFields(driver.printCalls.at(-1)!.html).get('amount')).toBe(
      'Rp 31,500',
    );
    dialogs.saveAnswers.push(path.join(scratch, 'localized.pdf'));
    value(
      await h.call(
        C.printing.exportPdf,
        { invoiceId: invoice.id },
        CASHIER_WINDOW,
      ),
    );
    expect(moneyFields(driver.pdfCalls.at(-1)!.html).get('amount')).toBe(
      'Rp 31,500',
    );
    expect(businessState()).toBe(before);
  });

  test('required assertions: 31500 in every format and FINALIZED after a print failure', async () => {
    const invoice = await criticalInvoice(shop, priceStart());
    const printing = h.services.printing;
    const a4 = printing.renderInvoice(invoice.id, 'A4');
    const thermal58 = printing.renderInvoice(invoice.id, 'THERMAL_58');
    const thermal80 = printing.renderInvoice(invoice.id, 'THERMAL_80');

    expect(a4.model.amount).toBe('31500');
    expect(thermal58.model.amount).toBe(a4.model.amount);
    expect(thermal80.model.amount).toBe(a4.model.amount);

    const before = businessState();
    driver.willReturn({ outcome: 'FAILED', code: 'PRINT_FAILED' });
    const outcome = value(await print(invoice.id, 'THERMAL_58'));
    expect(outcome.outcome).toBe('FAILED');
    const invoiceAfterPrintFailure = value(await getInvoice(invoice.id));
    expect(invoiceAfterPrintFailure.status).toBe('FINALIZED');
    expect(businessState()).toBe(before);
  });

  test('the critical calculation (spec 58) prints Rp 31.500 with its three stages', async () => {
    const invoice = await criticalInvoice(shop, priceStart());
    const { model } = h.services.printing.renderInvoice(invoice.id, 'A4');
    expect(model.subtotal).toBe('100000');
    expect(model.lines[0]!.discounts.map((d) => d.amount)).toEqual([
      '30000',
      '35000',
      '3500',
    ]);
    expect(model.discountAmount).toBe('68500');
    for (const format of FORMATS) {
      const { html } = value(await preview(invoice.id, format));
      const money = moneyFields(html);
      expect(money.get('amount')).toBe('Rp 31.500');
      expect(money.get('line-1-amount')).toBe('Rp 31.500');
      expect(money.get('line-1-stage-1')).toBe('Rp 30.000');
      expect(money.get('line-1-stage-2')).toBe('Rp 35.000');
      expect(money.get('line-1-stage-3')).toBe('Rp 3.500');
    }
  });

  test('the model comes from the invoice snapshots and current payments', async () => {
    nowMs = T0;
    const invoice = await acceptanceInvoice(shop, priceStart());
    nowMs = T0 + 2 * HOUR;
    value(
      await h.call(
        C.invoices.recordPayment,
        {
          requestId: fixtureId(),
          invoiceId: invoice.id,
          method: 'BANK_TRANSFER',
          amount: '100000',
          reference: 'TRF-889',
        },
        CASHIER_WINDOW,
      ),
    );
    const view = value(await getInvoice(invoice.id));
    const model = h.services.printing.buildInvoicePrintModel(invoice.id);

    expect(model.invoiceNumber).toBe('INV-20260930-0001');
    expect(model.amount).toBe(view.totals.amount);
    expect(model.subtotal).toBe(view.totals.subtotal);
    expect(model.itemDiscountAmount).toBe(view.totals.itemDiscountAmount);
    expect(model.invoiceDiscountAmount).toBe(view.totals.invoiceDiscountAmount);
    expect(model.discountAmount).toBe(view.totals.discountAmount);
    expect(model.paidAmount).toBe(view.paidAmount);
    expect(model.outstanding).toBe(view.outstandingAmount);
    expect(model.paymentStatus).toBe('PARTIALLY_PAID');
    expect(
      model.payments.map((p) => [p.method, p.amount, p.reference]),
    ).toEqual([
      ['CASH', '250000', null],
      ['BANK_TRANSFER', '100000', 'TRF-889'],
    ]);
    expect(model.payments[1]!.paidAtLocal).toBe('2026-09-30 12:00');
    expect(model.finalizedAtLocal).toBe('2026-09-30 10:00');
    expect(model.topDays).toBe(14);
    expect(model.dueDate).toBe('2026-10-14');
    expect(model.channel).toBe('Bengkel');
    expect(model.cashier).toBe('Siti Rahmawati');
    expect(model.customer).toEqual({
      name: 'Andi Wijaya Kusumanegara',
      phoneNumber: '0812-3456-7890',
    });
    expect(model.vehicle).toEqual({
      plateNumber: 'D 1234 ABC',
      description: 'Honda Vario 160 ABS',
    });
    expect(model.odometerKm).toBe(23456);
    expect(model.lines).toHaveLength(42);
    expect(model.lines[0]!.title).toBe(LONG_TITLE);
    expect(model.lines[1]!.mechanicName).toBe('Joko Susilo');
    expect(model.invoiceDiscounts.map((d) => d.percentageBps)).toEqual([
      500, 250,
    ]);
    expect(model.shop.name).toBe('Bengkel Maju Jaya Motor');
    expect(model.language).toBe('id');
    expect(model.isReprint).toBe(false);
    expect(model.void).toBeNull();
    // Every money value is a Rupiah string.
    const moneyKeys = [
      'subtotal',
      'itemDiscountAmount',
      'invoiceDiscountAmount',
      'discountAmount',
      'amount',
      'paidAmount',
      'outstanding',
    ] as const;
    for (const key of moneyKeys) expect(model[key]).toMatch(/^-?\d+$/);
    // Snapshot independence: renaming master data changes nothing printed.
    value(
      await h.call(
        C.references.save,
        { entity: 'mechanic', id: shop.mechanicId, name: 'Nama Baru' },
        ADMIN_WINDOW,
      ),
    );
    expect(h.services.printing.buildInvoicePrintModel(invoice.id)).toEqual(
      model,
    );
  });

  test('spec 61 fixtures: all three formats print identical financial data', async () => {
    const acceptance = await acceptanceInvoice(shop, priceStart());
    value(
      await h.call(
        C.invoices.recordPayment,
        {
          requestId: fixtureId(),
          invoiceId: acceptance.id,
          method: 'QRIS',
          amount: '50000',
        },
        CASHIER_WINDOW,
      ),
    );
    const critical = await criticalInvoice(shop, priceStart());
    for (const invoice of [acceptance, critical]) {
      const model = h.services.printing.buildInvoicePrintModel(invoice.id);
      const printed = await Promise.all(
        FORMATS.map(async (format) => value(await preview(invoice.id, format))),
      );
      const money = printed.map((p) => moneyFields(p.html));
      // Same fields, same values, in every format.
      expect(money[1]).toEqual(money[0]);
      expect(money[2]).toEqual(money[0]);
      // And they are exactly the model's values.
      const expected = new Map<string, string>([
        ['subtotal', formatIdr(model.subtotal)],
        ['itemDiscountAmount', formatIdr(model.itemDiscountAmount)],
        ['invoiceDiscountAmount', formatIdr(model.invoiceDiscountAmount)],
        ['discountAmount', formatIdr(model.discountAmount)],
        ['amount', formatIdr(model.amount)],
        ['paidAmount', formatIdr(model.paidAmount)],
        ['outstanding', formatIdr(model.outstanding)],
      ]);
      model.lines.forEach((line, i) => {
        const n = i + 1;
        expected.set(`line-${n}-unitPrice`, formatIdr(line.unitPrice));
        expected.set(`line-${n}-amount`, formatIdr(line.amount));
        line.discounts.forEach((stage) =>
          expected.set(
            `line-${n}-stage-${stage.sequence}`,
            formatIdr(stage.amount),
          ),
        );
      });
      model.invoiceDiscounts.forEach((stage) =>
        expected.set(
          `invoice-stage-${stage.sequence}`,
          formatIdr(stage.amount),
        ),
      );
      model.payments.forEach((payment, i) =>
        expected.set(`payment-${i + 1}`, formatIdr(payment.amount)),
      );
      expect(money[0]).toEqual(expected);

      for (const p of printed) {
        expect(p.html).toContain(model.invoiceNumber);
        expect(p.html.startsWith('<!doctype html>')).toBe(true);
      }
    }
  });

  test('every layout shows the required fields; the thermal layouts differ', async () => {
    const invoice = await acceptanceInvoice(shop, priceStart());
    const pages = await Promise.all(
      FORMATS.map(async (format) => value(await preview(invoice.id, format))),
    );
    for (const { html } of pages) {
      for (const text of [
        'Bengkel Maju Jaya Motor',
        'Jl. Merdeka No. 1',
        '022-4201234',
        'halo@majujaya.example',
        'Garansi servis 7 hari',
        'INV-20260930-0001',
        '30/09/2026',
        '10:00',
        '14/10/2026',
        '14 hari',
        'Bengkel',
        'Siti Rahmawati',
        'Andi Wijaya Kusumanegara',
        'D 1234 ABC',
        'Honda Vario 160 ABS',
        '23.456 km',
        'Kampas rem cakram depan original Honda Vario',
        'Joko Susilo',
        'Tunai',
        'Dibayar sebagian',
        'Pelanggan minta bagian lama dikembalikan.',
      ]) {
        expect(html).toContain(text);
      }
    }
    const [a4, t58, t80] = pages as [
      PrintPreviewDto,
      PrintPreviewDto,
      PrintPreviewDto,
    ];
    expect(a4.pageInfo).toEqual({
      format: 'A4',
      widthMm: 210,
      heightMm: 297,
      printableWidthMm: 186,
      paginated: true,
    });
    expect(t58.pageInfo).toEqual({
      format: 'THERMAL_58',
      widthMm: 58,
      heightMm: null,
      printableWidthMm: 48,
      paginated: false,
    });
    expect(t80.pageInfo).toMatchObject({
      format: 'THERMAL_80',
      widthMm: 80,
      printableWidthMm: 72,
    });
    // A4: repeated header rows and page numbers.
    expect(a4.html).toContain('display: table-header-group');
    expect(a4.html).toMatch(/counter\(page\)/);
    expect(a4.html).toContain('Hal. ');
    // Separate thermal layouts that adapt to the paper width.
    expect(t58.html).toContain('width: 48mm');
    expect(t80.html).toContain('width: 72mm');
    expect(t58.html).not.toBe(t80.html.replace('72mm', '48mm'));
    expect(t58.html).toContain('layout-58');
    expect(t80.html).toContain('layout-80');
    for (const { html } of pages) {
      expect(html).toContain('tabular-nums');
      // No scripts and no remote assets; system fonts only.
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/https?:\/\//i);
      expect(html).not.toMatch(/@import|@font-face|url\(/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    }
  });

  test('Indonesian shop language controls print labels despite English admin preference', async () => {
    value(
      await h.call(
        C.settings.updatePreferences,
        { language: 'en', appearance: 'SYSTEM' },
        ADMIN_WINDOW,
      ),
    );
    const invoice = await acceptanceInvoice(shop, priceStart(), 3);
    for (const format of FORMATS) {
      const { html } = value(await preview(invoice.id, format, ADMIN_WINDOW));
      expect(html).toContain('FAKTUR');
      expect(html).toContain('Dibayar sebagian');
      expect(html).toContain('Tunai');
      expect(html).toContain('14 hari');
      expect(html).not.toContain('Partially paid');
    }
    const { html } = value(await preview(invoice.id, 'A4', ADMIN_WINDOW));
    expect(html).toContain('Hal. ');
    expect(html).toContain('<html lang="id">');
  });
});

test('English shop language controls all print formats and reprint labels', async () => {
  const english = createHarness({
    clock: { now },
    printDriver: new FakePrintDriver(),
    dialogs: new FakeDialogs(),
  });
  try {
    const englishShop = await seedPrintShop(english.call, now, 'en');
    const invoice = await acceptanceInvoice(englishShop, priceStart(), 3);
    for (const format of FORMATS) {
      const { html } = value(
        await english.call<PrintPreviewDto>(
          C.printing.preview,
          { invoiceId: invoice.id, format },
          CASHIER_WINDOW,
        ),
      );
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('INVOICE');
      expect(html).toContain('Partially paid');
      expect(html).toContain('Cash');
      expect(html).toContain('14 days');
      expect(html).not.toContain('Dibayar sebagian');
    }
    value(
      await english.call<PrintOutcomeDto>(
        C.printing.print,
        { invoiceId: invoice.id, format: 'A4' },
        CASHIER_WINDOW,
      ),
    );
    const { html } = value(
      await english.call<PrintPreviewDto>(
        C.printing.preview,
        { invoiceId: invoice.id, format: 'A4' },
        CASHIER_WINDOW,
      ),
    );
    expect(html).toContain('REPRINT');
    expect(html).toContain('Page ');
    expect(html).not.toContain('CETAK ULANG');
  } finally {
    english.close();
  }
});

// ---- escaping ----

describe('HTML escaping', () => {
  test('the escape helper escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });

  test('hostile titles, names and notes are printed as text in every format', async () => {
    const hostile = `<script>alert("x")</script> & "q" <img src=x onerror=alert(1)>`;
    const invoice = await issueInvoice(shop, {
      lines: [
        {
          custom: { type: 'NON_STOCK_ITEM', title: hostile, price: '10000' },
        },
      ],
      note: `</style><img onerror=alert(2) src=y>`,
    });
    for (const format of FORMATS) {
      const { html } = value(await preview(invoice.id, format));
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img src=x onerror');
      expect(html).not.toContain('<img onerror');
      expect(html).not.toMatch(/<\/style><img/);
      expect(html).toContain(
        '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;q&quot; &lt;img src=x onerror=alert(1)&gt;',
      );
      expect(html).toContain(
        '&lt;/style&gt;&lt;img onerror=alert(2) src=y&gt;',
      );
    }
  });
});

// ---- reprints and VOID ----

describe('reprints and VOID', () => {
  test('REPRINT is marked only after the first successful print', async () => {
    const invoice = await criticalInvoice(shop, priceStart());
    expect(value(await preview(invoice.id, 'A4')).html).not.toContain(
      'CETAK ULANG',
    );

    // A failed and a cancelled attempt do not make the next print a reprint.
    driver.willReturn(
      { outcome: 'FAILED', code: 'PRINT_FAILED' },
      { outcome: 'CANCELLED' },
    );
    expect(value(await print(invoice.id, 'A4')).outcome).toBe('FAILED');
    expect(value(await print(invoice.id, 'A4')).outcome).toBe('CANCELLED');
    expect(value(await preview(invoice.id, 'A4')).html).not.toContain(
      'CETAK ULANG',
    );

    const first = value(await print(invoice.id, 'THERMAL_58'));
    expect(first).toMatchObject({
      outcome: 'PRINTED',
      format: 'THERMAL_58',
      isReprint: false,
    });
    expect(driver.printCalls[2]!.html).not.toContain('CETAK ULANG');

    nowMs += HOUR;
    for (const format of FORMATS) {
      const { html } = value(await preview(invoice.id, format));
      expect(html).toContain('CETAK ULANG');
    }
    expect(
      h.services.printing.buildInvoicePrintModel(invoice.id).isReprint,
    ).toBe(true);
    const second = value(await print(invoice.id, 'A4', ADMIN_WINDOW));
    expect(second).toMatchObject({ outcome: 'PRINTED', isReprint: true });
    expect(driver.printCalls[3]!.html).toContain('CETAK ULANG');

    const cashierId = rows(
      `SELECT id FROM cashiers WHERE username = 'siti'`,
    )[0]!.id;
    const adminId = rows(`SELECT id FROM cashiers WHERE username = 'admin'`)[0]!
      .id;
    expect(printJobs(invoice.id)).toEqual([
      {
        format: 'A4',
        action: 'PRINT',
        requested_by: cashierId,
        requested_at: toInstant(T0),
        outcome: 'FAILED',
        error_code: 'PRINT_FAILED',
        is_reprint: 0n,
      },
      {
        format: 'A4',
        action: 'PRINT',
        requested_by: cashierId,
        requested_at: toInstant(T0),
        outcome: 'CANCELLED',
        error_code: null,
        is_reprint: 0n,
      },
      {
        format: 'THERMAL_58',
        action: 'PRINT',
        requested_by: cashierId,
        requested_at: toInstant(T0),
        outcome: 'PRINTED',
        error_code: null,
        is_reprint: 0n,
      },
      {
        format: 'A4',
        action: 'PRINT',
        requested_by: adminId,
        requested_at: toInstant(T0 + HOUR),
        outcome: 'PRINTED',
        error_code: null,
        is_reprint: 1n,
      },
    ]);
    // Audit: the print and the reprint (spec 47).
    const audit = rows(
      `SELECT action, cashier_id, metadata FROM audit_log
        WHERE action IN ('INVOICE_PRINTED', 'INVOICE_REPRINTED') ORDER BY id`,
    );
    expect(audit.map((a) => [a.action, a.cashier_id])).toEqual([
      ['INVOICE_PRINTED', cashierId],
      ['INVOICE_REPRINTED', adminId],
    ]);
    expect(JSON.parse(String(audit[1]!.metadata))).toEqual({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      format: 'A4',
      isReprint: true,
    });
    // print_jobs is append-only.
    expect(() =>
      h.db.prepare('UPDATE print_jobs SET outcome = ?').run('FAILED'),
    ).toThrow(/append-only/);
    expect(() => h.db.prepare('DELETE FROM print_jobs').run()).toThrow(
      /append-only/,
    );
  });

  test('Indonesian reprint marking ignores English admin preference', async () => {
    value(
      await h.call(
        C.settings.updatePreferences,
        { language: 'en', appearance: 'SYSTEM' },
        ADMIN_WINDOW,
      ),
    );
    const invoice = await criticalInvoice(shop, priceStart());
    value(await print(invoice.id, 'A4'));
    const { html } = value(await preview(invoice.id, 'A4', ADMIN_WINDOW));
    expect(html).toContain('CETAK ULANG');
    expect(html).not.toContain('REPRINT');
  });

  test('a VOID invoice prints a prominent VOID watermark and the reason', async () => {
    const invoice = await criticalInvoice(shop, priceStart());
    value(
      await h.call(
        C.invoices.void,
        {
          requestId: fixtureId(),
          invoiceId: invoice.id,
          reason: 'Salah input <barang> & harga',
        },
        CASHIER_WINDOW,
      ),
    );
    const model = h.services.printing.buildInvoicePrintModel(invoice.id);
    expect(model.status).toBe('VOID');
    expect(model.void).toMatchObject({
      reason: 'Salah input <barang> & harga',
      voidedBy: 'Siti Rahmawati',
    });
    for (const format of FORMATS) {
      const { html } = value(await preview(invoice.id, format));
      expect(html).toContain('class="void-watermark"');
      expect(html).toContain('DIBATALKAN (VOID)');
      expect(html).toContain('Salah input &lt;barang&gt; &amp; harga');
      // The financial data stays exactly as issued.
      expect(moneyFields(html).get('amount')).toBe('Rp 31.500');
    }
    const outcome = value(await print(invoice.id, 'A4'));
    expect(outcome.outcome).toBe('PRINTED');
    expect(driver.printCalls[0]!.html).toContain('void-watermark');
  });
});

// ---- printer selection and failure isolation ----

describe('printer selection and failures', () => {
  let invoice: InvoiceView;
  let before: string;

  beforeEach(async () => {
    invoice = await criticalInvoice(shop, priceStart());
    driver.printers = [
      { name: 'HP_LaserJet', displayName: 'HP LaserJet', isDefault: true },
      { name: 'POS58', displayName: 'POS-58', isDefault: false },
    ];
    before = businessState();
  });

  afterEach(async () => {
    // Printing never changed the invoice, its payments or stock.
    expect(businessState()).toBe(before);
    expect(value(await getInvoice(invoice.id)).status).toBe('FINALIZED');
  });

  test('no printer configured: the OS print dialog is shown', async () => {
    const outcome = value(await print(invoice.id, 'A4'));
    expect(outcome.outcome).toBe('PRINTED');
    expect(driver.printCalls).toHaveLength(1);
    expect(driver.printCalls[0]!.options).toEqual({
      format: 'A4',
      silent: false,
    });
  });

  test('a configured printer that is present prints silently to it', async () => {
    await updatePrintSettings({
      defaultA4PrinterName: 'HP_LaserJet',
      defaultThermalPrinterName: 'POS58',
    });
    value(await print(invoice.id, 'A4'));
    value(await print(invoice.id, 'THERMAL_80'));
    expect(driver.printCalls.map((c) => c.options)).toEqual([
      { format: 'A4', deviceName: 'HP_LaserJet', silent: true },
      { format: 'THERMAL_80', deviceName: 'POS58', silent: true },
    ]);
  });

  test('a configured printer that is missing is PRINTER_NOT_FOUND, never another printer', async () => {
    await updatePrintSettings({ defaultThermalPrinterName: 'EPSON_TM_T82' });
    const outcome = value(await print(invoice.id, 'THERMAL_58'));
    expect(outcome).toEqual({
      outcome: 'FAILED',
      code: 'PRINTER_NOT_FOUND',
      params: { printerName: 'EPSON_TM_T82' },
      format: 'THERMAL_58',
      isReprint: false,
    });
    expect(driver.printCalls).toHaveLength(0);
    expect(printJobs(invoice.id)).toMatchObject([
      { outcome: 'FAILED', error_code: 'PRINTER_NOT_FOUND' },
    ]);
    // A4 (no A4 printer configured) still uses the dialog.
    value(await print(invoice.id, 'A4'));
    expect(driver.printCalls[0]!.options.silent).toBe(false);
  });

  test('a print that timed out is a FAILED PRINT_TIMEOUT outcome, logged in print_jobs (I1)', async () => {
    driver.willReturn({ outcome: 'FAILED', code: 'PRINT_TIMEOUT' });
    expect(value(await print(invoice.id, 'A4'))).toMatchObject({
      outcome: 'FAILED',
      code: 'PRINT_TIMEOUT',
    });
    expect(printJobs(invoice.id)).toMatchObject([
      { outcome: 'FAILED', error_code: 'PRINT_TIMEOUT' },
    ]);
    // A retry prints (the busy state was released).
    value(await print(invoice.id, 'A4'));
    expect(printJobs(invoice.id)).toMatchObject([
      { outcome: 'FAILED', error_code: 'PRINT_TIMEOUT' },
      { outcome: 'PRINTED', error_code: null },
    ]);
  });

  test('a driver failure, a thrown error and a cancellation are outcomes; a retry prints', async () => {
    driver.willReturn(
      { outcome: 'FAILED', code: 'PRINT_FAILED' },
      new Error('printer on fire'),
      { outcome: 'CANCELLED' },
    );
    expect(value(await print(invoice.id, 'A4'))).toMatchObject({
      outcome: 'FAILED',
      code: 'PRINT_FAILED',
    });
    expect(value(await print(invoice.id, 'A4'))).toMatchObject({
      outcome: 'FAILED',
      code: 'PRINT_FAILED',
    });
    expect(value(await print(invoice.id, 'A4'))).toMatchObject({
      outcome: 'CANCELLED',
    });
    // Retry after failure.
    expect(value(await print(invoice.id, 'A4'))).toMatchObject({
      outcome: 'PRINTED',
      isReprint: false,
    });
    expect(printJobs(invoice.id).map((j) => [j.outcome, j.error_code])).toEqual(
      [
        ['FAILED', 'PRINT_FAILED'],
        ['FAILED', 'PRINT_FAILED'],
        ['CANCELLED', null],
        ['PRINTED', null],
      ],
    );
  });

  test('printer enumeration fails: FAILED, nothing printed', async () => {
    await updatePrintSettings({ defaultA4PrinterName: 'HP_LaserJet' });
    driver.listPrinters = async () => {
      throw new Error('cups down');
    };
    expect(value(await print(invoice.id, 'A4'))).toMatchObject({
      outcome: 'FAILED',
      code: 'PRINT_FAILED',
    });
    expect(driver.printCalls).toHaveLength(0);
  });
});

// ---- PDF export ----

describe('A4 PDF export', () => {
  test('writes the A4 PDF to the chosen file, named after the invoice', async () => {
    const invoice = await criticalInvoice(shop, priceStart());
    const target = path.join(scratch, 'faktur.pdf');
    dialogs.saveAnswers.push(target);
    const before = businessState();
    const outcome = value(
      await h.call<PrintOutcomeDto>(
        C.printing.exportPdf,
        { invoiceId: invoice.id },
        CASHIER_WINDOW,
      ),
    );
    expect(outcome).toMatchObject({
      outcome: 'PRINTED',
      format: 'A4',
      fileName: 'faktur.pdf',
    });
    expect(dialogs.saveCalls).toEqual(['INV-20260930-0001.pdf']);
    expect(driver.pdfCalls).toHaveLength(1);
    expect(driver.pdfCalls[0]!.format).toBe('A4');
    expect(driver.pdfCalls[0]!.html).toContain('INV-20260930-0001');
    expect(readFileSync(target)).toEqual(Buffer.from(driver.pdfBytes));
    expect(printJobs(invoice.id)).toMatchObject([
      { action: 'PDF_EXPORT', format: 'A4', outcome: 'PRINTED' },
    ]);
    expect(
      rows(
        `SELECT action FROM audit_log WHERE action = 'INVOICE_PDF_EXPORTED'`,
      ),
    ).toHaveLength(1);
    expect(businessState()).toBe(before);
    // A PDF export is not a print: the next print is not a reprint.
    expect(value(await print(invoice.id, 'A4')).isReprint).toBe(false);
  });

  test('cancelling the save dialog is CANCELLED and writes nothing', async () => {
    const invoice = await criticalInvoice(shop, priceStart());
    dialogs.saveAnswers.push(null);
    const outcome = value(
      await h.call<PrintOutcomeDto>(
        C.printing.exportPdf,
        { invoiceId: invoice.id },
        CASHIER_WINDOW,
      ),
    );
    expect(outcome.outcome).toBe('CANCELLED');
    expect(driver.pdfCalls).toHaveLength(0);
  });

  test('a PDF rendering failure is FAILED', async () => {
    const invoice = await criticalInvoice(shop, priceStart());
    dialogs.saveAnswers.push(path.join(scratch, 'x.pdf'));
    driver.printToPdf = async () => {
      throw new Error('boom');
    };
    const outcome = value(
      await h.call<PrintOutcomeDto>(
        C.printing.exportPdf,
        { invoiceId: invoice.id },
        CASHIER_WINDOW,
      ),
    );
    expect(outcome).toMatchObject({ outcome: 'FAILED', code: 'PDF_FAILED' });
    expect(existsSync(path.join(scratch, 'x.pdf'))).toBe(false);
  });
});

// ---- driver unit conversions ----

describe('real driver page sizes', () => {
  test('print uses microns for thermal custom sizes; printToPDF uses inches', () => {
    expect(THERMAL_PAGE_MICRONS).toEqual({
      THERMAL_58: 58000,
      THERMAL_80: 80000,
    });
    expect(printOptionsFor('THERMAL_58', 123456)).toMatchObject({
      pageSize: { width: 58000, height: 123456 },
      margins: { marginType: 'none' },
      printBackground: true,
    });
    expect(printOptionsFor('THERMAL_80', 100)).toMatchObject({
      pageSize: { width: 80000, height: 10000 },
    });
    expect(printOptionsFor('A4', 0)).toMatchObject({ pageSize: 'A4' });
    expect(pdfOptionsFor('A4', 0)).toMatchObject({
      pageSize: 'A4',
      preferCSSPageSize: true,
      printBackground: true,
    });
    const thermal = pdfOptionsFor('THERMAL_58', 254000);
    expect(thermal.pageSize).toEqual({ width: 58 / 25.4, height: 10 });
  });
});

// ---- print settings and authorization ----

describe('print settings', () => {
  test('defaults: THERMAL, 58 mm, no printers, auto-print off', async () => {
    const settings = value(
      await h.call<PrintSettingsDto>(
        C.printing.getSettings,
        undefined,
        ADMIN_WINDOW,
      ),
    );
    expect(settings).toEqual({
      defaultInvoiceFormat: 'THERMAL',
      thermalPaperWidthMm: 58,
      defaultA4PrinterName: null,
      defaultThermalPrinterName: null,
      autoPrintAfterFinalize: false,
    });
    expect(
      value(
        await h.call<PrintOptionsDto>(
          C.printing.getOptions,
          undefined,
          CASHIER_WINDOW,
        ),
      ),
    ).toEqual({
      defaultInvoiceFormat: 'THERMAL',
      thermalFormat: 'THERMAL_58',
      autoPrintAfterFinalize: false,
    });
  });

  test('ADMIN updates them (audited); any cashier reads the options', async () => {
    const updated = await updatePrintSettings({
      defaultInvoiceFormat: 'A4',
      thermalPaperWidthMm: 80,
      defaultA4PrinterName: '  HP_LaserJet ',
      defaultThermalPrinterName: '',
      autoPrintAfterFinalize: true,
    });
    expect(updated).toEqual({
      defaultInvoiceFormat: 'A4',
      thermalPaperWidthMm: 80,
      defaultA4PrinterName: 'HP_LaserJet',
      defaultThermalPrinterName: null,
      autoPrintAfterFinalize: true,
    });
    expect(
      value(
        await h.call<PrintOptionsDto>(
          C.printing.getOptions,
          undefined,
          CASHIER_WINDOW,
        ),
      ),
    ).toEqual({
      defaultInvoiceFormat: 'A4',
      thermalFormat: 'THERMAL_80',
      autoPrintAfterFinalize: true,
    });
    expect(
      rows(
        `SELECT action FROM audit_log WHERE action = 'PRINT_SETTINGS_UPDATED'`,
      ),
    ).toHaveLength(1);
    expect(
      failure(
        await h.call(
          C.printing.updateSettings,
          { ...updated, thermalPaperWidthMm: 76 },
          ADMIN_WINDOW,
        ),
      ).code,
    ).toBe('VALIDATION_FAILED');
  });

  test('printers enumerate for ADMIN only', async () => {
    driver.printers = [
      { name: 'POS58', displayName: 'POS-58', isDefault: false },
    ];
    expect(
      value(
        await h.call<PrinterDto[]>(
          C.printing.listPrinters,
          undefined,
          ADMIN_WINDOW,
        ),
      ),
    ).toEqual([{ name: 'POS58', displayName: 'POS-58', isDefault: false }]);
    for (const channel of [C.printing.listPrinters, C.printing.getSettings]) {
      expect(
        failure(await h.call(channel, undefined, CASHIER_WINDOW)).code,
      ).toBe('FORBIDDEN');
    }
    expect(
      failure(
        await h.call(
          C.printing.updateSettings,
          {
            defaultInvoiceFormat: 'A4',
            thermalPaperWidthMm: 58,
            defaultA4PrinterName: null,
            defaultThermalPrinterName: null,
            autoPrintAfterFinalize: false,
          },
          CASHIER_WINDOW,
        ),
      ).code,
    ).toBe('FORBIDDEN');
  });

  test('printing requires a session; any cashier may preview, print and export', async () => {
    const invoice = await criticalInvoice(shop, priceStart());
    for (const [channel, input] of [
      [C.printing.preview, { invoiceId: invoice.id, format: 'A4' }],
      [C.printing.print, { invoiceId: invoice.id, format: 'A4' }],
      [C.printing.exportPdf, { invoiceId: invoice.id }],
      [C.printing.getOptions, undefined],
    ] as const) {
      expect(failure(await h.call(channel, input, NOBODY)).code).toBe(
        'UNAUTHENTICATED',
      );
    }
    expect(
      failure(
        await h.call(
          C.printing.preview,
          { invoiceId: invoice.id, format: 'A5' },
          CASHIER_WINDOW,
        ),
      ).code,
    ).toBe('VALIDATION_FAILED');
    // A draft or unknown id is not printable.
    const draft = value(
      await h.call<DraftView>(
        C.drafts.create,
        {
          requestId: fixtureId(),
          channelId: shop.bengkel,
          invoiceDate: '2026-09-30',
          pricingAt: now(),
        },
        CASHIER_WINDOW,
      ),
    );
    expect(failure(await preview(draft.id, 'A4')).code).toBe(
      'INVOICE_NOT_FOUND',
    );
    expect(failure(await print(draft.id, 'A4')).code).toBe('INVOICE_NOT_FOUND');
    expect(driver.printCalls).toHaveLength(0);
  });
});

// ---- logo ----

describe('shop logo', () => {
  function chooseLogo(w = ADMIN_WINDOW) {
    return h.call<LogoChoiceDto>(C.settings.chooseLogo, undefined, w);
  }

  test('stored content-addressed; new snapshots hold the hash, old ones keep null', async () => {
    const oldInvoice = await criticalInvoice(shop, priceStart());
    const bytes = pngBytes(4096);
    const sha = createHash('sha256').update(bytes).digest('hex');
    dialogs.openAnswers.push(writeScratch('logo.PNG', bytes));

    const chosen = value(await chooseLogo());
    expect(chosen.outcome).toBe('UPDATED');
    expect(chosen.logo?.asset).toBe(`${sha}.png`);
    expect(chosen.logo?.dataUrl).toBe(
      `data:image/png;base64,${bytes.toString('base64')}`,
    );
    const stored = path.join(h.assetsDir, `${sha}.png`);
    expect(readFileSync(stored)).toEqual(bytes);
    expect(rows('SELECT logo_asset FROM settings')[0]!.logo_asset).toBe(
      `${sha}.png`,
    );
    expect(
      rows(`SELECT action FROM audit_log WHERE action = 'SHOP_LOGO_UPDATED'`),
    ).toHaveLength(1);

    const item = await stockItem(shop, 'Busi NGK', '25000', priceStart());
    const newInvoice = await issueInvoice(shop, {
      lines: [{ catalogItemId: item.id }],
    });
    expect(newInvoice.shop.logo).toBe(`${sha}.png`);
    expect(value(await getInvoice(oldInvoice.id)).shop.logo).toBeNull();

    const printedNew = value(await preview(newInvoice.id, 'THERMAL_58')).html;
    expect(printedNew).toContain(
      `src="data:image/png;base64,${bytes.toString('base64')}"`,
    );
    expect(value(await preview(oldInvoice.id, 'A4')).html).not.toContain(
      '<img',
    );

    // A missing asset never fails a print: it renders without the logo.
    unlinkSync(stored);
    const without = value(await preview(newInvoice.id, 'A4')).html;
    expect(without).not.toContain('<img');
    expect(value(await print(newInvoice.id, 'A4')).outcome).toBe('PRINTED');
    const log = readFileSync(path.join(h.logDir, readdirOne(h.logDir)), 'utf8');
    expect(log).toContain('printing.logo_missing');

    // The same bytes again land on the same asset.
    dialogs.openAnswers.push(writeScratch('again.png', bytes));
    expect(value(await chooseLogo()).logo?.asset).toBe(`${sha}.png`);
    expect(existsSync(stored)).toBe(true);
  });

  test('JPEG accepted; wrong type, too large and cancel are refused or no-ops', async () => {
    const jpeg = Buffer.alloc(1000, 1);
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(jpeg);
    dialogs.openAnswers.push(writeScratch('logo.jpeg', jpeg));
    const sha = createHash('sha256').update(jpeg).digest('hex');
    expect(value(await chooseLogo()).logo?.asset).toBe(`${sha}.jpg`);

    const gif = Buffer.from('GIF89a........');
    dialogs.openAnswers.push(writeScratch('logo.png', gif));
    expect(failure(await chooseLogo()).code).toBe('LOGO_INVALID_TYPE');

    dialogs.openAnswers.push(writeScratch('big.png', pngBytes(512 * 1024 + 1)));
    expect(failure(await chooseLogo()).code).toBe('LOGO_TOO_LARGE');
    dialogs.openAnswers.push(writeScratch('max.png', pngBytes(512 * 1024)));
    expect(value(await chooseLogo()).outcome).toBe('UPDATED');

    dialogs.openAnswers.push(null);
    const before = rows('SELECT logo_asset FROM settings')[0]!.logo_asset;
    expect(value(await chooseLogo())).toEqual({
      outcome: 'CANCELLED',
      logo: null,
    });
    expect(rows('SELECT logo_asset FROM settings')[0]!.logo_asset).toBe(before);

    value(await h.call(C.settings.removeLogo, undefined, ADMIN_WINDOW));
    expect(rows('SELECT logo_asset FROM settings')[0]!.logo_asset).toBeNull();
    expect(
      value(await h.call(C.settings.getLogo, undefined, ADMIN_WINDOW)),
    ).toBeNull();
  });

  test('only ADMIN manages the logo; the renderer never supplies a path', async () => {
    for (const channel of [
      C.settings.chooseLogo,
      C.settings.removeLogo,
      C.settings.getLogo,
    ]) {
      expect(
        failure(await h.call(channel, undefined, CASHIER_WINDOW)).code,
      ).toBe('FORBIDDEN');
    }
    expect(dialogs.openCalls).toBe(0);
    expect(
      failure(
        await h.call(
          C.settings.chooseLogo,
          { path: '/etc/passwd' },
          ADMIN_WINDOW,
        ),
      ).code,
    ).toBe('VALIDATION_FAILED');
  });
});

function readdirOne(dir: string): string {
  const files = readdirSync(dir);
  if (files.length !== 1) throw new Error(`expected one log file: ${files}`);
  return files[0]!;
}

// ---- migration 009 ----

describe('migration 009 on a populated version-8 database', () => {
  const v8 = bundledMigrations.filter((m) => m.version <= 8);

  // This full migration workflow can exceed five seconds on Windows CI.
  test('adds print settings and print_jobs, reusing the T4 printer columns', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bengkelin-v8-'));
    const file = path.join(dir, 'db.sqlite');
    const clock = { now };
    try {
      let db = openDatabase(file);
      migrateDatabase(db, v8);
      expect(readSchemaVersion(db)).toBe(8);
      db.exec(bundledMigrations.find((m) => m.version === 15)!.sql);
      db.exec(bundledMigrations.find((m) => m.version === 16)!.sql);
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
      value(
        await call(
          C.settings.completeSetup,
          validSetup({
            printer: {
              thermalPrinterName: 'POS80',
              a4PrinterName: 'HP_LaserJet',
              thermalPaperWidthMm: 80,
            },
          }),
        ),
      );
      const admin = value(
        await call<{ cashierId: string }>(C.auth.login, {
          username: 'admin',
          password: ADMIN_PASSWORD,
        }),
      ).cashierId;
      const channel = value(
        await call<ReferenceDto[]>(C.references.list, { entity: 'channel' }),
      ).find((c) => c.code === 'BENGKEL')!;
      let draft = value(
        await call<DraftView>(C.drafts.create, {
          requestId: fixtureId(),
          channelId: channel.id,
          invoiceDate: '2026-09-30',
          pricingAt: now(),
        }),
      );
      draft = value(
        await call<DraftView>(C.drafts.apply, {
          requestId: fixtureId(),
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
      // Issued as version 8 did (its snapshot has logo: null).
      db.prepare(
        `UPDATE invoices SET channel_label_snapshot = 'Bengkel', cashier_name_snapshot = 'Pak Budi',
           shop_identity_snapshot = ?, status = 'FINALIZED',
           invoice_number = 'INV-20260930-0001', cashier_id = ?, finalized_at = ?,
           version = version + 1
         WHERE id = ?`,
      ).run(
        JSON.stringify({
          name: 'Bengkel Maju Jaya',
          address: 'Jl. Merdeka',
          phoneNumber: null,
          email: null,
          invoiceFooter: null,
          logo: null,
        }),
        admin,
        now(),
        draft.id,
      );
      const tables = (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          )
          .all() as { name: string }[]
      ).map((t) => t.name);
      const dump = () =>
        Object.fromEntries(
          tables.map((name) => [
            name,
            db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
          ]),
        );
      const before = dump();
      const triggersBefore = db
        .prepare(
          `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
        )
        .all();
      db.close();

      // ---- upgrade ----
      db = openDatabase(file);
      migrateDatabase(
        db,
        bundledMigrations.filter((m) => m.version <= 9),
      );
      expect(readSchemaVersion(db)).toBe(9);
      const after = dump();
      for (const name of tables) {
        if (name === 'settings') continue;
        expect(after[name], name).toEqual(before[name]);
      }
      const settingsAfter = (after.settings as Record<string, unknown>[])[0]!;
      const settingsBefore = (before.settings as Record<string, unknown>[])[0]!;
      for (const [key, v] of Object.entries(settingsBefore)) {
        expect(settingsAfter[key], key).toEqual(v);
      }
      expect(settingsAfter).toMatchObject({
        default_invoice_format: 'THERMAL',
        auto_print_after_finalize: 0n,
        logo_asset: null,
        thermal_paper_width_mm: 80n,
        default_thermal_printer_name: 'POS80',
        default_a4_printer_name: 'HP_LaserJet',
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM print_jobs').get()).toEqual({
        n: 0n,
      });
      // No earlier trigger changed.
      const triggersAfter = db
        .prepare(
          `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
        )
        .all() as { name: string; sql: string }[];
      for (const trigger of triggersBefore as { name: string; sql: string }[]) {
        expect(triggersAfter).toContainEqual(trigger);
      }
      // Constraints on the new columns.
      expect(() =>
        db.prepare(`UPDATE settings SET default_invoice_format = 'A5'`).run(),
      ).toThrow();
      expect(() =>
        db.prepare(`UPDATE settings SET auto_print_after_finalize = 2`).run(),
      ).toThrow();
      expect(() =>
        db
          .prepare(`UPDATE settings SET logo_asset = '../../etc/passwd.png'`)
          .run(),
      ).toThrow();
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');

      // The upgraded database prints the old invoice (no logo) and reads
      // the reused T4 printer settings.
      const upgraded = createApplicationServices({
        db,
        clock,
        logDir: path.join(dir, 'logs'),
        assetsDir: path.join(dir, 'assets'),
        printDriver: driver,
        openPath: async () => '',
      });
      const upgradedCommands = new Map(
        buildCommands(upgraded).map((c) => [c.channel, c]),
      );
      const call9 = async <T>(channel: string, input?: unknown) =>
        (await executeCommand(
          upgradedCommands.get(channel)!,
          { windowId: 1 },
          input,
          upgraded.logger,
        )) as Result<T>;
      value(
        await call9(C.auth.login, {
          username: 'admin',
          password: ADMIN_PASSWORD,
        }),
      );
      expect(
        value(await call9<PrintSettingsDto>(C.printing.getSettings)),
      ).toEqual({
        defaultInvoiceFormat: 'THERMAL',
        thermalPaperWidthMm: 80,
        defaultA4PrinterName: 'HP_LaserJet',
        defaultThermalPrinterName: 'POS80',
        autoPrintAfterFinalize: false,
      });
      const shown = value(
        await call9<PrintPreviewDto>(C.printing.preview, {
          invoiceId: draft.id,
          format: 'THERMAL_80',
        }),
      );
      expect(shown.html).toContain('INV-20260930-0001');
      expect(shown.html).not.toContain('<img');
      driver.printers = [
        { name: 'POS80', displayName: 'POS 80', isDefault: false },
      ];
      expect(
        value(
          await call9<PrintOutcomeDto>(C.printing.print, {
            invoiceId: draft.id,
            format: 'THERMAL_80',
          }),
        ).outcome,
      ).toBe('PRINTED');
      expect(driver.printCalls.at(-1)!.options).toEqual({
        format: 'THERMAL_80',
        deviceName: 'POS80',
        silent: true,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

test('A4 uses current contacts on old invoices while thermal and stored business state stay unchanged', async () => {
  const invoice = await criticalInvoice(shop, priceStart());
  const before = businessState();
  const thermal = value(await preview(invoice.id, 'THERMAL_58')).html;
  const thermal80 = value(await preview(invoice.id, 'THERMAL_80')).html;
  const update = async (
    complaintPhoneNumber: string | null,
    socialMediaUrl: string | null,
  ) => {
    const current = value(
      await h.call<import('@/shared/contracts').ShopSettingsDto>(
        C.settings.getShop,
        undefined,
        ADMIN_WINDOW,
      ),
    );
    value(
      await h.call(
        C.settings.updateShop,
        { ...current, complaintPhoneNumber, socialMediaUrl },
        ADMIN_WINDOW,
      ),
    );
  };
  await update('0878-1640-9387', 'https://s.id/mitramotorbersama?s=qr');
  const first = value(await preview(invoice.id, 'A4')).html;
  expect(first).toContain('0878-1640-9387');
  expect(first).toContain('data:image/gif;base64,');
  expect(value(await preview(invoice.id, 'THERMAL_58')).html).toBe(thermal);
  expect(value(await preview(invoice.id, 'THERMAL_80')).html).toBe(thermal80);
  await print(invoice.id, 'A4');
  expect(driver.printCalls.at(-1)!.html).toBe(first);
  const pdfPreview = value(await preview(invoice.id, 'A4')).html;
  dialogs.saveAnswers.push(path.join(scratch, 'contacts.pdf'));
  value(
    await h.call(
      C.printing.exportPdf,
      { invoiceId: invoice.id },
      CASHIER_WINDOW,
    ),
  );
  expect(driver.pdfCalls.at(-1)!.html).toBe(pdfPreview);
  await update(null, 'https://example.com/baru?q=1&x=2');
  const changed = value(await preview(invoice.id, 'A4')).html;
  expect(changed).not.toContain('0878-1640-9387');
  expect(changed).toContain('data:image/gif;base64,');
  expect(changed.match(/data:image\/gif;base64,[^"]+/)?.[0]).not.toBe(
    first.match(/data:image\/gif;base64,[^"]+/)?.[0],
  );
  await update('<123&>', null);
  const phoneOnly = value(await preview(invoice.id, 'A4')).html;
  expect(phoneOnly).toContain('&lt;123&amp;&gt;');
  expect(phoneOnly).not.toContain('class="social-qr"');
  await update(null, null);
  expect(value(await preview(invoice.id, 'A4')).html).not.toContain(
    'class="invoice-contacts"',
  );
  expect(businessState()).toBe(before);
});

test('all layouts use escaped frozen reference names after rename and deactivation', async () => {
  const invoice = await acceptanceInvoice(shop, priceStart());
  expect(invoice.sales).not.toBeNull();
  for (const entity of ['sales', 'expedition'] as const) {
    const selected = invoice[entity]!;
    value(
      await h.call(
        C.references.save,
        { entity, id: selected.id, label: 'Renamed later' },
        ADMIN_WINDOW,
      ),
    );
    value(
      await h.call(
        C.references.deactivate,
        { entity, id: selected.id },
        ADMIN_WINDOW,
      ),
    );
  }
  for (const format of FORMATS) {
    const { model, html } = h.services.printing.renderInvoice(
      invoice.id,
      format,
    );
    expect(model.salesName).toBe(invoice.sales!.name);
    expect(model.expeditionName).toBe(invoice.expedition!.name);
    expect(html).toContain(escapeHtml(invoice.sales!.name));
    expect(html).toContain(escapeHtml(invoice.expedition!.name));
    expect(html).not.toContain('Renamed later');
    expect(html).not.toContain('<Andi>');
  }
});
