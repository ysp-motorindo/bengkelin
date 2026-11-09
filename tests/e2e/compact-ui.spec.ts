import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { seedWorkshop, loginWithKeyboard, ADMIN_PASSWORD } from './helpers/workflow-seed';
import { tr } from './helpers/i18n';

for (const lang of ['id', 'en'] as const) {
  test(`${lang}: compact controls preserve login and consistent navigation`, async () => {
    const launched = await launchApp();
    try {
      const { page } = launched;
      await seedWorkshop(page, lang);
      await page.reload();
      const t = (key: string) => tr(lang, key);
      const login = page.getByRole('button', { name: t('auth.login.submit'), exact: true });
      await expect(login).toHaveCSS('height', '40px');
      await expect(login).toHaveCSS('font-size', '14px');
      await loginWithKeyboard(page, 'admin', ADMIN_PASSWORD, lang);
      const rows = page.getByRole('navigation');
      const primary = rows.first().locator('[aria-current]');
      const secondary = rows.nth(1).locator('[aria-current]');
      await expect(primary).toHaveCSS('height', '32px');
      await expect(primary).toHaveCSS('font-size', '12px');
      await expect(primary).toHaveCSS('border-bottom-width', '2px');
      await expect(secondary).toHaveCSS('border-bottom-width', '2px');
      expect(await primary.evaluate(el => getComputedStyle(el).borderBottomColor)).toBe(await secondary.evaluate(el => getComputedStyle(el).borderBottomColor));
      await expect(secondary).toHaveText(lang === 'en' ? 'New Sale' : 'Penjualan Baru');
      await expect(page.locator('header').getByRole('button', { name: t('workspace.drafts.new'), exact: true })).toHaveCSS('height', '28px');
      await page.getByTestId('session-name').click();
      await expect(page.getByRole('button', { name: t('shell.logout'), exact: true })).toHaveCSS('height', '28px');
    } finally { await launched.close(); }
  });
}
