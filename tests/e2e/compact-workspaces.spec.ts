import { expect, test } from '@playwright/test';
import path from 'node:path';
import { launchApp } from './helpers/launch';
import {
  seedWorkshop,
  loginWithKeyboard,
  ADMIN_PASSWORD,
  CASHIER_PASSWORD,
  OIL_BARCODE,
} from './helpers/workflow-seed';
import { navigateTo } from './helpers/navigation';
import { tr } from './helpers/i18n';

test('compact purchase workspace supports payment recovery and responsive layouts', async () => {
  test.setTimeout(120000);
  const helper = process.env.COMPACT_EVIDENCE_HELPER;
  const bilingual = (en: string, id: string) => ({ en, id });
  const evidence = helper
    ? await (
        await import(helper)
      ).createEvidence(path.resolve(process.env.COMPACT_EVIDENCE_DIR!), {
        title: bilingual(
          'Compact transaction workspaces',
          'Ruang transaksi ringkas',
        ),
        fixture: false,
        environment: {
          startup:
            'npm run build:app; npx playwright test tests/e2e/compact-workspaces.spec.ts',
          baseURL: 'Electron local renderer',
          authentication: bilingual(
            'Supported login form with isolated seeded test accounts.',
            'Formulir masuk resmi dengan akun uji terisolasi.',
          ),
          roles: ['ADMIN', 'CASHIER'],
          locales: ['en', 'id'],
          pages: [
            'New Sale',
            'New Purchase',
            'Purchase payments',
            'Purchase review',
          ],
        },
      })
    : null;
  for (const lang of ['en', 'id'] as const) {
    const launched = await launchApp();
    try {
      const { page, app } = launched;
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await seedWorkshop(page, lang);
      const role = lang === 'en' ? 'ADMIN' : 'CASHIER';
      await loginWithKeyboard(
        page,
        lang === 'en' ? 'admin' : 'siti',
        lang === 'en' ? ADMIN_PASSWORD : CASHIER_PASSWORD,
        lang,
      );
      await page.evaluate(async (language) => {
        const b = window.bengkelin;
        const preference = await b.settings.updatePreferences({
          language,
          appearance: language === 'en' ? 'LIGHT' : 'DARK',
          numberFormat: 'ID',
        });
        if (!preference.ok) throw Error(preference.error.code);
        const supplier = await b.suppliers.save({
          requestId: crypto.randomUUID(),
          name: 'Test supplier',
        });
        if (!supplier.ok) throw Error(supplier.error.code);
      }, lang);
      await page.reload();
      await page.setViewportSize({ width: 1800, height: 1040 });
      const t = (key: string) => tr(lang, key);
      const step = async (
        id: string,
        en: string,
        idText: string,
        action: () => Promise<void>,
      ) => {
        if (!evidence) {
          await action();
          return;
        }
        const result = await evidence.step(
          page,
          {
            id: `${lang}-${id}`,
            caseId: 'COMPACT',
            role,
            locale: lang,
            title: bilingual(en, idText),
            expected: bilingual(en, idText),
            actual: bilingual(en, idText),
            userGuide: true,
          },
          action,
        );
        expect(result.status).toBe('Pass');
      };
      await step(
        'sale',
        'Sale toolbar and compact fields remain available.',
        'Bilah tindakan penjualan dan kolom ringkas tersedia.',
        async () => {
          await expect(
            page.locator('header').getByRole('button', {
              name: t('workspace.drafts.new'),
              exact: true,
            }),
          ).toBeVisible();
        },
      );
      await navigateTo(page, 'purchases', lang);
      await page
        .getByRole('main')
        .getByRole('button', { name: t('purchases.new'), exact: true })
        .click();
      await page
        .locator('header')
        .getByRole('button', { name: t('purchases.new'), exact: true })
        .click();
      await page
        .getByLabel(t('purchases.supplier'), { exact: true })
        .selectOption({ label: 'Test supplier' });
      const search = page.getByRole('combobox', {
        name: t('workspace.search.label'),
        exact: true,
      });
      await search.fill(OIL_BARCODE);
      await search.press('Enter');
      await page
        .getByRole('textbox', {
          name: t('purchases.priceLabel').replace('{{title}}', 'Oli MPX2 0.8L'),
          exact: true,
        })
        .fill('10000');
      await page
        .getByRole('textbox', { name: t('purchases.note'), exact: true })
        .fill('First line\nSecond line');
      await expect(page.getByTestId('save-state')).toHaveAttribute(
        'data-state',
        'saved',
      );
      await step(
        'purchase',
        'Purchase toolbar, item table, notes and summary share the sale layout.',
        'Bilah tindakan, tabel barang, catatan, dan ringkasan pembelian mengikuti tata letak penjualan.',
        async () => {
          await expect(
            page
              .locator('header')
              .getByRole('button', { name: t('purchases.new'), exact: true }),
          ).toBeVisible();
          await expect(
            page.locator('header').getByRole('button', {
              name: t('workspace.drafts.new'),
              exact: true,
            }),
          ).toHaveCount(0);
          await expect(
            page.getByRole('button', {
              name: t('purchases.review'),
              exact: true,
            }),
          ).toBeInViewport();
        },
      );
      const payments = page.getByRole('button', {
        name: t('purchases.outgoingPayments'),
        exact: true,
      });
      await payments.click();
      let dialog = page.getByRole('dialog', {
        name: t('purchases.outgoingPayments'),
        exact: true,
      });
      await dialog
        .getByRole('button', { name: t('purchases.addPayment'), exact: true })
        .click();
      await dialog
        .getByRole('button', { name: t('purchases.close'), exact: true })
        .last()
        .click();
      await step(
        'invalid-payment',
        'An empty payment keeps the dialog open with recovery guidance.',
        'Pembayaran kosong mempertahankan dialog dengan petunjuk perbaikan.',
        async () => {
          await expect(dialog).toBeVisible();
          await expect(dialog.getByRole('alert')).toBeVisible();
        },
      );
      await dialog
        .getByLabel(t('purchases.amount'), { exact: true })
        .fill('10000');
      await dialog
        .getByRole('button', { name: t('purchases.close'), exact: true })
        .last()
        .click();
      await step(
        'payment-saved',
        'Corrected payment is saved and focus returns to its summary row.',
        'Pembayaran yang diperbaiki tersimpan dan fokus kembali ke baris ringkasan.',
        async () => {
          await expect(dialog).toHaveCount(0);
          await expect(payments).toContainText('10.000');
          await expect(payments).toBeFocused();
        },
      );
      await page
        .getByRole('button', { name: t('purchases.review'), exact: true })
        .click();
      dialog = page.getByRole('dialog', {
        name: t('purchases.review'),
        exact: true,
      });
      await step(
        'review',
        'Purchase review is available before recording the supplier bill.',
        'Tinjauan pembelian tersedia sebelum mencatat faktur pemasok.',
        async () => {
          await expect(dialog).toBeVisible();
          await expect(
            dialog.getByRole('button', {
              name: t('purchases.finalize'),
              exact: true,
            }),
          ).toBeEnabled();
        },
      );
      await dialog
        .getByRole('button', { name: t('purchases.cancel'), exact: true })
        .click();
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 1120, height: 600 },
        { width: 390, height: 560 },
      ]) {
        await page.setViewportSize(viewport);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
        const review = page.getByRole('button', {
          name: t('purchases.review'),
          exact: true,
        });
        await review.scrollIntoViewIfNeeded();
        await expect(review).toBeInViewport();
        await search.scrollIntoViewIfNeeded();
        await expect(search).toBeInViewport();
      }
      await page.setViewportSize({ width: 1800, height: 1040 });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.5),
      );
      await page
        .getByRole('button', { name: t('purchases.review'), exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        page.getByRole('button', { name: t('purchases.review'), exact: true }),
      ).toBeInViewport();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
      );
      await page
        .getByRole('button', { name: t('purchases.review'), exact: true })
        .click();
      await page
        .getByRole('dialog', { name: t('purchases.review'), exact: true })
        .getByRole('button', { name: t('purchases.finalize'), exact: true })
        .click();
      await page
        .getByRole('navigation')
        .getByRole('button', { name: t('purchases.editor'), exact: true })
        .click();
      const remainingDraft = page
        .locator('header')
        .getByLabel(t('purchases.drafts'), { exact: true });
      await expect(remainingDraft).toBeVisible();
      await expect(remainingDraft.getByRole('option')).toHaveCount(1);
      await expect(
        page.getByRole('textbox', { name: t('purchases.note'), exact: true }),
      ).toHaveValue('');
      expect(errors).toEqual([]);
    } finally {
      await launched.close();
    }
  }
  if (evidence) await evidence.save();
});
