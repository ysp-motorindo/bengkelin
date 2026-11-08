import { test, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './helpers/launch';
import { tr } from './helpers/i18n';
for (const locale of ['id', 'en'] as const)
  for (const role of ['ADMIN', 'CASHIER'] as const) {
    test(`purchase partial deliveries, credits, refund and restart (${locale}, ${role})`, async () => {
      test.setTimeout(180000);
      const dataDir = await mkdtemp(
        path.join(tmpdir(), 'bengkelin-purchase-e2e-'),
      );
      const output = path.resolve('artifacts/purchases', locale + '-' + role);
      await mkdir(output, { recursive: true });
      let launched = await launchApp({
        dataDir,
        env: {
          BENGKELIN_TEST_SAVE_PDF_PATH: path.join(output, 'purchase-bill.pdf'),
        },
      });
      let page = launched.page;
      const t = (key: string) => tr(locale, key);
      const lineTitle = 'Purchase filter';
      const field = (key: string) => t('purchases.' + key);
      const qtyLabel = field('quantityLabel').replace('{{title}}', lineTitle);
      const priceLabel = field('priceLabel').replace('{{title}}', lineTitle);
      const capture = async (name: string) => {
        await page.screenshot({
          path: path.join(
            output,
            new Date().toISOString().replace(/[:.]/g, '-') +
              '-' +
              name +
              '.png',
          ),
          fullPage: false,
          scale: 'css',
        });
      };
      try {
        await page.setViewportSize({ width: 1800, height: 1040 });
        expect(await page.evaluate(() => devicePixelRatio)).toBe(1);
        const locations = await page.evaluate(
          async ({ locale, role }) => {
            const b = window.bengkelin;
            const must = <T>(
              r: import('../../src/shared/primitives').Result<T>,
            ) => {
              if (!r.ok) throw Error(JSON.stringify(r.error));
              return r.value;
            };
            must(
              await b.settings.completeSetup({
                shop: {
                  name: 'Purchase test workshop',
                  address: 'Test street',
                  timezone: 'Asia/Jakarta',
                },
                admin: {
                  username: 'admin',
                  displayName: 'Test Admin',
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
            const units = must(
              await b.references.listActive({ entity: 'unit' }),
            );
            const item = must(
              await b.catalog.save({
                type: 'STOCK_ITEM',
                title: 'Purchase filter',
                unitId: units[0]!.id,
                sku: 'PUR-FILTER',
                trackInventory: true,
              }),
            );
            must(
              await b.catalog.saveBarcodes({
                catalogItemId: item.id,
                barcodes: [{ barcode: 'PURCHASE001', isActive: true }],
              }),
            );
            const a = must(
              await b.references.save({
                entity: 'stockLocation',
                code: 'A',
                label: 'Warehouse A',
                isDefault: true,
              }),
            );
            const second = must(
              await b.references.save({
                entity: 'stockLocation',
                code: 'B',
                label: 'Warehouse B',
              }),
            );
            must(
              await b.suppliers.save({
                requestId: crypto.randomUUID(),
                name: 'Supplier A',
              }),
            );
            if (role === 'CASHIER') {
              must(
                await b.cashiers.create({
                  username: 'purchaser',
                  displayName: 'Purchasing Cashier',
                  password: 'purchaser-password',
                  role: 'CASHIER',
                }),
              );
              must(await b.auth.logout());
              must(
                await b.auth.login({
                  username: 'purchaser',
                  password: 'purchaser-password',
                }),
              );
            }
            return { a: a.id, b: second.id, item: item.id };
          },
          { locale, role },
        );
        await page.reload();
        await page
          .getByRole('navigation')
          .getByRole('button', { name: t('shell.nav.purchases'), exact: true })
          .click();
        await page
          .getByRole('button', { name: field('new'), exact: true })
          .click();
        await page
          .getByLabel(field('supplier'), { exact: true })
          .selectOption({ label: 'Supplier A' });
        const scanner = page.getByRole('combobox', {
          name: t('workspace.search.label'),
          exact: true,
        });
        await scanner.fill('PURCHASE001');
        await scanner.press('Enter');
        const price = page.getByRole('textbox', {
          name: priceLabel,
          exact: true,
        });
        await expect(price).toHaveValue('');
        await capture('blank-price');
        await page
          .getByRole('textbox', { name: qtyLabel, exact: true })
          .fill('10');
        await price.fill('10000');
        await page
          .getByRole('button', { name: field('addPayment'), exact: true })
          .click();
        await page
          .getByRole('textbox', { name: field('amount'), exact: true })
          .fill('60000');
        await page
          .getByRole('button', { name: field('review'), exact: true })
          .click();
        let dialog = page.getByRole('dialog', {
          name: field('review'),
          exact: true,
        });
        await dialog
          .getByRole('button', { name: field('finalize'), exact: true })
          .click();
        await expect(
          page.getByRole('heading', { name: /PUR-\d{8}-\d+/ }),
        ).toBeVisible();
        await capture('bill-recorded');
        const receive = async (location: string, quantity: string) => {
          await page
            .getByRole('button', { name: field('receive'), exact: true })
            .click();
          const d = page.getByRole('dialog', {
            name: field('receive'),
            exact: true,
          });
          await d
            .getByLabel(field('location'), { exact: true })
            .selectOption(location);
          await d
            .getByRole('textbox', { name: qtyLabel, exact: true })
            .fill(quantity);
          await d
            .getByRole('button', { name: field('reviewAction'), exact: true })
            .click();
          await d
            .getByRole('button', { name: field('confirm'), exact: true })
            .click();
          await expect(d).not.toBeVisible();
        };
        await receive(locations.a, '6');
        await capture('partial-receipt');
        await receive(locations.b, '2');
        const credit = async (quantity: string, physical: boolean) => {
          await page
            .getByRole('button', { name: field('credit'), exact: true })
            .click();
          const d = page.getByRole('dialog', {
            name: field('credit'),
            exact: true,
          });
          if (physical) {
            const option = d
              .getByRole('option')
              .filter({ hasText: 'Warehouse A' });
            const value = await option.getAttribute('value');
            await d
              .getByLabel(field('creditSource'), { exact: true })
              .selectOption(value!);
          }
          await d
            .getByRole('textbox', { name: qtyLabel, exact: true })
            .fill(quantity);
          await d
            .getByLabel(field('reason'), { exact: true })
            .fill('Supplier agreed');
          await d
            .getByRole('button', { name: field('reviewAction'), exact: true })
            .click();
          await d
            .getByRole('button', { name: field('confirm'), exact: true })
            .click();
          await expect(d).not.toBeVisible();
        };
        await credit('2', false);
        await credit('3', true);
        await capture('refund-due');
        const state = await page.evaluate(async () => {
          const r = await window.bengkelin.purchases.search({});
          if (!r.ok) throw Error(r.error.code);
          return r.value.items[0]!;
        });
        expect(state.refundDue).toBe('10000');
        expect(state.outstandingAmount).toBe('0');
        expect(state.receivingStatus).toBe('COMPLETE');
        await page
          .getByRole('button', { name: field('recordRefund'), exact: true })
          .click();
        dialog = page.getByRole('dialog', {
          name: field('recordRefund'),
          exact: true,
        });
        await expect(
          dialog.getByRole('textbox', { name: field('amount'), exact: true }),
        ).toHaveValue('10.000');
        await dialog
          .getByRole('button', { name: field('reviewAction'), exact: true })
          .click();
        await dialog
          .getByRole('button', { name: field('confirm'), exact: true })
          .click();
        await expect(dialog).not.toBeVisible();
        await expect(
          page.getByText(field('status.SETTLED'), { exact: true }),
        ).toBeVisible();
        await capture('settled');
        const prints = page.getByTestId('print-actions');
        await prints
          .first()
          .getByRole('button', {
            name: t('printing.actions.preview'),
            exact: true,
          })
          .click();
        const preview = page.getByRole('dialog', {
          name: t('printing.preview.title'),
          exact: true,
        });
        await expect(
          preview.getByText(/Purchase Bill|Faktur Pembelian/, { exact: true }),
        ).toBeVisible();
        expect(
          await preview
            .locator('.sheet')
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await capture('bill-preview');
        await preview
          .getByRole('button', {
            name: t('printing.preview.close'),
            exact: true,
          })
          .last()
          .click();
        await prints
          .first()
          .getByRole('button', {
            name: t('printing.actions.exportPdf'),
            exact: true,
          })
          .click();
        await expect(prints.first().getByTestId('print-notice')).toContainText(
          'purchase-bill.pdf',
        );
        expect(
          (await readFile(path.join(output, 'purchase-bill.pdf')))
            .subarray(0, 5)
            .toString(),
        ).toBe('%PDF-');
        await prints
          .nth(1)
          .getByRole('button', {
            name: t('printing.actions.preview'),
            exact: true,
          })
          .click();
        const receiptPreview = page.getByRole('dialog', {
          name: t('printing.preview.title'),
          exact: true,
        });
        await expect(
          receiptPreview
            .getByLabel(t('printing.preview.format'), { exact: true })
            .getByRole('option'),
        ).toHaveCount(1);
        await receiptPreview
          .getByRole('button', {
            name: t('printing.preview.close'),
            exact: true,
          })
          .last()
          .click();

        const stock = await page.evaluate(async ({ a, b, item }) => {
          const bridge = window.bengkelin;
          const one = await bridge.inventory.getStock({
            catalogItemId: item,
            stockLocationId: a,
          });
          const two = await bridge.inventory.getStock({
            catalogItemId: item,
            stockLocationId: b,
          });
          if (!one.ok || !two.ok) throw Error('stock');
          return [one.value.quantity, two.value.quantity];
        }, locations);
        expect(stock).toEqual([3, 2]);
        // A native restart loses the session, but keeps all purchase records.
        await launched.close();
        launched = await launchApp({ dataDir });
        page = launched.page;
        await page.setViewportSize({ width: 1800, height: 1040 });
        await page.evaluate(async (role) => {
          const r = await window.bengkelin.auth.login(
            role === 'ADMIN'
              ? { username: 'admin', password: 'correct-horse-battery' }
              : { username: 'purchaser', password: 'purchaser-password' },
          );
          if (!r.ok) throw Error(r.error.code);
        }, role);
        await page.reload();
        await page
          .getByRole('navigation')
          .getByRole('button', { name: t('shell.nav.purchases'), exact: true })
          .click();
        await page
          .getByRole('tab', { name: field('history'), exact: true })
          .click();
        await page
          .getByRole('button', { name: state.documentNumber, exact: true })
          .click();
        await expect(
          page.getByText(field('status.SETTLED'), { exact: true }),
        ).toBeVisible();
        await capture('reopened');
        const persisted = await page.evaluate(async (id) => {
          const r = await window.bengkelin.purchases.get({ purchaseId: id });
          if (!r.ok) throw Error(r.error.code);
          return r.value;
        }, state.id);
        expect(persisted.refundDue).toBe('0');
        expect(persisted.outstandingAmount).toBe('0');
        expect(persisted.receipts).toHaveLength(2);
        expect(persisted.credits).toHaveLength(2);
        expect(persisted.refunds[0]!.amount).toBe('10000');
      } finally {
        await launched.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
