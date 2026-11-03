import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { tr } from './helpers/i18n';
import { launchApp, type LaunchedApp } from './helpers/launch';

const ADMIN_PASSWORD = 'correct-horse-battery';
const CASHIER_PASSWORD = 'siti-password-1';
const exact = { exact: true } as const;
const t = (key: string) => tr('id', key);

let launched: LaunchedApp | undefined;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-catalog-'));
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

test('ADMIN creates an item with a barcode and two price points, sees the timeline; CASHIER looks up the barcode', async () => {
  launched = await launchApp({ dataDir });
  const { page } = launched;
  await page.evaluate(
    async ({ adminPassword, cashierPassword }) => {
      const b = window.bengkelin;
      await b.settings.completeSetup({
        shop: { name: 'Bengkel', address: 'Jl. A', timezone: 'Asia/Jakarta' },
        admin: {
          username: 'admin',
          displayName: 'Pak Budi',
          password: adminPassword,
        },
        preferences: { language: 'id', appearance: 'LIGHT' },
      });
      await b.auth.login({ username: 'admin', password: adminPassword });
      await b.references.save({
        entity: 'stockLocation',
        code: '01',
        label: 'Gudang',
        isDefault: true,
      });

      await b.cashiers.create({
        username: 'siti',
        displayName: 'Siti',
        password: cashierPassword,
        role: 'CASHIER',
      });
    },
    { adminPassword: ADMIN_PASSWORD, cashierPassword: CASHIER_PASSWORD },
  );
  await page.reload();
  await expect(page.getByTestId('session-name')).toBeVisible();

  const nav = page.getByRole('navigation');
  await nav
    .getByRole('button', { name: t('shell.nav.catalog'), ...exact })
    .click();
  await expect(
    page.getByRole('heading', { name: t('catalog.title') }),
  ).toBeVisible();

  // Create the item.
  await page.getByRole('button', { name: t('catalog.new'), ...exact }).click();
  await page.getByLabel(t('catalog.form.title'), exact).fill('Oli MPX2 0.8L');
  await page.getByLabel(t('catalog.form.sku'), exact).fill('OLI-MPX2');
  await page
    .getByRole('button', { name: t('catalog.form.save'), ...exact })
    .click();
  await expect(page.getByTestId('item-detail')).toContainText('Oli MPX2 0.8L');

  // Barcode with a leading zero.
  await page.getByLabel(t('catalog.barcodes.new'), exact).fill('0012345678905');
  await page
    .getByRole('button', { name: t('catalog.barcodes.add'), ...exact })
    .click();
  await expect(page.getByTestId('barcode-row')).toContainText('0012345678905');

  // Two price points: a past start, then a future start.
  const bengkel = page.getByTestId('channel-BENGKEL');
  async function addPoint(start: string, price: string) {
    await bengkel
      .getByRole('button', { name: t('catalog.pricing.add') })
      .click();
    const dialog = page.getByRole('dialog', {
      name: t('catalog.dialog.addTitle'),
    });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^Berlaku sejak/).fill(start);
    await dialog.getByLabel(t('catalog.dialog.price'), exact).fill(price);
    await dialog
      .getByRole('button', { name: t('catalog.dialog.preview'), ...exact })
      .click();
    return dialog;
  }

  let dialog = await addPoint('2024-01-01T00:00', '65000');
  await expect(dialog.getByTestId('price-preview')).toBeVisible();
  await dialog
    .getByRole('button', { name: t('catalog.dialog.apply'), ...exact })
    .click();
  await expect(dialog).toHaveCount(0);

  dialog = await addPoint('2099-01-01T00:00', '70000');
  await expect(dialog.getByTestId('preview-current-to-new')).toContainText(
    'Rp 65.000',
  );
  await expect(dialog.getByTestId('preview-current-to-new')).toContainText(
    'Rp 70.000',
  );
  await expect(dialog.getByTestId('preview-successor')).toContainText(
    t('catalog.dialog.noSuccessor'),
  );
  await dialog
    .getByRole('button', { name: t('catalog.dialog.apply'), ...exact })
    .click();
  await expect(dialog).toHaveCount(0);

  const rows = bengkel.getByTestId('price-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-state', 'CURRENT');
  await expect(rows.nth(0)).toContainText('Rp 65.000');
  await expect(rows.nth(0)).toContainText('01/01/2024 00:00');
  await expect(rows.nth(1)).toHaveAttribute('data-state', 'SCHEDULED');
  await expect(rows.nth(1)).toContainText('Rp 70.000');
  await expect(rows.nth(1)).toContainText('01/01/2099 00:00');

  // Correct the current revision: the old one stays as greyed history.
  await rows
    .nth(0)
    .getByRole('button', { name: /^Koreksi revisi mulai/ })
    .click();
  const correction = page.getByRole('dialog', {
    name: t('catalog.dialog.correctTitle'),
  });
  await correction.getByLabel(t('catalog.dialog.price'), exact).fill('66000');
  await correction
    .getByLabel(t('catalog.dialog.reason'), exact)
    .fill('Salah ketik');
  await correction
    .getByRole('button', { name: t('catalog.dialog.preview'), ...exact })
    .click();
  await correction
    .getByRole('button', { name: t('catalog.dialog.apply'), ...exact })
    .click();
  await expect(correction).toHaveCount(0);
  await expect(bengkel.locator('[data-state="SUPERSEDED"]')).toContainText(
    'Salah ketik',
  );
  await expect(bengkel.locator('[data-state="CURRENT"]')).toContainText(
    'Rp 66.000',
  );

  // Sign out and sign in as the cashier.
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('dialog', { name: t('catalog.detail.title') }),
  ).toHaveCount(0);
  await page.getByTestId('session-name').click();
  await page.getByRole('button', { name: t('shell.logout') }).click();
  await page.getByLabel(t('auth.login.username'), exact).fill('siti');
  await page.getByLabel(t('auth.login.password'), exact).fill(CASHIER_PASSWORD);
  await page
    .getByRole('button', { name: t('auth.login.submit'), ...exact })
    .click();
  await nav
    .getByRole('button', { name: t('shell.nav.catalog'), ...exact })
    .click();

  // Cashiers cannot edit; the lookup works by keyboard.
  await expect(
    page.getByRole('button', { name: t('catalog.new'), ...exact }),
  ).toHaveCount(0);
  await page.getByLabel(t('catalog.lookup.label'), exact).focus();
  await page.keyboard.type('0012345678905');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('lookup-found')).toContainText('Oli MPX2 0.8L');
  await expect(page.getByTestId('item-detail')).toContainText('Oli MPX2 0.8L');
  await expect(page.getByTestId('price-row').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: t('catalog.pricing.add') }),
  ).toHaveCount(0);

  // Unknown barcodes show a typed message and create nothing.
  await page.getByLabel(t('catalog.lookup.label'), exact).fill('999');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Barcode tidak dikenal');
  const denied = await page.evaluate(() =>
    window.bengkelin.catalog.save({
      type: 'SERVICE',
      title: 'Evil',
      unitId: crypto.randomUUID(),
    }),
  );
  expect(denied).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
});
