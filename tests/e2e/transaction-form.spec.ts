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
      await step(
        'parties',
        'Customers and vehicles can be created and selected from search.',
        'Pelanggan dan kendaraan dapat dibuat dan dipilih dari pencarian.',
        async () => {
          const customer = page.getByRole('combobox', {
            name: t('workspace.header.customer'),
            exact: true,
          });
          await customer.click();
          await page
            .getByRole('option', {
              name: t('workspace.party.createCustomer'),
              exact: true,
            })
            .click();
          let dialog = page.getByRole('dialog');
          await dialog
            .getByLabel(t('customers.quickCustomer.name'), { exact: true })
            .fill('Demo customer');
          await dialog
            .getByRole('button', {
              name: t('customers.quickCustomer.submit'),
              exact: true,
            })
            .click();
          await expect(customer).toHaveValue('Demo customer');
          const vehicle = page.getByRole('combobox', {
            name: t('workspace.header.vehicleNumber'),
            exact: true,
          });
          await vehicle.click();
          await page
            .getByRole('option', {
              name: t('workspace.party.createVehicle'),
              exact: true,
            })
            .click();
          dialog = page.getByRole('dialog');
          await dialog
            .getByLabel(t('customers.quickVehicle.plate'), { exact: true })
            .fill('TST9999');
          await dialog
            .getByRole('button', {
              name: t('customers.quickVehicle.submit'),
              exact: true,
            })
            .click();
          await expect(vehicle).toHaveValue('TST9999');
          await expect(
            page.getByText(`${t('workspace.header.cashier')}: Siti`, {
              exact: true,
            }),
          ).toBeVisible();
        },
      );
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
        'Custom service details are entered in a dialog.',
        'Rincian jasa kustom diisi melalui dialog.',
        async () => {
          await search.click();
          await page
            .getByRole('option', {
              name: t('workspace.custom.open'),
              exact: true,
            })
            .click();
          const custom = page.getByRole('dialog', {
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
          await expect(page.getByRole('dialog')).toHaveCount(1);
        },
      );
      await page
        .getByRole('dialog', { name: t('workspace.custom.title') })
        .getByRole('button', { name: t('workspace.custom.add'), exact: true })
        .click();
      await expect(page.getByTestId('line-row')).toHaveCount(3);
      await step(
        'zero-item',
        'Zero-priced custom items can be reviewed together.',
        'Item kustom dengan harga nol dapat ditinjau bersama.',
        async () => {
          await search.click();
          await page
            .getByRole('option', {
              name: t('workspace.custom.open'),
              exact: true,
            })
            .click();
          const modal = page.getByRole('dialog');
          await modal
            .getByRole('combobox', { name: t('workspace.custom.itemTitle') })
            .fill('Free inspection');
          await modal
            .getByLabel(t('workspace.custom.price'), { exact: true })
            .fill('0');
          await modal
            .getByRole('button', {
              name: t('workspace.custom.add'),
              exact: true,
            })
            .click();
          await expect(page.getByTestId('line-row')).toHaveCount(4);
        },
      );
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
            .getByRole('button', {
              name: t('workspace.checkout.payments'),
              exact: true,
            })
            .click();
          const payments = page.getByRole('dialog', {
            name: t('workspace.checkout.payments'),
            exact: true,
          });
          await payments
            .getByLabel(`${t('workspace.checkout.amount')} 1`, { exact: true })
            .fill(total);
          await payments
            .getByRole('button', {
              name: t('workspace.checkout.apply'),
              exact: true,
            })
            .click();
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
        'check-prices',
        'Check prices contains the current pricing time.',
        'Cek harga memuat waktu harga saat ini.',
        async () => {
          await page
            .getByRole('button', {
              name: t('workspace.repricing.open'),
              exact: true,
            })
            .click();
          const dialog = page.getByRole('dialog', {
            name: t('workspace.repricing.title'),
            exact: true,
          });
          await expect(
            dialog.getByRole('button', {
              name: t('workspace.header.changePricingAt'),
            }),
          ).toBeEnabled();
        },
      );
      await step(
        'pricing-time',
        'Pricing time can be edited from Check prices.',
        'Waktu harga dapat diubah melalui Cek harga.',
        async () => {
          await page
            .getByRole('button', {
              name: t('workspace.header.changePricingAt'),
            })
            .click();
          await expect(
            page.getByRole('dialog', {
              name: t('workspace.pricing.title'),
              exact: true,
            }),
          ).toBeVisible();
        },
        false,
      );
      await page
        .getByRole('dialog', {
          name: t('workspace.pricing.title'),
          exact: true,
        })
        .getByRole('button', {
          name: t('workspace.common.cancel'),
          exact: true,
        })
        .click();
      await page
        .getByRole('dialog', {
          name: t('workspace.repricing.title'),
          exact: true,
        })
        .getByRole('button', { name: t('workspace.common.close'), exact: true })
        .last()
        .click();
      await step(
        'zero-confirmation',
        'All zero-priced items are listed before checkout review.',
        'Seluruh item berharga nol ditampilkan sebelum tinjauan checkout.',
        async () => {
          await page
            .getByRole('button', {
              name: t('workspace.checkout.review'),
              exact: true,
            })
            .click();
          await expect(
            page.getByRole('dialog', { name: t('workspace.review.zeroTitle') }),
          ).toContainText('Free inspection');
        },
      );
      await step(
        'review',
        'Checkout review opens after all inline edits are saved.',
        'Tinjauan pembayaran terbuka setelah seluruh perubahan tersimpan.',
        async () => {
          const zero = page.getByRole('dialog', {
            name: t('workspace.review.zeroTitle'),
          });
          await expect(zero).toContainText('Free inspection');
          await zero
            .getByRole('button', { name: t('workspace.review.zeroContinue') })
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

test('transaction columns resize independently and survive restart', async () => {
  test.setTimeout(120000);
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-columns-'));
  let launched = await launchApp({ dataDir });
  try {
    const { page } = launched;
    await seedWorkshop(page, 'id');
    await loginWithKeyboard(page, 'siti', CASHIER_PASSWORD, 'id');
    await page.setViewportSize({ width: 1366, height: 768 });
    const search = page.getByRole('combobox', {
      name: tr('id', 'workspace.search.label'),
    });
    await search.fill(OIL_BARCODE);
    await search.press('Enter');
    await expect(page.getByTestId('line-row')).toHaveCount(1);
    const row = page.getByTestId('line-row').first();
    await expect(row.locator('td').nth(1)).toHaveCSS('white-space', 'nowrap');
    await expect(row.locator('td').nth(3)).toHaveCSS('text-align', 'center');
    await expect(
      search.locator('..').locator('..').locator('..'),
    ).toBeVisible();
    expect(await search.evaluate((el) => el.closest('td')?.colSpan)).toBe(2);
    const table = page.getByRole('table', {
      name: tr('id', 'workspace.lines.caption'),
    });
    const widths = () =>
      table
        .locator('th')
        .evaluateAll((cells) =>
          cells.map((c) => c.getBoundingClientRect().width),
        );
    const before = await widths();
    const handle = table.getByRole('separator').nth(1);
    const rect = await handle.boundingBox();
    expect(rect).not.toBeNull();
    await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + 10);
    await page.mouse.down();
    await page.mouse.move(rect!.x + rect!.width / 2 + 80, rect!.y + 100);
    await page.mouse.up();
    const after = await widths();
    expect(after[1]! - before[1]!).toBeCloseTo(80, 0);
    for (let i = 0; i < 13; i++)
      if (i !== 1) expect(after[i]).toBeCloseTo(before[i]!, 0);
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    const saved = await widths();
    expect(saved[1]! - after[1]!).toBeCloseTo(8, 0);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(handle).toHaveAttribute('aria-valuenow', String(saved[1]));
    await page.screenshot({ path: path.join(dataDir, 'columns.png') });
    await launched.close();
    launched = await launchApp({ dataDir });
    await loginWithKeyboard(launched.page, 'siti', CASHIER_PASSWORD, 'id');
    const restored = launched.page.getByRole('separator').nth(1);
    await expect(restored).toHaveAttribute('aria-valuenow', String(saved[1]));
  } finally {
    await launched.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
