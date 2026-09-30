import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { tr } from './helpers/i18n';
import { launchApp, type LaunchedApp } from './helpers/launch';

/**
 * Task 10: scan an item, split the payment, review, finalize, see the
 * official number, then start a new transaction.
 */

const ADMIN_PASSWORD = 'correct-horse-battery';
const CASHIER_PASSWORD = 'siti-password-1';
const BARCODE = '8991234567890';
const exact = { exact: true } as const;
const t = (key: string) => tr('id', key);

let launched: LaunchedApp | undefined;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-finalize-'));
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

async function seed(page: Page): Promise<void> {
  await page.evaluate(
    async ({ adminPassword, cashierPassword, barcode }) => {
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
      const units = must(await b.references.list({ entity: 'unit' }), 'units');
      const channels = must(
        await b.references.list({ entity: 'channel' }),
        'channels',
      );
      const item = must(
        await b.catalog.save({
          type: 'STOCK_ITEM',
          title: 'Oli MPX2 0.8L',
          unitId: units.find((u) => u.code === 'PCS')!.id,
        }),
        'item',
      );
      must(
        await b.catalog.saveBarcodes({
          catalogItemId: item.id,
          barcodes: [{ barcode, isActive: true }],
        }),
        'barcode',
      );
      const preview = must(
        await b.catalog.previewPriceChange({
          catalogItemId: item.id,
          channelId: channels.find((c) => c.code === 'BENGKEL')!.id,
          effectiveStartAt: '2024-01-01T00:00:00.000Z',
          price: '65000',
        }),
        'price preview',
      );
      must(await b.catalog.applyPriceChange({ token: preview.token }), 'price');
      must(
        await b.inventory.openBalance({
          requestId: crypto.randomUUID(),
          catalogItemId: item.id,
          quantity: 10,
        }),
        'stock',
      );
      must(await b.auth.logout(), 'logout');
    },
    {
      adminPassword: ADMIN_PASSWORD,
      cashierPassword: CASHIER_PASSWORD,
      barcode: BARCODE,
    },
  );
  await page.reload();
}

test('scan, split payment, review, finalize, see the number, new transaction', async () => {
  launched = await launchApp({ dataDir });
  const { page } = launched;
  await seed(page);
  await page.getByLabel(t('auth.login.username'), exact).fill('siti');
  await page.getByLabel(t('auth.login.password'), exact).fill(CASHIER_PASSWORD);
  await page
    .getByRole('button', { name: t('auth.login.submit'), ...exact })
    .click();
  const search = page.getByRole('combobox', {
    name: t('workspace.search.label'),
  });
  await expect(search).toBeFocused();

  // Scan (keyboard wedge: digits + Enter into the focused search).
  await page.keyboard.type(BARCODE);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('line-row')).toHaveCount(1);
  await expect(page.getByTestId('total-amount')).toHaveText('Rp 65.000');

  // Split: 40.000 cash + 25.000 QRIS.
  const addPayment = page.getByRole('button', {
    name: t('workspace.checkout.addPayment'),
    ...exact,
  });
  await addPayment.click();
  await page
    .getByLabel(`${t('workspace.checkout.amount')} 1`, exact)
    .fill('40000');
  await expect(page.getByTestId('unallocated-amount')).toHaveText('Rp 25.000');
  await addPayment.click();
  await page
    .getByLabel(`${t('workspace.checkout.method')} 2`, exact)
    .selectOption('QRIS');
  await expect(
    page.getByLabel(`${t('workspace.checkout.amount')} 2`, exact),
  ).toHaveValue('25000');
  await expect(page.getByTestId('unallocated-amount')).toHaveText('Rp 0');

  // Review (flushes first), then finalize.
  await page
    .getByRole('button', { name: t('workspace.checkout.review'), ...exact })
    .click();
  const review = page.getByRole('dialog', {
    name: t('workspace.review.title'),
  });
  await expect(review.getByTestId('review-total')).toHaveText('Rp 65.000');
  await expect(review.getByTestId('review-payments')).toContainText(
    'Rp 40.000',
  );
  await expect(review.getByTestId('review-payments')).toContainText(
    'Rp 25.000',
  );
  await expect(review.getByTestId('review-payment-status')).toHaveText(
    t('workspace.paymentStatus.PAID'),
  );
  await review
    .getByRole('button', { name: t('workspace.review.finalize'), ...exact })
    .click();

  const done = page.getByRole('dialog', {
    name: t('workspace.finalize.doneTitle'),
  });
  await expect(done).toBeVisible();
  await expect(done.getByTestId('finalized-invoice-number')).toHaveText(
    /^INV-\d{8}-0001$/,
  );
  await expect(done.getByTestId('finalized-payment-status')).toHaveText(
    t('workspace.paymentStatus.PAID'),
  );
  for (const key of ['printThermal', 'printA4']) {
    await expect(
      done.getByRole('button', { name: t(`workspace.finalize.${key}`) }),
    ).toBeDisabled();
  }
  const newTransaction = done.getByRole('button', {
    name: t('workspace.finalize.newTransaction'),
  });
  await expect(newTransaction).toBeFocused();
  await newTransaction.click();

  await expect(done).toHaveCount(0);
  await expect(page.getByTestId('line-row')).toHaveCount(0);
  await expect(page.getByTestId('total-amount')).toHaveText('Rp 0');
  await expect(search).toBeFocused();

  // Stock moved once; the draft list no longer has the finalized one.
  const state = await page.evaluate(async () => {
    const drafts = await window.bengkelin.drafts.list();
    const stock = await window.bengkelin.inventory.listStock({});
    return { drafts, stock };
  });
  if (!state.drafts.ok || !state.stock.ok) throw new Error('state');
  expect(state.drafts.value.every((d) => d.lineCount === 0)).toBe(true);
  expect(state.stock.value.items[0]?.quantity).toBe(9);
});
