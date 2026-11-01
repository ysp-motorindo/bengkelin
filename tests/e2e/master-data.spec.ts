import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { tr } from './helpers/i18n';
import { launchApp, type LaunchedApp } from './helpers/launch';
import { tabTo } from './helpers/workflow-seed';

const ADMIN_PASSWORD = 'correct-horse-battery';
const CASHIER_PASSWORD = 'siti-password-1';
const exact = { exact: true } as const;
const t = (key: string) => tr('id', key);

let launched: LaunchedApp | undefined;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-master-'));
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

/** Seeds through the real bridge, then leaves the window signed in as `as`. */
async function seed(page: Page, as: 'admin' | 'siti') {
  await page.evaluate(
    async ({ adminPassword, cashierPassword, as }) => {
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

      const brand = await b.references.save({
        entity: 'vehicleBrand',
        name: 'Honda',
      });
      if (brand.ok) {
        await b.references.save({
          entity: 'vehicleModel',
          brandId: brand.value.id,
          name: 'Vario 160',
        });
      }
      await b.cashiers.create({
        username: 'siti',
        displayName: 'Siti',
        password: cashierPassword,
        role: 'CASHIER',
      });
      if (as === 'siti') {
        await b.auth.logout();
        await b.auth.login({ username: 'siti', password: cashierPassword });
      }
    },
    {
      adminPassword: ADMIN_PASSWORD,
      cashierPassword: CASHIER_PASSWORD,
      as,
    },
  );
  await page.reload();
  await expect(page.getByTestId('session-name')).toBeVisible();
}

async function openCustomers(page: Page) {
  await page
    .getByRole('navigation')
    .getByRole('button', { name: t('shell.nav.customers'), ...exact })
    .click();
  await expect(
    page.getByRole('heading', { name: t('customers.title') }),
  ).toBeVisible();
}

async function quickCustomer(page: Page, name: string, phone: string) {
  await page.getByLabel(t('customers.quickCustomer.name'), exact).fill(name);
  await page.getByLabel(t('customers.quickCustomer.phone'), exact).fill(phone);
  await page
    .getByRole('button', { name: t('customers.quickCustomer.submit') })
    .click();
}

