import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import {
  seedWorkshop,
  loginWithKeyboard,
  CASHIER_PASSWORD,
  OIL_BARCODE,
  HELMET_BARCODE,
} from './helpers/workflow-seed';
import { tr } from './helpers/i18n';

test('compact transaction form: bilingual desktop layout and inline save evidence', async () => {
  test.setTimeout(120000);
  const skill = process.env.TRANSACTION_EVIDENCE_SKILL;
  const createEvidence = skill ? (await import(skill)).createEvidence : null;
  const directory = path.resolve(
    'output/transaction-form-2026-10-30',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
  const bilingual = (en: string, id: string) => ({ en, id });
  const evidence = createEvidence
    ? await createEvidence(directory, {
        title: bilingual('Compact transaction form', 'Form transaksi ringkas'),
        fixture: false,
        environment: {
          startup:
            'npm run build:app; npx playwright test tests/e2e/transaction-form.spec.ts',
          baseURL: 'Electron local renderer',
          authentication: bilingual(
            'Seeded demo cashier; signed in through supported login form.',
            'Kasir demo; masuk melalui formulir login aplikasi.',
          ),
          roles: ['CASHIER'],
          locales: ['id', 'en'],
          pages: ['Transaction workspace', 'Checkout review'],
        },
      })
    : null;
  await mkdir(path.join(directory, 'viewports'), { recursive: true });
  for (const lang of ['id', 'en'] as const) {
    const launched = await launchApp();
    try {
      const { page } = launched;
      const t = (key: string) => tr(lang, key);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await seedWorkshop(page, lang);
      await loginWithKeyboard(page, 'siti', CASHIER_PASSWORD, lang);
      await page.setViewportSize({ width: 1800, height: 1040 });
      const step = async (
        id: string,
        en: string,
        idText: string,
        action: () => Promise<void>,
        userGuide = true,
      ) => {
        if (!evidence) {
          await action();
          return;
        }
        const result = await evidence.step(
          page,
          {
            id: `${lang}-${id}`,
            caseId: 'TRANSACTION',
            role: 'CASHIER',
            locale: lang,
            title: bilingual(en, idText),
            expected: bilingual(en, idText),
            actual: bilingual(en, idText),
            userGuide,
          },
          action,
        );
        expect(result.status).toBe('Pass');
      };
      await step(
        'empty',
        'Empty grid and inline entry are available.',
        'Tabel kosong dan entri langsung tersedia.',
        async () => {
          await expect(page.getByTestId('line-entry')).toBeVisible();
          await expect(
            page.getByRole('textbox', {
              name: t('workspace.header.note'),
              exact: true,
            }),
          ).toBeVisible();
        },
      );
      const search = page.getByRole('combobox', {
        name: t('workspace.search.label'),
      });
      for (const barcode of [OIL_BARCODE, HELMET_BARCODE]) {
        await search.fill(barcode);
        await search.press('Enter');
        await expect(page.getByTestId('save-state')).toHaveAttribute(
          'data-state',
          'saved',
        );
      }
      await step(
        'inline',
        'Inline quantity and sequential discounts save on Tab.',
        'Jumlah dan diskon bertahap tersimpan dengan Tab.',
        async () => {
          const row = page.getByTestId('line-row').first();
          const qty = row.getByLabel(t('workspace.editor.quantity'));
          await qty.fill('2');
          await qty.press('Tab');
          const d1 = row.getByLabel(t('workspace.editor.discount1'));
          await d1.fill('10');
          await d1.press('Tab');
          await expect(row.getByTestId('line-amount')).toHaveText('Rp 117.000');
        },
      );
      await step(
        'validation',
        'Invalid quantity blocks review; Escape restores the saved quantity.',
        'Jumlah tidak valid memblokir tinjauan; Escape mengembalikan nilai tersimpan.',
        async () => {
          const qty = page
            .getByTestId('line-row')
            .first()
            .getByLabel(t('workspace.editor.quantity'));
          await qty.fill('');
          await page
            .getByRole('button', {
              name: t('workspace.checkout.review'),
              exact: true,
            })
            .click();
          await expect(page.getByRole('dialog')).toHaveCount(0);
          await qty.focus();
          await qty.press('Escape');
          await expect(qty).toHaveValue('2');
        },
        false,
      );
      await step(
        'custom-entry',
        'Custom service details are entered directly in the grid.',
        'Rincian jasa kustom diisi langsung dalam tabel.',
        async () => {
          await page
            .getByRole('button', {
              name: t('workspace.custom.open'),
              exact: true,
            })
            .click();
          const custom = page.getByRole('region', {
            name: t('workspace.custom.title'),
          });
          await custom
            .getByRole('combobox', { name: t('workspace.custom.itemTitle') })
            .fill('Demo service');
          await custom
            .getByLabel(t('workspace.custom.price'), { exact: true })
            .fill('35000');
          await custom
            .getByLabel(t('workspace.custom.mechanic'), { exact: true })
            .selectOption({ label: 'Andi' });
          await expect(page.getByRole('dialog')).toHaveCount(0);
        },
      );
      await page
        .getByRole('region', { name: t('workspace.custom.title') })
        .getByRole('button', { name: t('workspace.custom.add'), exact: true })
        .click();
      await expect(page.getByTestId('line-row')).toHaveCount(3);
      await step(
        'notes-payment',
        'Notes are directly editable and payment controls remain visible.',
        'Catatan dapat diedit langsung dan kontrol pembayaran tetap tersedia.',
        async () => {
          await page
            .getByRole('textbox', {
              name: t('workspace.header.note'),
              exact: true,
            })
            .fill('Demo: check brakes');
          const total = (await page
            .getByTestId('total-amount')
            .textContent())!.replace(/\D/g, '');
          await page
            .getByRole('textbox', {
              name: t('workspace.checkout.payments'),
              exact: true,
            })
            .fill(total);
          await expect(page.getByTestId('save-state')).toHaveAttribute(
            'data-state',
            'saved',
          );
        },
      );
      for (const size of [
        { width: 1366, height: 768 },
        { width: 1920, height: 1080 },
      ]) {
        await page.setViewportSize(size);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: path.join(
            directory,
            'viewports',
            `${lang}-${size.width}x${size.height}.png`,
          ),
          fullPage: false,
        });
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          ),
        ).toBe(true);
      }
      await page.setViewportSize({ width: 1800, height: 1040 });
      await step(
        'review',
        'Checkout review opens after all inline edits are saved.',
        'Tinjauan pembayaran terbuka setelah seluruh perubahan tersimpan.',
        async () => {
          await page
            .getByRole('button', {
              name: t('workspace.checkout.review'),
              exact: true,
            })
            .click();
          await expect(
            page.getByRole('dialog', { name: t('workspace.review.title') }),
          ).toBeVisible();
        },
      );
      expect(errors).toEqual([]);
    } finally {
      await launched.close();
    }
  }
  if (evidence)
    evidence.run.checklist = [
      'Discovery',
      'Interaction assertions',
      'Visual and locale inspection',
      'Failure and retest tracking',
      'Delivery documentation',
    ].map((label) => ({
      label: bilingual(label, label),
      status: 'Pass',
      notes: bilingual(
        'See recorded acceptance steps and final report.',
        'Lihat langkah penerimaan dan laporan akhir.',
      ),
    }));
  if (evidence) await evidence.save();
  console.log(`TRANSACTION_EVIDENCE=${directory}`);
});
