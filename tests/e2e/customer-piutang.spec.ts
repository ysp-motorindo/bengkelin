import { navigateTo } from './helpers/navigation';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './helpers/launch';
import { tr } from './helpers/i18n';
const t = (key: string) => tr('id', key);
let launched: LaunchedApp | undefined;
let dir: string;
test.afterEach(async () => {
  await launched?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
test('import opening debt, show invoice Piutang, repay and reconcile daily receipts', async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'customer-piutang-e2e-'));
  const csv = path.join(dir, 'import.csv');
  writeFileSync(
    csv,
    'external_id,name,phone_number,address,city_or_regency,is_active\nCU-1,Alpha,08120001,,,true\n',
  );
  launched = await launchApp({ env: { BENGKELIN_TEST_OPEN_CSV_PATH: csv } });
  const { page } = launched;
  await page.setViewportSize({ width: 1800, height: 1040 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { day, customerId } = await page.evaluate(async () => {
    const b = window.bengkelin;
    const must = <T>(
      r: { ok: true; value: T } | { ok: false; error: unknown },
    ): T => {
      if (!r.ok) throw Error(JSON.stringify(r.error));
      return r.value;
    };
    must(
      await b.settings.completeSetup({
        shop: {
          name: 'Piutang demo',
          address: 'Jl. Demo',
          timezone: 'Asia/Jakarta',
        },
        admin: {
          username: 'admin',
          displayName: 'Admin',
          password: 'correct-horse-battery',
        },
        preferences: { language: 'id', appearance: 'LIGHT' },
      }),
    );
    must(
      await b.auth.login({
        username: 'admin',
        password: 'correct-horse-battery',
      }),
    );
    must(
      await b.references.save({
        entity: 'stockLocation',
        code: '01',
        label: 'Gudang',
        isDefault: true,
      }),
    );
    const p = must(await b.customerTransfer.previewImport());
    if (p.outcome !== 'READY') throw Error('cancelled');
    must(await b.customerTransfer.commitImport({ token: p.token }));
    const customer = must(await b.customers.search({ query: 'Alpha' }))
      .results[0]!;
    return {
      day: new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Jakarta',
      }).format(new Date()),
      customerId: customer.id,
    };
  });
  writeFileSync(
    csv,
    'external_id,customer_name,as_of_date,opening_balance\nCU-1,Alpha,2026-09-30,100000\n',
  );
  await page.reload();
  const evidence = path.resolve(
    'output/customer-piutang-e2e',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
  mkdirSync(evidence, { recursive: true });
  const capture = async (name: string) => {
    await page.screenshot({ path: path.join(evidence, `${name}.png`) });
  };
  await navigateTo(page, 'customers');
  await page
    .getByRole('button', { name: t('history.opening.importOpen'), exact: true })
    .click();
  await page
    .getByRole('button', { name: t('customers.import.choose'), exact: true })
    .click();
  await expect(page.getByTestId('opening-import-preview')).toContainText(
    'Rp 100.000',
  );
  await capture('01-import-preview');
  await page
    .getByRole('button', {
      name: t('catalogTransfer.preview.commit'),
      exact: true,
    })
    .click();
  await expect(page.getByRole('status')).toContainText('1 saldo awal diimpor');
  await capture('02-import-result');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: t('customers.edit.cancel'), exact: true })
    .last()
    .click();
  await navigateTo(page, 'workspace');
  await page
    .getByRole('combobox', {
      name: t('workspace.header.customer'),
      exact: true,
    })
    .click();
  await page.getByRole('option', { name: /Alpha/ }).click();
  await expect(
    page.getByLabel(t('workspace.header.piutang'), { exact: true }),
  ).toHaveText('Rp 100.000');
  const channelBox = await page
    .getByLabel(t('workspace.header.channel'), { exact: true })
    .boundingBox();
  const debtBox = await page
    .getByLabel(t('workspace.header.piutang'), { exact: true })
    .boundingBox();
  expect(
    Math.abs(
      channelBox!.y + channelBox!.height / 2 - debtBox!.y - debtBox!.height / 2,
    ),
  ).toBeLessThan(2);
  await capture('03-invoice-piutang');
  await navigateTo(page, 'receivables');
  await page
    .getByRole('tab', { name: t('history.opening.title'), exact: true })
    .click();
  await page.getByRole('button', { name: 'Alpha', exact: true }).click();
  await page
    .getByRole('button', {
      name: t('history.detail.recordPayment'),
      exact: true,
    })
    .click();
  await page
    .getByLabel(t('history.payment.amount'), { exact: true })
    .fill('30000');
  await capture('04-payment');
  await page
    .getByRole('button', { name: t('history.payment.submit'), exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Rp 70.000', { exact: true })).toBeVisible();
  await capture('05-payment-history');
  await navigateTo(page, 'workspace');
  await expect(
    page.getByLabel(t('workspace.header.piutang'), { exact: true }),
  ).toHaveText('Rp 70.000');
  await capture('06-refreshed-piutang');
  await navigateTo(page, 'reports');
  await expect(
    page.locator('[data-field="payments.openingBalanceRepayments"]'),
  ).toHaveText('Rp 30.000');
  await expect(page.locator('[data-field="payments.received"]')).toHaveText(
    'Rp 30.000',
  );
  await page
    .locator('[data-field="payments.openingBalanceRepayments"]')
    .scrollIntoViewIfNeeded();
  await capture('07-daily-report');
  const report = await page.evaluate(
    async ({ day }) => window.bengkelin.reports.daily({ date: day }),
    { day },
  );
  expect(report.ok && report.value.sales.netBeforeVoids).toBe('0');
  await page.setViewportSize({ width: 720, height: 1040 });
  await navigateTo(page, 'receivables');
  await page
    .getByRole('tab', { name: t('history.opening.title'), exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Alpha', exact: true }),
  ).toBeVisible();
  await capture('08-narrow-opening-balances');
  await page.setViewportSize({ width: 1800, height: 1040 });
  const detail = await page.evaluate(
    async (customerId) =>
      window.bengkelin.customerReceivables.get({ customerId }),
    customerId,
  );
  expect(detail.ok && detail.value.payments).toHaveLength(1);
  await page.evaluate(async () =>
    window.bengkelin.settings.updatePreferences({
      language: 'en',
      appearance: 'LIGHT',
      numberFormat: 'ID',
    }),
  );
  await page.reload();
  await navigateTo(page, 'receivables');
  await page
    .getByRole('tab', { name: tr('en', 'history.opening.title'), exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Alpha', exact: true }),
  ).toBeVisible();
  await capture('09-english-opening-balances');
  expect(errors).toEqual([]);
});
