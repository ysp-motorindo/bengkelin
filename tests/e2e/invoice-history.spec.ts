import { navigateTo } from './helpers/navigation';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { tr } from './helpers/i18n';
import { launchApp, type LaunchedApp } from './helpers/launch';

/**
 * Task 11: finalize a credit sale, record a later payment from History and
 * see PAID; finalize another unpaid sale, void it with a reason and see the
 * VOID marking.
 */

const ADMIN_PASSWORD = 'correct-horse-battery';
const CASHIER_PASSWORD = 'siti-password-1';
const BARCODE = '8991234567890';
const exact = { exact: true } as const;
const t = (key: string, params: Record<string, string> = {}) =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{{${name}}}`, value),
    tr('id', key),
  );

let launched: LaunchedApp | undefined;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-history-'));
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
      await b.references.save({
        entity: 'stockLocation',
        code: '01',
        label: 'Gudang',
        isDefault: true,
      });

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
          stockLocationId: await b.references
            .listActive({ entity: 'stockLocation' })
            .then((r) => {
              if (!r.ok || !r.value[0]) throw new Error('location');
              return r.value[0].id;
            }),
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

/** Scan one item and finalize with no payment (a credit sale). */
async function creditSale(page: Page): Promise<string> {
  const search = page.getByRole('combobox', {
    name: t('workspace.search.label'),
  });
  await expect(search).toBeFocused();
  await page.keyboard.type(BARCODE);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('line-row')).toHaveCount(1);
  await page.getByLabel(t('workspace.header.topDays'), exact).fill('7');
  await page
    .getByRole('button', { name: t('workspace.checkout.review'), ...exact })
    .click();
  const review = page.getByRole('dialog', {
    name: t('workspace.review.title'),
  });
  await expect(review.getByTestId('review-payment-status')).toHaveText(
    t('workspace.paymentStatus.UNPAID'),
  );
  await review
    .getByRole('button', { name: t('workspace.review.finalize'), ...exact })
    .click();
  const done = page.getByRole('dialog', {
    name: t('workspace.finalize.doneTitle'),
  });
  const number = (await done
    .getByTestId('finalized-invoice-number')
    .textContent())!;
  await done
    .getByRole('button', { name: t('workspace.finalize.newTransaction') })
    .click();
  await expect(done).toHaveCount(0);
  return number;
}

test('later payment from History reaches PAID; an unpaid invoice is voided with a reason', async () => {
  launched = await launchApp({ dataDir });
  const { page } = launched;
  await seed(page);
  await page.getByLabel(t('auth.login.username'), exact).fill('siti');
  await page.getByLabel(t('auth.login.password'), exact).fill(CASHIER_PASSWORD);
  await page
    .getByRole('button', { name: t('auth.login.submit'), ...exact })
    .click();

  const credit = await creditSale(page);
  const toVoid = await creditSale(page);
  expect(credit).toMatch(/^INV-\d{8}-0001$/);
  expect(toVoid).toMatch(/^INV-\d{8}-0002$/);

  // ---- History: search by number, open, record the later payment ----
  await navigateTo(page, 'history');
  await expect(page.getByTestId('history-row')).toHaveCount(2);
  await page.getByLabel(t('history.filters.invoiceNumber'), exact).fill(credit);
  await page
    .getByRole('button', { name: t('history.filters.submit'), ...exact })
    .click();
  await expect(page.getByTestId('history-row')).toHaveCount(1);
  await page
    .getByRole('button', {
      name: t('history.table.openInvoice', { number: credit }),
    })
    .click();

  const detail = page.getByTestId('invoice-detail');
  await expect(detail.getByTestId('payment-status')).toHaveText(
    t('workspace.paymentStatus.UNPAID'),
  );
  await expect(detail.getByTestId('detail-outstanding')).toHaveText(
    'Rp 65.000',
  );
  await detail
    .getByRole('button', { name: t('history.detail.recordPayment'), ...exact })
    .click();
  const payment = page.getByRole('dialog', {
    name: t('history.payment.title', { number: credit }),
  });
  // The amount defaults to the outstanding balance.
  await expect(
    payment.getByLabel(t('history.payment.amount'), exact),
  ).toHaveValue('65.000');
  await payment
    .getByLabel(t('history.payment.method'), exact)
    .selectOption('QRIS');
  await payment
    .getByRole('button', { name: t('history.payment.submit'), ...exact })
    .click();
  await expect(payment).toHaveCount(0);
  await expect(detail.getByTestId('payment-status')).toHaveText(
    t('workspace.paymentStatus.PAID'),
  );
  await expect(detail.getByTestId('detail-outstanding')).toHaveText('Rp 0');
  await expect(detail.getByTestId('payment-row')).toHaveCount(1);
  await expect(detail.getByTestId('payment-row')).toContainText('Siti');
  await expect(detail.getByTestId('payment-row')).toContainText(
    t('history.detail.sources.LATER'),
  );
  // Paid: voiding is disabled and explained.
  await expect(
    detail.getByRole('button', { name: t('history.detail.void'), ...exact }),
  ).toBeDisabled();
  await expect(detail.getByTestId('void-blocked')).toHaveText(
    t('history.detail.voidBlockedPaid'),
  );

  // ---- Void the other, unpaid invoice ----
  await detail
    .getByRole('button', { name: t('history.detail.back'), ...exact })
    .click();
  await page
    .getByRole('button', { name: t('history.filters.reset'), ...exact })
    .click();
  await expect(page.getByTestId('history-row')).toHaveCount(2);
  await page
    .getByRole('button', {
      name: t('history.table.openInvoice', { number: toVoid }),
    })
    .click();
  await detail
    .getByRole('button', { name: t('history.detail.void'), ...exact })
    .click();
  const voidDialog = page.getByRole('alertdialog', {
    name: t('history.void.title', { number: toVoid }),
  });
  const confirm = voidDialog.getByRole('button', {
    name: t('history.void.submit'),
    ...exact,
  });
  await expect(confirm).toBeDisabled();
  await voidDialog
    .getByLabel(t('history.void.reason'), exact)
    .fill('Pelanggan batal servis');
  await expect(confirm).toBeDisabled();
  await voidDialog
    .getByLabel(t('history.void.confirm', { number: toVoid }))
    .check();
  await confirm.click();
  await expect(voidDialog).toHaveCount(0);

  const marking = detail.getByTestId('void-marking');
  await expect(marking).toBeVisible();
  await expect(marking).toContainText(t('history.detail.voidTitle'));
  await expect(marking.getByTestId('void-reason')).toHaveText(
    'Pelanggan batal servis',
  );
  await expect(marking).toContainText('Siti');
  await expect(detail.getByTestId('status-void')).toHaveText(
    t('history.status.VOID'),
  );

  // Back in the list the row is marked VOID; receivables exclude it.
  await detail
    .getByRole('button', { name: t('history.detail.back'), ...exact })
    .click();
  await expect(
    page.locator('[data-testid="history-row"][data-status="VOID"]'),
  ).toHaveCount(1);
  await navigateTo(page, 'receivables');
  await expect(page.getByTestId('history-empty')).toHaveText(
    t('history.receivables.empty'),
  );

  // Stock: two sold, one returned by the void.
  const stock = await page.evaluate(async () =>
    window.bengkelin.inventory.listStock({
      stockLocationId: await window.bengkelin.references
        .listActive({ entity: 'stockLocation' })
        .then((r) => {
          if (!r.ok || !r.value[0]) throw new Error('location');
          return r.value[0].id;
        }),
    }),
  );
  if (!stock.ok) throw new Error('stock');
  expect(stock.value.items[0]?.quantity).toBe(9);
});
