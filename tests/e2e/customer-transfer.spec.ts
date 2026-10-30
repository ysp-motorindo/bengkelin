import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './helpers/launch';
import { tr } from './helpers/i18n';
const t = (key: string) => tr('id', key);
let launched: LaunchedApp | undefined;
test.afterEach(async () => {
  await launched?.close();
});
test('admin imports customers and selects an inactive customer in a transaction', async () => {
  launched = await launchApp({
    env: {
      BENGKELIN_TEST_OPEN_CSV_PATH: path.resolve(
        'tests/fixtures/csv/customer-e2e-import.csv',
      ),
    },
  });
  const { page } = launched;
  await page.evaluate(async () => {
    const b = window.bengkelin;
    const setup = await b.settings.completeSetup({
      shop: { name: 'Smoke', address: 'Jl. A', timezone: 'Asia/Jakarta' },
      admin: {
        username: 'admin',
        displayName: 'Admin',
        password: 'correct-horse-battery',
      },
      preferences: { language: 'id', appearance: 'LIGHT' },
    });
    if (!setup.ok) throw new Error(JSON.stringify(setup.error));
    const login = await b.auth.login({
      username: 'admin',
      password: 'correct-horse-battery',
    });
    if (!login.ok) throw new Error(JSON.stringify(login.error));
  });
  await page.reload();
  const nav = page.getByRole('navigation');
  await nav
    .getByRole('button', { name: t('shell.nav.customers'), exact: true })
    .click();
  await page
    .getByRole('button', { name: t('customers.import.open'), exact: true })
    .click();
  await page
    .getByRole('button', { name: t('customers.import.choose'), exact: true })
    .click();
  const preview = page.getByTestId('customer-import-preview');
  await expect(preview).toBeVisible();
  const commit = page
    .getByRole('dialog', { name: t('customers.import.title') })
    .getByRole('button', {
      name: t('catalogTransfer.preview.commit'),
      exact: true,
    });
  await expect(commit).toBeDisabled();
  await preview
    .getByRole('checkbox', { name: t('customers.import.acknowledge') })
    .check();
  await commit.click();
  await expect(page.getByTestId('customer-import-result')).toContainText(
    'bengkelin-safety-',
  );
  expect(
    fs
      .readdirSync(path.join(launched.dataDir, 'backups'))
      .some((f) => f.endsWith('.sqlite')),
  ).toBe(true);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: t('customers.edit.cancel'), exact: true })
    .last()
    .click();
  await nav
    .getByRole('button', { name: t('shell.nav.workspace'), exact: true })
    .click();
  await page
    .getByRole('button', {
      name: t('workspace.header.chooseCustomer'),
      exact: true,
    })
    .click();
  const party = page.getByRole('dialog', {
    name: t('workspace.header.chooseCustomer'),
    exact: true,
  });
  await expect(
    party.getByText('Active Fixture - 0812-001', { exact: true }),
  ).toBeVisible();
  await expect(party.getByText(/Dormant Fixture/)).toHaveCount(0);
  await party
    .getByRole('checkbox', { name: t('workspace.party.showInactive') })
    .check();
  await expect(party.getByText(/Dormant Fixture.*Nonaktif/)).toBeVisible();
  await party
    .getByRole('button', {
      name: 'Pilih: Dormant Fixture - 0812-001',
      exact: true,
    })
    .click();
  await expect(page.getByTestId('header-customer')).toHaveValue(
    /Dormant Fixture/,
  );
  await party
    .getByRole('button', { name: t('workspace.common.close'), exact: true })
    .click();
  await page
    .getByRole('button', {
      name: t('workspace.header.chooseCustomer'),
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('checkbox', { name: t('workspace.party.showInactive') }),
  ).not.toBeChecked();
});
