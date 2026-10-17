import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import {
  seedWorkshop,
  loginWithKeyboard,
  CASHIER_PASSWORD,
} from './helpers/workflow-seed';

test('numeric formatting follows the cashier preference and preserves values', async () => {
  const launched = await launchApp();
  try {
    const { page } = launched;
    await seedWorkshop(page);
    await loginWithKeyboard(page, 'siti', CASHIER_PASSWORD);
    const odometer = page.getByLabel('Odometer (km)', { exact: true });
    await odometer.fill('12345');
    await expect(odometer).toHaveValue('12.345');
    await odometer.press('End');
    await odometer.pressSequentially('eEabc');
    await expect(odometer).toHaveValue('12.345');
    await odometer.hover();
    await page.mouse.wheel(0, 150);
    await expect(odometer).toHaveValue('12.345');
    await page.getByTestId('session-name').click();
    await page.getByLabel('Format angka', { exact: true }).selectOption('US');
    await expect(odometer).toHaveValue('12,345');
    await odometer.fill('1234567');
    await expect(odometer).toHaveValue('1,234,567');
    await odometer.evaluate((element) => {
      const data = new DataTransfer();
      data.setData('text/plain', '1e5');
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    });
    await expect(odometer).toHaveValue('1,234,567');
    const session = await page.evaluate(() =>
      window.bengkelin.auth.currentSession(),
    );
    expect(session.ok && session.value?.numberFormat).toBe('US');
    await expect(page.getByTestId('save-state')).toHaveAttribute(
      'data-state',
      'saved',
    );
    await page.reload();
    await expect(page.getByLabel('Odometer (km)', { exact: true })).toHaveValue(
      '1,234,567',
    );
  } finally {
    await launched.close();
  }
});
