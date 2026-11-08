import { navigateTo } from './helpers/navigation';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { tr } from './helpers/i18n';
import { launchApp, type LaunchedApp } from './helpers/launch';

const ADMIN_PASSWORD = 'correct-horse-battery';
const exact = { exact: true } as const;
const t = (key: string) => tr('id', key);

let launched: LaunchedApp | undefined;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-inventory-'));
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

test('ADMIN sets an opening balance, sets stock 30 -> 25 and sees delta -5, then sees the negative flag', async () => {
  launched = await launchApp({ dataDir });
  const { page } = launched;
  await page.evaluate(async (adminPassword) => {
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

    const units = await b.references.list({ entity: 'unit' });
    if (!units.ok) throw new Error('units');
    const pcs = units.value.find((u) => u.code === 'PCS');
    if (!pcs) throw new Error('PCS');
    const item = await b.catalog.save({
      type: 'STOCK_ITEM',
      title: 'Oli MPX2 0.8L',
      unitId: pcs.id,
    });
    if (!item.ok) throw new Error('item');
  }, ADMIN_PASSWORD);
  await page.reload();
  await expect(page.getByTestId('session-name')).toBeVisible();

  await navigateTo(page, 'inventory');
  await expect(
    page.getByRole('heading', { name: t('inventory.title'), ...exact }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: `${t('inventory.list.open')}: Oli MPX2 0.8L` })
    .click();
  const detail = page.getByTestId('stock-detail');
  await expect(detail).toBeVisible();

  // Opening balance 30.
  await detail
    .getByRole('button', { name: t('inventory.actions.openBalance'), ...exact })
    .click();
  const opening = page.getByRole('form', {
    name: t('inventory.actions.openBalance'),
  });
  await opening.getByLabel(t('inventory.form.quantity'), exact).fill('30');
  await opening
    .getByRole('button', { name: t('inventory.form.submit'), ...exact })
    .click();
  await expect(page.getByTestId('stock-current')).toContainText(
    'Stok saat ini: 30',
  );

  // Set stock to 25: the delta is shown before confirming.
  await detail
    .getByRole('button', { name: t('inventory.actions.setStock'), ...exact })
    .click();
  const setForm = page.getByRole('form', {
    name: t('inventory.actions.setStock'),
  });
  await setForm.getByLabel(t('inventory.form.target'), exact).fill('25');
  await expect(page.getByTestId('set-stock-preview')).toContainText(
    'Perubahan: -5 (30 menjadi 25)',
  );
  await setForm
    .getByLabel(t('inventory.form.reason'), exact)
    .fill('Stok opname');
  await setForm
    .getByRole('button', { name: t('inventory.form.confirm'), ...exact })
    .click();
  await expect(page.getByTestId('stock-notice')).toContainText(
    'Perubahan: -5. Stok sekarang 25.',
  );
  await expect(page.getByTestId('stock-current')).toContainText(
    'Stok saat ini: 25',
  );
  await expect(page.getByTestId('negative-flag')).toHaveCount(0);
  await expect(page.getByTestId('ledger-row').first()).toContainText(
    t('inventory.movement.ADJUSTMENT'),
  );

  // Adjust below zero: the item is flagged negative and filterable.
  await detail
    .getByRole('button', { name: t('inventory.actions.adjust'), ...exact })
    .click();
  const adjustForm = page.getByRole('form', {
    name: t('inventory.actions.adjust'),
  });
  await adjustForm.getByLabel(t('inventory.form.delta'), exact).fill('-30');
  await adjustForm.getByLabel(t('inventory.form.reason'), exact).fill('Rusak');
  await adjustForm
    .getByRole('button', { name: t('inventory.form.submit'), ...exact })
    .click();
  await expect(page.getByTestId('stock-current')).toContainText(
    'Stok saat ini: -5',
  );
  const row = page.getByTestId('stock-row').first();
  await expect(row).toHaveAttribute('data-negative', 'true');
  await expect(row.getByTestId('negative-flag')).toBeVisible();
  await expect(page.getByTestId('negative-banner')).toBeVisible();

  await page.keyboard.press('Escape');
  await page.getByLabel(t('inventory.filter.negativeOnly'), exact).check();
  await expect(page.getByTestId('stock-row')).toHaveCount(1);
});
