import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './helpers/launch';
import { tr } from './helpers/i18n';
import { ADMIN_PASSWORD, seedWorkshop } from './helpers/workflow-seed';

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

for (const language of ['id', 'en'] as const) {
  for (const appearance of ['LIGHT', 'DARK'] as const) {
    test(`${language} ${appearance}: headings, long tables, and dialog actions fit the window`, async ({
      browserName: _browserName,
    }, testInfo) => {
      launched = await launchApp();
      const { page } = launched;
      await seedWorkshop(page, language);
      await page.evaluate(
        async ({ password, language, appearance }) => {
          const b = window.bengkelin;
          const login = await b.auth.login({ username: 'admin', password });
          if (!login.ok) throw new Error(JSON.stringify(login.error));
          const preferences = await b.settings.updatePreferences({
            language,
            appearance,
            numberFormat: 'ID',
          });
          if (!preferences.ok)
            throw new Error(JSON.stringify(preferences.error));
          const units = await b.references.list({ entity: 'unit' });
          if (!units.ok) throw new Error(JSON.stringify(units.error));
          const pcs = units.value.find((unit) => unit.code === 'PCS')!;
          const item = await b.catalog.save({
            title: `Kampas Rem ${'Panjang'.repeat(20)}`,
            sku: 'SKU'.repeat(20),
            description: 'Deskripsi'.repeat(30),
            type: 'STOCK_ITEM',
            unitId: pcs.id,
          });
          if (!item.ok) throw new Error(JSON.stringify(item.error));
          const balance = await b.inventory.openBalance({
            stockLocationId: await b.references
              .listActive({ entity: 'stockLocation' })
              .then((r) => {
                if (!r.ok || !r.value[0]) throw new Error('location');
                return r.value[0].id;
              }),
            requestId: crypto.randomUUID(),
            catalogItemId: item.value.id,
            quantity: 123456789,
          });
          if (!balance.ok) throw new Error(JSON.stringify(balance.error));
        },
        { password: ADMIN_PASSWORD, language, appearance },
      );
      await page.reload();
      await expect(page.getByTestId('session-name')).toBeVisible();
      await expect(page.locator('html')).toHaveClass(
        appearance === 'DARK' ? /dark/ : /^$/,
      );
      const t = (key: string) => tr(language, key);
      const nav = page.getByRole('navigation');

      for (const viewport of [
        { width: 1120, height: 800 },
        { width: 390, height: 560 },
      ]) {
        await page.setViewportSize(viewport);
        for (const view of ['catalog', 'inventory'] as const) {
          await nav
            .getByRole('button', { name: t(`shell.nav.${view}`), exact: true })
            .click();
          await expect(page.getByRole('heading', { level: 1 })).toHaveText(
            t(`${view}.title`),
          );
          const table = page.getByRole('table').first();
          await expect(table).toBeVisible();
          if (viewport.width === 1120) {
            await expect(
              table.getByRole('columnheader').last(),
            ).toBeInViewport();
          } else {
            expect(
              await table.evaluate((element) => {
                const scroller = element.parentElement!;
                return scroller.scrollWidth > scroller.clientWidth;
              }),
            ).toBe(true);
          }
          expect(
            await table.evaluate(
              (element) => getComputedStyle(element.parentElement!).overflowX,
            ),
          ).toBe('auto');
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth <= window.innerWidth + 1,
            ),
          ).toBe(true);
          await page.screenshot({
            path: testInfo.outputPath(`${view}-${viewport.width}.png`),
            fullPage: true,
          });
          await page
            .getByTestId(view === 'catalog' ? 'catalog-row' : 'stock-row')
            .filter({ hasText: 'Kampas Rem' })
            .getByRole('button')
            .click();
          await expect(
            page.getByRole('heading', { level: 2, name: /^Kampas Rem/ }),
          ).toBeVisible();
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth <= window.innerWidth + 1,
            ),
          ).toBe(true);
          await page.screenshot({
            path: testInfo.outputPath(`${view}-detail-${viewport.width}.png`),
            fullPage: true,
          });
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog')).toHaveCount(0);
        }
        await nav
          .getByRole('button', { name: t('shell.nav.settings'), exact: true })
          .click();
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          t('shell.nav.settings'),
        );
        await expect(
          page.getByRole('heading', {
            level: 2,
            name: t('settings.shop.title'),
          }),
        ).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`settings-${viewport.width}.png`),
          fullPage: true,
        });
      }

      await nav
        .getByRole('button', { name: t('shell.nav.workspace'), exact: true })
        .click();
      await page
        .getByRole('combobox', { name: t('workspace.search.label') })
        .click();
      const open = page.getByRole('option', {
        name: t('workspace.custom.open'),
        exact: true,
      });
      await open.click();
      const dialog = page.getByRole('dialog', {
        name: t('workspace.custom.title'),
      });
      const cancel = dialog.getByRole('button', {
        name: t('workspace.common.cancel'),
        exact: true,
      });
      const add = dialog.getByRole('button', {
        name: t('workspace.custom.add'),
        exact: true,
      });
      await cancel.scrollIntoViewIfNeeded();
      await expect(cancel).toBeInViewport();
      await add.scrollIntoViewIfNeeded();
      await expect(add).toBeInViewport();
      await cancel.click();
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole('combobox', { name: t('workspace.search.label') }),
      ).toBeFocused();
    });
  }
}