test('cashier: quick creation, keyboard use, plate lookup, mismatch, transfer and cancel', async () => {
  launched = await launchApp({ dataDir });
  const { page } = launched;
  await seed(page, 'siti');
  await openCustomers(page);

  // Quick customer creation (name + phone only) selects the new customer.
  await quickCustomer(page, 'Budi', '081234567890');
  const selected = page.getByTestId('selected-customer');
  await expect(selected).toContainText('Budi');

  // Quick vehicle creation with brand/model pickers; Budi becomes first owner.
  await page
    .getByLabel(t('customers.quickVehicle.plate'), exact)
    .fill('B 1234 XYZ');
  await page
    .getByLabel(t('customers.quickVehicle.brand'), exact)
    .selectOption({ label: 'Honda' });
  await page
    .getByLabel(t('customers.quickVehicle.model'), exact)
    .selectOption({ label: 'Vario 160' });
  await page
    .getByRole('button', { name: t('customers.quickVehicle.submit') })
    .click();
  await expect(page.getByTestId('vehicle-plate')).toHaveText('B 1234 XYZ');
  await expect(page.getByTestId('active-owner')).toContainText('Budi');
  await expect(page.getByTestId('ownership-row')).toHaveCount(1);
  await expect(page.getByTestId('owner-mismatch')).toHaveCount(0);

  // Keyboard-only: type name, Tab to phone, type, Enter submits the form.
  await page.getByLabel(t('customers.quickCustomer.name'), exact).focus();
  await page.keyboard.type('Siti Aminah');
  await tabTo(page, page.getByLabel(t('customers.quickCustomer.phone'), exact));
  await page.keyboard.type('0857 1111 2222');
  await page.keyboard.press('Enter');
  await expect(selected).toContainText('Siti Aminah');

  // Global plate lookup with a variant spelling, submitted with Enter.
  await page.getByLabel(t('customers.search.label'), exact).focus();
  await page.keyboard.type('b-1234-xyz');
  await page.keyboard.press('Enter');
  const vehicleRow = page.getByTestId('vehicle-result');
  await expect(vehicleRow).toHaveCount(1);
  await expect(vehicleRow).toContainText('B 1234 XYZ');
  await vehicleRow
    .getByRole('button', { name: t('customers.vehicle.select') })
    .click();

  // Owner (Budi) differs from the selected customer (Siti): warning only.
  await expect(page.getByTestId('owner-mismatch')).toBeVisible();
  await expect(page.getByTestId('active-owner')).toContainText('Budi');

  // Transfer, then cancel: ownership is unchanged.
  const transferLabel = t('customers.transfer.action').replace(
    '{{name}}',
    'Siti Aminah',
  );
  await page.getByRole('button', { name: transferLabel, ...exact }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: t('customers.transfer.cancel') }),
  ).toBeFocused();
  await page.keyboard.press('Enter'); // focused control is Cancel
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('active-owner')).toContainText('Budi');
  const afterCancel = await page.evaluate(async () => {
    const found = await window.bengkelin.vehicles.searchByPlate({
      query: 'B1234XYZ',
    });
    if (!found.ok) return null;
    const vehicle = found.value.results[0]!;
    const detail = await window.bengkelin.vehicles.get({ id: vehicle.id });
    return detail.ok ? detail.value.ownerships.length : null;
  });
  expect(afterCancel).toBe(1);

  // Transfer and confirm.
  await page.getByRole('button', { name: transferLabel, ...exact }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: t('customers.transfer.confirm') })
    .click();
  await expect(page.getByTestId('active-owner')).toContainText('Siti Aminah');
  await expect(page.getByTestId('owner-mismatch')).toHaveCount(0);
  await expect(page.getByTestId('ownership-row')).toHaveCount(2);

  // Duplicate phone: warning, then explicit acknowledgement.
  await quickCustomer(page, 'Budi Dua', '+62 812-3456-7890');
  await expect(
    page.getByRole('group', { name: t('customers.duplicate.title') }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: t('customers.duplicate.acknowledge') })
    .click();
  await expect(selected).toContainText('Budi Dua');

  // Existing plate is offered for reuse instead of a second vehicle.
  await page
    .getByLabel(t('customers.quickVehicle.plate'), exact)
    .fill('b1234xyz');
  await page
    .getByRole('button', { name: t('customers.quickVehicle.submit') })
    .click();
  await expect(
    page.getByRole('group', { name: t('customers.plateExists.title') }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: t('customers.plateExists.use') })
    .click();
  await expect(page.getByTestId('vehicle-plate')).toHaveText('B 1234 XYZ');
});

test('reference management is ADMIN-only in the UI and in main', async () => {
  launched = await launchApp({ dataDir });
  const { page } = launched;
  await seed(page, 'siti');
  const nav = page.getByRole('navigation');
  await expect(
    nav.getByRole('button', { name: t('shell.nav.references') }),
  ).toHaveCount(0);
  const denied = await page.evaluate(() =>
    window.bengkelin.references.save({ entity: 'vehicleBrand', name: 'Evil' }),
  );
  expect(denied).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });

  await page.getByTestId('session-name').click();
  await page.getByRole('button', { name: t('shell.logout') }).click();
  await page.getByLabel(t('auth.login.username'), exact).fill('admin');
  await page.getByLabel(t('auth.login.password'), exact).fill(ADMIN_PASSWORD);
  await page
    .getByRole('button', { name: t('auth.login.submit'), ...exact })
    .click();
  await nav.getByRole('button', { name: t('shell.nav.references') }).click();

  // Mechanics tab: add, then deactivate.
  await page
    .getByRole('button', { name: t('references.actions.add'), ...exact })
    .click();
  await page.getByLabel(t('references.fields.name'), exact).fill('Joko');
  await page
    .getByRole('button', { name: t('references.actions.save'), ...exact })
    .click();
  const row = page.getByRole('row', { name: /Joko/ });
  await expect(row).toContainText(t('references.status.active'));
  await row
    .getByRole('button', {
      name: `${t('references.actions.deactivate')}: Joko`,
    })
    .click();
  await expect(row).toContainText(t('references.status.inactive'));

  // Keyboard tab navigation to the channels tab; the code is read-only there.
  await page
    .getByRole('tab', { name: t('references.entities.mechanic') })
    .focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: t('references.entities.channel') }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('row', { name: /ONLINE/ })).toBeVisible();
  await page
    .getByRole('button', { name: `${t('references.actions.edit')}: Online` })
    .click();
  await expect(
    page.getByLabel(t('references.fields.code'), exact),
  ).toBeDisabled();
});
