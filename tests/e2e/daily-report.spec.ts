import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { tr } from './helpers/i18n';
import { launchApp, type LaunchedApp } from './helpers/launch';

/**
 * Task 13: the Daily Report screen for today (shop timezone) with sales,
 * a checkout payment and a later payment; CSV export through the native
 * save dialog, answered by the unpackaged-only test hook
 * BENGKELIN_TEST_SAVE_CSV_PATH (never by the renderer).
 */

const ADMIN_PASSWORD = 'correct-horse-battery';
const CASHIER_PASSWORD = 'siti-password-1';
const exact = { exact: true } as const;
const t = (key: string, params: Record<string, string> = {}) =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{{${name}}}`, value),
    tr('id', key),
  );

let launched: LaunchedApp | undefined;
let dataDir: string;
let outDir: string;

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-report-'));
  outDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-csv-'));
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(dataDir, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
});

/**
 * Setup, a cashier and today's activity (seeding only): invoice A 500.000
 * with a 200.000 cash checkout payment, invoice B 300.000 on credit, then a
 * later 100.000 QRIS payment on B. Returns today's date in the shop zone.
 */
async function seed(page: Page): Promise<string> {
  const today = await page.evaluate(
    async ({ adminPassword, cashierPassword }) => {
      const b = window.bengkelin;
      const must = <T>(
        result: { ok: true; value: T } | { ok: false; error: unknown },
        what: string,
      ): T => {
        if (!result.ok)
          throw new Error(`${what}: ${JSON.stringify(result.error)}`);
        return result.value;
      };
      const day = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Jakarta',
      }).format(new Date());
      must(
        await b.settings.completeSetup({
          shop: {
            name: 'Bengkel Maju',
            address: 'Jl. A',
            timezone: 'Asia/Jakarta',
          },
          admin: {
            username: 'admin',
            displayName: 'Pak Budi',
            password: adminPassword,
          },
          preferences: { language: 'id', appearance: 'LIGHT' },
        }),
        'setup',
      );
      must(
        await b.auth.login({ username: 'admin', password: adminPassword }),
        'login',
      );
      must(
        await b.cashiers.create({
          username: 'siti',
          displayName: 'Siti',
          password: cashierPassword,
          role: 'CASHIER',
        }),
        'cashier',
      );
      const channels = must(
        await b.references.list({ entity: 'channel' }),
        'channels',
      );
      const bengkel = channels.find((c) => c.code === 'BENGKEL')!.id;
      async function issue(price: string, pay: string | null) {
        let draft = must(
          await b.drafts.create({
            requestId: crypto.randomUUID(),
            channelId: bengkel,
            invoiceDate: day,
            pricingAt: new Date().toISOString(),
          }),
          'draft',
        );
        const apply = async (op: unknown) => {
          draft = must(
            await b.drafts.apply({
              requestId: crypto.randomUUID(),
              invoiceId: draft.id,
              expectedVersion: draft.version,
              op: op as never,
            }),
            'apply',
          );
        };
        await apply({
          kind: 'addCustomLine',
          type: 'NON_STOCK_ITEM',
          title: `Barang ${price}`,
          unitPrice: price,
        });
        if (pay) {
          await apply({
            kind: 'setCashPayment',
            amount: pay,
          });
        }
        await apply({ kind: 'updateHeader', changes: { topDays: 30 } });
        const preview = must(
          await b.invoices.previewFinalize({ invoiceId: draft.id }),
          'preview',
        );
        return must(
          await b.invoices.finalize({
            requestId: crypto.randomUUID(),
            invoiceId: draft.id,
            expectedVersion: preview.draftVersion,
            acknowledgedWarnings: preview.warnings,
          }),
          'finalize',
        );
      }
      await issue('500000', '200000');
      const credit = await issue('300000', null);
      must(
        await b.invoices.recordPayment({
          requestId: crypto.randomUUID(),
          invoiceId: credit.id,
          method: 'QRIS',
          amount: '100000',
        }),
        'payment',
      );
      must(await b.auth.logout(), 'logout');
      return day;
    },
    { adminPassword: ADMIN_PASSWORD, cashierPassword: CASHIER_PASSWORD },
  );
  await page.reload();
  return today;
}

test('daily report shows today and exports the same figures as CSV', async () => {
  const target = path.join(outDir, 'laporan.csv');
  launched = await launchApp({
    dataDir,
    env: { BENGKELIN_TEST_SAVE_CSV_PATH: target },
  });
  const { page } = launched;
  const today = await seed(page);

  await page.getByLabel(t('auth.login.username'), exact).fill('siti');
  await page.getByLabel(t('auth.login.password'), exact).fill(CASHIER_PASSWORD);
  await page
    .getByRole('button', { name: t('auth.login.submit'), ...exact })
    .click();
  await page
    .getByRole('button', { name: t('shell.nav.reports'), ...exact })
    .click();

  await expect(
    page.getByRole('heading', { name: t('reports.title') }),
  ).toBeVisible();
  await expect(page.getByLabel(t('reports.filters.date'), exact)).toHaveValue(
    today,
  );
  await expect(page.getByTestId('report-heading')).toContainText(
    'Asia/Jakarta',
  );
  const field = (name: string) => page.locator(`[data-field="${name}"]`);
  await expect(field('sales.invoiceCount')).toHaveText('2');
  await expect(field('sales.grossSubtotal')).toHaveText('Rp 800.000');
  await expect(field('sales.netBeforeVoids')).toHaveText('Rp 800.000');
  await expect(field('netAfterVoids')).toHaveText('Rp 800.000');
  await expect(field('voids.deduction')).toHaveText('Rp 0');
  await expect(field('payments.received')).toHaveText('Rp 300.000');
  await expect(field('payments.sameDayInvoices')).toHaveText('Rp 300.000');
  await expect(field('payments.olderInvoices')).toHaveText('Rp 0');
  await expect(field('payments.byMethod.CASH.amount')).toHaveText('Rp 200.000');
  await expect(field('payments.byMethod.QRIS.amount')).toHaveText('Rp 100.000');

  await page
    .getByRole('button', { name: t('reports.actions.exportCsv'), ...exact })
    .click();
  await expect(page.getByTestId('report-notice')).toHaveText(
    t('reports.outcome.csvSaved', { fileName: 'laporan.csv' }),
  );

  const text = readFileSync(target, 'utf8');
  expect(text.startsWith('﻿')).toBe(true);
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  const lines = text.slice(1).split('\r\n');
  expect(lines[0]).toBe('Laporan Harian');
  expect(lines).toContain(`Tanggal,${today}`);
  expect(lines).toContain('Zona waktu,Asia/Jakarta');
  expect(lines).toContain('Filter kasir,Semua');
  expect(lines).toContain('Jumlah faktur,2');
  expect(lines).toContain('Subtotal kotor,800000');
  expect(lines).toContain('Penjualan bersih sebelum void,800000');
  expect(lines).toContain('Penjualan bersih setelah void,800000');
  expect(lines).toContain('Tunai,1,200000');
  expect(lines).toContain('QRIS,1,100000');
  expect(lines).toContain('Total uang diterima,300000');
  expect(lines).toContain('Untuk faktur hari ini,300000');
  expect(lines).toContain('Untuk faktur sebelumnya,0');
  // Seeding finalized as the admin.
  expect(lines).toContain('Pak Budi,2,800000');

  // Preview shows the same document the printer gets.
  await page
    .getByRole('button', { name: t('reports.actions.preview'), ...exact })
    .click();
  const dialog = page.getByRole('dialog', { name: t('reports.preview.title') });
  const document = dialog.getByTestId('print-preview-document');
  await expect(
    document.locator('[data-money="sales.netBeforeVoids"]'),
  ).toHaveText('Rp 800.000');
  await expect(document.locator('[data-money="payments.received"]')).toHaveText(
    'Rp 300.000',
  );
});
