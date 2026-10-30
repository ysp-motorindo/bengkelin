import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { tr } from './helpers/i18n';
import { launchApp, type LaunchedApp } from './helpers/launch';

/**
 * Task 12 with the REAL print driver: preview shows the invoice in a shadow
 * root under the unchanged CSP, and A4 PDF export writes a multi-page PDF.
 * The native save dialog is answered by the test-only env hook
 * (BENGKELIN_TEST_SAVE_PDF_PATH, unpackaged builds only), never by the
 * renderer. Physical printers are not exercised here (R10).
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
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-print-'));
  outDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-pdf-'));
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(dataDir, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
});

/** Setup, a cashier, and one finalized 40-line invoice (seeding only). */
async function seed(page: Page): Promise<string> {
  const number = await page.evaluate(
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
      let draft = must(
        await b.drafts.create({
          requestId: crypto.randomUUID(),
          channelId: channels.find((c) => c.code === 'BENGKEL')!.id,
          invoiceDate: '2026-09-30',
          pricingAt: new Date().toISOString(),
        }),
        'draft',
      );
      for (let i = 1; i <= 40; i += 1) {
        draft = must(
          await b.drafts.apply({
            requestId: crypto.randomUUID(),
            invoiceId: draft.id,
            expectedVersion: draft.version,
            op: {
              kind: 'addCustomLine',
              type: 'NON_STOCK_ITEM',
              title: `Suku cadang nomor ${i} dengan nama yang cukup panjang untuk dibungkus`,
              unitPrice: String(10000 + i * 500),
            },
          }),
          `line ${i}`,
        );
      }
      draft = must(
        await b.drafts.apply({
          requestId: crypto.randomUUID(),
          invoiceId: draft.id,
          expectedVersion: draft.version,
          op: { kind: 'setCashPayment', amount: draft.totals.amount },
        }),
        'cash payment',
      );
      const preview = must(
        await b.invoices.previewFinalize({ invoiceId: draft.id }),
        'preview',
      );
      const invoice = must(
        await b.invoices.finalize({
          requestId: crypto.randomUUID(),
          invoiceId: draft.id,
          expectedVersion: preview.draftVersion,
          acknowledgedWarnings: preview.warnings,
        }),
        'finalize',
      );
      const shop = must(await b.settings.getShop(), 'shop');
      must(
        await b.settings.updateShop({
          ...shop,
          complaintPhoneNumber: '0878-1640-9387',
          socialMediaUrl: 'https://example.com/日本?q=keluhan&x=1',
        }),
        'contacts',
      );
      must(await b.auth.logout(), 'logout');
      return invoice.invoiceNumber;
    },
    { adminPassword: ADMIN_PASSWORD, cashierPassword: CASHIER_PASSWORD },
  );
  await page.reload();
  return number;
}

test('preview shows the invoice; A4 PDF export writes a multi-page PDF', async () => {
  const target = path.join(outDir, 'faktur.pdf');
  launched = await launchApp({
    dataDir,
    env: { BENGKELIN_TEST_SAVE_PDF_PATH: target },
  });
  const { page } = launched;
  const cspViolations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) {
      cspViolations.push(message.text());
    }
  });
  const number = await seed(page);

  await page.getByLabel(t('auth.login.username'), exact).fill('siti');
  await page.getByLabel(t('auth.login.password'), exact).fill(CASHIER_PASSWORD);
  await page
    .getByRole('button', { name: t('auth.login.submit'), ...exact })
    .click();
  await page
    .getByRole('button', { name: t('shell.nav.history'), ...exact })
    .click();
  await page
    .getByRole('button', { name: t('history.table.openInvoice', { number }) })
    .click();
  const detail = page.getByTestId('invoice-detail');
  const total = (await detail.getByTestId('detail-total').textContent())!;
  expect(total).toMatch(/^Rp \d{1,3}(\.\d{3})+$/);

  // ---- preview: the same template, inside a shadow root ----
  await detail
    .getByRole('button', { name: t('printing.actions.preview'), ...exact })
    .click();
  const dialog = page.getByRole('dialog', {
    name: t('printing.preview.title'),
  });
  await expect(dialog).toBeVisible();
  const document = dialog.getByTestId('print-preview-document');
  // Playwright locators pierce the open shadow root.
  await expect(document.getByText(number).first()).toBeVisible();
  await expect(document.locator('[data-money="amount"]')).toHaveText(total);
  // The template's CSS applies inside the shadow root, through an adopted
  // stylesheet, with the CSP unchanged: 48 mm of content on 58 mm paper.
  const sheetWidths = () =>
    document.evaluate((host) => {
      const sheet = host.shadowRoot!.querySelector('.sheet')!;
      const style = getComputedStyle(sheet);
      return {
        content: parseFloat(style.width),
        paper: sheet.getBoundingClientRect().width,
      };
    });
  const mm = (value: number) => (value / 25.4) * 96;
  const receipt = await sheetWidths();
  expect(Math.abs(receipt.content - mm(48))).toBeLessThan(2);
  expect(Math.abs(receipt.paper - mm(58))).toBeLessThan(2);
  await dialog
    .getByLabel(t('printing.preview.format'), exact)
    .selectOption('A4');
  await expect(document.locator('.layout-a4')).toHaveCount(1);
  await expect(document.getByText('0878-1640-9387')).toBeVisible();
  const qr = document.locator('img.social-qr');
  await expect(qr).toBeVisible();
  await expect
    .poll(() => qr.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  const pixels = await qr.evaluate((element) => {
    const image = element as HTMLImageElement;
    const canvas = window.document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      data: Array.from(
        context.getImageData(0, 0, canvas.width, canvas.height).data,
      ),
    };
  });
  expect(
    jsQR(Uint8ClampedArray.from(pixels.data), pixels.width, pixels.height)
      ?.data,
  ).toBe('https://example.com/日本?q=keluhan&x=1');
  const a4 = await sheetWidths();
  expect(Math.abs(a4.content - mm(186))).toBeLessThan(2);
  expect(Math.abs(a4.paper - mm(210))).toBeLessThan(2);
  await expect(document.locator('.layout-a4 [data-money="amount"]')).toHaveText(
    total,
  );
  await dialog
    .getByRole('button', { name: t('printing.preview.close'), ...exact })
    .last()
    .click();
  await expect(dialog).toHaveCount(0);

  // ---- A4 PDF export through the (stubbed) native save dialog ----
  await detail
    .getByRole('button', { name: t('printing.actions.exportPdf'), ...exact })
    .click();
  await expect(detail.getByTestId('print-notice')).toHaveText(
    t('printing.outcome.pdfSaved', { fileName: 'faktur.pdf' }),
    { timeout: 30_000 },
  );
  expect(existsSync(target)).toBe(true);
  const pdf = readFileSync(target);
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const pages = Number(/\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1]);
  expect(pages).toBeGreaterThanOrEqual(2);

  expect(cspViolations).toEqual([]);
  // The invoice is unchanged by printing.
  await expect(detail.getByTestId('detail-total')).toHaveText(total);
});
