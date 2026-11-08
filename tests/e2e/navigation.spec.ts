import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './helpers/launch';
import {
  seedWorkshop,
  ADMIN_PASSWORD,
  CASHIER_PASSWORD,
} from './helpers/workflow-seed';
import { tr } from './helpers/i18n';
import { navigateTo } from './helpers/navigation';

let launched: LaunchedApp | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

for (const language of ['id', 'en'] as const)
  for (const appearance of ['LIGHT', 'DARK'] as const)
    for (const role of ['ADMIN', 'CASHIER'] as const) {
      test(`${language} ${appearance} ${role}: stacked navigation fits and remains operable`, async ({
        browserName: _browserName,
      }, testInfo) => {
        launched = await launchApp();
        const { page, app } = launched;
        await seedWorkshop(page, language);
        await page.evaluate(
          async ({
            language,
            appearance,
            role,
            adminPassword,
            cashierPassword,
          }) => {
            const b = window.bengkelin;
            const login = await b.auth.login({
              username: role === 'ADMIN' ? 'admin' : 'siti',
              password: role === 'ADMIN' ? adminPassword : cashierPassword,
            });
            if (!login.ok) throw new Error(JSON.stringify(login.error));
            const result = await b.settings.updatePreferences({
              language,
              appearance,
              numberFormat: 'ID',
            });
            if (!result.ok) throw new Error(JSON.stringify(result.error));
          },
          {
            language,
            appearance,
            role,
            adminPassword: ADMIN_PASSWORD,
            cashierPassword: CASHIER_PASSWORD,
          },
        );
        await page.reload();
        await expect(page.getByTestId('session-name')).toBeVisible();
        const t = (key: string) => tr(language, key);
        const primary = page.getByRole('navigation', {
          name: t('shell.nav.label'),
          exact: true,
        });
        await expect(primary.getByRole('button')).toHaveCount(
          role === 'ADMIN' ? 6 : 5,
        );
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 960, height: 600 },
        ]) {
          await page.setViewportSize(viewport);
          await navigateTo(page, 'workspace', language);
          const purchase = primary.getByRole('button', {
            name: t('shell.nav.purchases'),
            exact: true,
          });
          await purchase.focus();
          await page.keyboard.press('Enter');
          const secondary = page.getByRole('navigation', {
            name: t('shell.nav.secondaryLabel').replace(
              '{{area}}',
              t('shell.nav.purchases'),
            ),
            exact: true,
          });
          await expect(secondary.getByRole('button')).toHaveCount(5);
          const first = await primary.boundingBox();
          const second = await secondary.boundingBox();
          expect(second!.y).toBeGreaterThanOrEqual(
            first!.y + first!.height - 1,
          );
          for (const row of [primary, secondary]) {
            expect(
              await row
                .getByRole('button')
                .evaluateAll(
                  (buttons) =>
                    new Set(buttons.map((b) => b.getBoundingClientRect().y))
                      .size,
                ),
            ).toBe(1);
          }
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
          await page.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight),
          );
          expect(
            await page
              .locator('div.sticky.top-0')
              .evaluate((el) => Math.round(el.getBoundingClientRect().top)),
          ).toBe(0);
          await page.screenshot({
            path: testInfo.outputPath(`purchase-${viewport.width}.png`),
          });
          await navigateTo(page, 'customers', language);
          await expect(page.getByRole('navigation')).toHaveCount(1);
          if (role === 'ADMIN') {
            await navigateTo(page, 'references', language);
            await page.screenshot({
              path: testInfo.outputPath(`administration-${viewport.width}.png`),
            });
          }
        }
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.5),
        );
        await navigateTo(page, 'purchases', language);
        const supplier = page
          .getByRole('navigation')
          .getByRole('button', { name: t('purchases.suppliers'), exact: true });
        await supplier.focus();
        await page.keyboard.press('Space');
        await expect(supplier).toHaveAttribute('aria-current', 'page');
        await expect(supplier).toBeInViewport();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
      });
    }
