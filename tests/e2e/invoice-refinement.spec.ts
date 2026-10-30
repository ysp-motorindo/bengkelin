import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import {
  ADMIN_PASSWORD,
  CASHIER_PASSWORD,
  OIL_BARCODE,
  loginWithKeyboard,
  seedWorkshop,
} from './helpers/workflow-seed';
import { tr } from './helpers/i18n';

for (const lang of ['id', 'en'] as const) {
  test(`${lang}: refined invoice entry persists and the footer stays visible`, async () => {
    test.setTimeout(120000);
    const launched = await launchApp();
    const { page } = launched;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const t = (key: string) => tr(lang, key);
    const directory = path.resolve('output/invoice-refinement', lang);
    await mkdir(directory, { recursive: true });
    try {
      await seedWorkshop(page, lang);
      await page.evaluate(async (password) => {
        const b = window.bengkelin;
        const session = await b.auth.login({ username: 'admin', password });
        if (!session.ok) throw new Error(JSON.stringify(session.error));
        const units = await b.references.listActive({ entity: 'unit' });
        if (!units.ok) throw new Error(JSON.stringify(units.error));
        const item = await b.catalog.save({
          type: 'SERVICE',
          title: 'Unpriced inspection',
          unitId: units.value[0]!.id,
        });
        if (!item.ok) throw new Error(JSON.stringify(item.error));
        const barcode = await b.catalog.saveBarcodes({
          catalogItemId: item.value.id,
          barcodes: [{ barcode: 'UNPRICED-1', isActive: true }],
        });
        if (!barcode.ok) throw new Error(JSON.stringify(barcode.error));
        await b.auth.logout();
      }, ADMIN_PASSWORD);
      await page.reload();
      await loginWithKeyboard(page, 'siti', CASHIER_PASSWORD, lang);
      const search = page.getByRole('combobox', {
        name: t('workspace.search.label'),
      });
      const invoiceNumber = page.getByLabel(
        t('workspace.header.invoiceNumber'),
        { exact: true },
      );
      await expect(invoiceNumber).toHaveValue(/^INV-\d{8}-\d{4,}$/);
      const number = await invoiceNumber.inputValue();
      await expect(
        page.getByLabel(t('workspace.header.customer'), { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByLabel(t('workspace.header.vehicleNumber'), { exact: true }),
      ).toBeVisible();
      await search.fill(OIL_BARCODE);
      await search.press('Enter');
      await expect(page.getByTestId('line-row')).toHaveCount(1);
      await search.fill('Unpriced');
      const option = page.getByRole('option', { name: /Unpriced inspection/ });
      await expect(option).toBeVisible();
      expect(
        await option.evaluate((element) => element.closest('table') === null),
      ).toBe(true);
      await option.click();
      const unpriced = page.getByTestId('line-row').last();
      await expect(unpriced).toBeVisible();
      const price = unpriced.getByLabel(t('workspace.editor.unitPrice'), {
        exact: false,
      });
      await expect(price).toBeFocused();
      await price.fill('25000');
      await price.press('Tab');
      await search.fill('UNPRICED-1');
      await search.press('Enter');
      await expect(page.getByTestId('line-row')).toHaveCount(3);
      const cash = page.getByRole('textbox', {
        name: t('workspace.checkout.payments'),
        exact: true,
      });
      await cash.fill('100000');
      await expect(page.getByTestId('cash-change')).toContainText('10.000');
      await expect(
        page.getByText(t('workspace.checkout.downPayment'), { exact: true }),
      ).toHaveCount(0);
      await page
        .getByLabel(t('workspace.header.topDays'), { exact: true })
        .fill('7');
      await expect(
        page.getByText(t('workspace.checkout.downPayment'), { exact: true }),
      ).toBeVisible();
      await page
        .getByLabel(t('workspace.header.taxInvoiceNumber'), { exact: true })
        .fill('TAX-42');
      await expect(page.getByTestId('save-state')).toHaveAttribute(
        'data-state',
        'saved',
      );
      await page.reload();
      await expect(invoiceNumber).toHaveValue(number);
      await expect(
        page.getByLabel(t('workspace.header.taxInvoiceNumber'), {
          exact: true,
        }),
      ).toHaveValue('TAX-42');
      await expect(cash).toHaveValue('100.000');
      await page.evaluate(async () => {
        const b = window.bengkelin;
        const list = await b.drafts.list();
        if (!list.ok) throw new Error(JSON.stringify(list.error));
        const current = await b.drafts.get(list.value[0]!.id);
        if (!current.ok) throw new Error(JSON.stringify(current.error));
        let view = current.value;
        for (let index = 0; index < 16; index++) {
          const result = await b.drafts.apply({
            requestId: crypto.randomUUID(),
            invoiceId: view.id,
            expectedVersion: view.version,
            op: {
              kind: 'addCustomLine',
              type: 'SERVICE',
              title: `Inspection ${index}`,
              unitPrice: '1000',
            },
          });
          if (!result.ok) throw new Error(JSON.stringify(result.error));
          view = result.value;
        }
      });
      for (const appearance of ['LIGHT', 'DARK'] as const) {
        await page.evaluate(
          async ({ appearance, lang }) => {
            const result = await window.bengkelin.settings.updatePreferences({
              language: lang,
              appearance,
              numberFormat: 'ID',
            });
            if (!result.ok) throw new Error(JSON.stringify(result.error));
          },
          { appearance, lang },
        );
        await page.reload();
        for (const size of [
          { width: 1366, height: 768 },
          { width: 1920, height: 1080 },
        ]) {
          await page.setViewportSize(size);
          const footer = page.getByRole('complementary', {
            name: t('workspace.checkout.label'),
          });
          await expect(footer).toBeInViewport();
          await expect(
            page.getByRole('button', {
              name: t('workspace.checkout.review'),
              exact: true,
            }),
          ).toBeInViewport();
          await page.getByTestId('line-row').last().scrollIntoViewIfNeeded();
          await expect(page.getByTestId('line-row').last()).toBeInViewport();
          await expect(footer).toBeInViewport();
          await page.screenshot({
            path: path.join(
              directory,
              `${appearance}-${size.width}x${size.height}.png`,
            ),
          });
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await launched.close();
    }
  });
}

test('keyboard dropdown keeps the active product visible when wrapping through ten results', async () => {
  const launched = await launchApp();
  const { page } = launched;
  try {
    await page.setViewportSize({ width: 1366, height: 768 });
    await seedWorkshop(page, 'id');
    await page.evaluate(async (password) => {
      const b = window.bengkelin;
      const login = await b.auth.login({ username: 'admin', password });
      if (!login.ok) throw new Error(JSON.stringify(login.error));
      const units = await b.references.listActive({ entity: 'unit' });
      if (!units.ok) throw new Error(JSON.stringify(units.error));
      for (let index = 0; index < 10; index++) {
        const result = await b.catalog.save({
          type: 'SERVICE',
          title: `Dropdown fixture ${String(index).padStart(2, '0')}`,
          unitId: units.value[0]!.id,
        });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
      }
      await b.auth.logout();
    }, ADMIN_PASSWORD);
    await page.reload();
    await loginWithKeyboard(page, 'siti', CASHIER_PASSWORD, 'id');
    const search = page.getByRole('combobox', { name: 'Cari barang' });
    await search.fill('Dropdown fixture');
    const options = page
      .getByRole('listbox', { name: 'Hasil pencarian barang' })
      .getByRole('option');
    await expect(options).toHaveCount(11);
    for (const [key, index] of [
      ['ArrowUp', 10],
      ['ArrowDown', 0],
      ['ArrowUp', 10],
    ] as const) {
      await search.press(key);
      const option = options.nth(index);
      await expect(option).toHaveAttribute('aria-selected', 'true');
      await expect(option).toBeInViewport({ ratio: 1 });
      await expect(search).toBeFocused();
    }
    await search.press('ArrowUp');
    await search.press('Enter');
    await expect(
      page
        .getByTestId('line-row')
        .getByText('Dropdown fixture 09', { exact: true }),
    ).toBeVisible();
    await expect(options).toHaveCount(0);
    await expect(
      page
        .getByTestId('line-row')
        .last()
        .getByLabel(/Harga jual/),
    ).toBeFocused();
  } finally {
    await launched.close();
  }
});
