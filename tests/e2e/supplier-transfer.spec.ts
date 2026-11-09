import { test, expect } from '@playwright/test';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { launchApp } from './helpers/launch';
import { navigateTo } from './helpers/navigation';
import { tr } from './helpers/i18n';
for (const locale of ['id', 'en'] as const)
  test(`supplier import, opening payment and restart (${locale})`, async () => {
    test.setTimeout(120000);
    const dataDir = await mkdtemp(path.join(tmpdir(), 'supplier-e2e-'));
    const output = path.resolve('artifacts/supplier-import', locale);
    await mkdir(output, { recursive: true });
    const env = {
      BENGKELIN_TEST_OPEN_CSV_PATH: path.resolve(
        'references/supplier-import.csv',
      ),
    };
    let launched = await launchApp({ dataDir, env });
    const t = (key: string) => tr(locale, key);
    try {
      let page = launched.page;
      await page.setViewportSize({ width: 1800, height: 1040 });
      await page.evaluate(async (locale) => {
        const b = window.bengkelin;
        const must = (r: any) => {
          if (!r.ok) throw Error(JSON.stringify(r.error));
          return r.value;
        };
        must(
          await b.settings.completeSetup({
            shop: {
              name: 'Supplier test',
              address: 'Test',
              timezone: 'Asia/Jakarta',
            },
            admin: {
              username: 'admin',
              displayName: 'Admin',
              password: 'correct-horse-battery',
            },
            preferences: { language: locale, appearance: 'LIGHT' },
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
            label: 'Warehouse',
            isDefault: true,
          }),
        );
      }, locale);
      await page.reload();
      await navigateTo(page, 'purchases');
      await page
        .getByRole('button', { name: t('purchases.suppliers'), exact: true })
        .click();
      await page
        .getByRole('button', {
          name: t('purchases.supplierImport.open'),
          exact: true,
        })
        .click();
      await page
        .getByRole('button', {
          name: t('purchases.supplierImport.choose'),
          exact: true,
        })
        .click();
      const preview = page.getByTestId('supplier-import-preview');
      await expect(preview).toBeVisible();
      await expect(preview).toContainText('2026-10-31');
      await expect(preview).toContainText('1.284.002.694');
      await page.screenshot({ path: path.join(output, 'preview.png') });
      await page
        .getByRole('button', {
          name: t('catalogTransfer.preview.commit'),
          exact: true,
        })
        .click();
      await expect(page.getByTestId('supplier-import-result')).toContainText(
        'bengkelin-safety-',
      );
      await page
        .getByRole('dialog')
        .getByRole('button', { name: t('purchases.cancel'), exact: true })
        .last()
        .click();
      await page
        .getByRole('button', { name: t('purchases.payables'), exact: true })
        .click();
      await page
        .getByLabel(t('purchases.opening.source'), { exact: true })
        .selectOption('OPENING');
      await page
        .getByRole('button', { name: 'PT. YSP MOTORINDO PARTS', exact: true })
        .click();
      await page
        .getByRole('button', {
          name: t('history.detail.recordPayment'),
          exact: true,
        })
        .click();
      const dialog = page.getByRole('dialog');
      await dialog
        .getByRole('textbox', {
          name: t('history.payment.amount'),
          exact: true,
        })
        .fill('100000');
      await dialog
        .getByRole('button', { name: t('purchases.reviewAction'), exact: true })
        .click();
      await dialog
        .getByRole('button', { name: t('purchases.confirm'), exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      await expect(page.getByRole('main')).toContainText(
        '1283902694'.replace(/\B(?=(\d{3})+(?!\d))/g, '.'),
      );
      await page.screenshot({ path: path.join(output, 'paid.png') });
      await launched.close();
      launched = await launchApp({ dataDir, env });
      page = launched.page;
      await page.evaluate(async () => {
        const r = await window.bengkelin.auth.login({
          username: 'admin',
          password: 'correct-horse-battery',
        });
        if (!r.ok) throw Error(r.error.code);
      });
      const result = await page.evaluate(async () => {
        const p = await window.bengkelin.supplierTransfer.previewImport();
        if (!p.ok || p.value.outcome !== 'READY') throw Error('preview');
        const c = await window.bengkelin.supplierTransfer.commitImport({
          token: p.value.token,
        });
        const list = await window.bengkelin.supplierPayables.list({});
        if (!c.ok || !list.ok) throw Error('reimport');
        return { summary: c.value, page: list.value };
      });
      expect(result.summary.openings.unchanged).toBe(3);
      expect(result.page.totalOutstanding).toBe('1283902694');
    } finally {
      await launched.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
