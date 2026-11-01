import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import {
  CASHIER_PASSWORD,
  HELMET_BARCODE,
  loginWithKeyboard,
  seedWorkshop,
} from './helpers/workflow-seed';
import { tr } from './helpers/i18n';

for (const lang of ['id', 'en'] as const) {
  test(`${lang}: received payments, change, correction and applied history`, async () => {
    test.setTimeout(120000);
    const launched = await launchApp();
    const { page } = launched;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const t = (key: string) => tr(lang, key);
    const directory = path.resolve('output/checkout-payments', lang);
    await mkdir(directory, { recursive: true });
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: path.join(
          directory,
          `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.png`,
        ),
        scale: 'css',
      });
    };
    try {
      await page.setViewportSize({ width: 1800, height: 1040 });
      expect(await page.evaluate(() => devicePixelRatio)).toBe(1);
      await seedWorkshop(page, lang);
      await loginWithKeyboard(page, 'siti', CASHIER_PASSWORD, lang);
      const search = page.getByRole('combobox', {
        name: t('workspace.search.label'),
      });
      await search.fill(HELMET_BARCODE);
      await search.press('Enter');
      await expect(page.getByTestId('total-amount')).toHaveText('Rp 100.000');
      const opener = page.getByRole('button', {
        name: t('workspace.checkout.payments'),
        exact: true,
      });
      await expect(opener).toHaveCSS('border-bottom-style', 'dashed');
      await opener.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', {
        name: t('workspace.checkout.payments'),
        exact: true,
      });
      const amount = (index: number) =>
        dialog.getByLabel(`${t('workspace.checkout.amount')} ${index}`, {
          exact: true,
        });
      const method = (index: number) =>
        dialog.getByLabel(`${t('workspace.checkout.method')} ${index}`, {
          exact: true,
        });
      const apply = dialog.getByRole('button', {
        name: t('workspace.checkout.apply'),
        exact: true,
      });
      await expect(amount(1)).toBeFocused();
      await capture('initial-dialog');
      await expect(method(1)).toHaveCount(1);
      await method(1).selectOption('QRIS');
      await amount(1).fill('60000');
      await dialog
        .getByRole('button', {
          name: t('workspace.checkout.addPayment'),
          exact: true,
        })
        .click();
      await amount(2).fill('50000');
      await expect(dialog.getByTestId('payments-received')).toHaveText(
        'Rp 110.000',
      );
      await expect(dialog.getByTestId('payments-change')).toHaveText(
        'Rp 10.000',
      );
      await expect(apply).toBeInViewport({ ratio: 1 });
      await apply.focus();
      await page.keyboard.press('Tab');
      await expect(
        dialog.getByRole('button', {
          name: t('workspace.common.close'),
          exact: true,
        }),
      ).toBeFocused();
      await capture('mixed-dialog');
      await apply.click();
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect(opener).toHaveText('Rp 110.000');
      await expect(page.getByTestId('cash-change')).toHaveText('Rp 10.000');
      await capture('mixed-checkout');
      await page.reload();
      await expect(opener).toHaveText('Rp 110.000');
      await opener.click();
      await expect(amount(1)).toHaveValue('60.000');
      await expect(amount(2)).toHaveValue('50.000');
      await amount(2).fill('90000');
      await page.keyboard.press('Escape');
      await expect(opener).toHaveText('Rp 110.000');
      await opener.click();
      await expect(amount(2)).toHaveValue('50.000');
      await amount(1).fill('110000');
      await expect(dialog.getByRole('alert')).toContainText('10000');
      await expect(dialog.getByTestId('payments-change')).toHaveText('—');
      await capture('non-cash-excess');
      await apply.click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('cash-change')).toHaveText('—');
      await page
        .getByRole('button', {
          name: t('workspace.checkout.review'),
          exact: true,
        })
        .click();
      const review = page.getByRole('dialog', {
        name: t('workspace.review.title'),
      });
      await expect(review).toContainText(
        t('errors.NON_CASH_PAYMENT_EXCEEDS_AMOUNT').replace(
          '{{excessAmount}}',
          '10000',
        ),
      );
      await expect(review.getByTestId('finalize-button')).toBeDisabled();
      await capture('blocked-review');
      await page.keyboard.press('Escape');
      await opener.click();
      await amount(1).fill('60000');
      await apply.click();
      await expect(dialog).toHaveCount(0);
      await page
        .getByRole('button', {
          name: t('workspace.checkout.review'),
          exact: true,
        })
        .click();
      await expect(review.getByTestId('review-payments')).toContainText(
        'Rp 60.000',
      );
      await expect(review.getByTestId('review-payments')).toContainText(
        'Rp 40.000',
      );
      await expect(review.getByTestId('review-payments')).not.toContainText(
        'Rp 50.000',
      );
      await capture('applied-review');
      await review.getByTestId('finalize-button').click();
      const number = await page
        .getByTestId('finalized-invoice-number')
        .innerText();
      await expect(page.getByTestId('finalized-payment-status')).toHaveText(
        t('workspace.paymentStatus.PAID'),
      );
      await page
        .getByRole('button', {
          name: t('workspace.finalize.newTransaction'),
          exact: true,
        })
        .click();
      await page
        .getByRole('button', { name: t('shell.nav.history'), exact: true })
        .click();
      await page
        .getByRole('button', {
          name: t('history.table.openInvoice').replace('{{number}}', number),
          exact: true,
        })
        .click();
      const history = page.getByTestId('invoice-detail');
      const payments = history.getByTestId('payment-row');
      await expect(payments).toHaveCount(2);
      await expect(payments.nth(0)).toContainText('QRIS');
      await expect(payments.nth(0)).toContainText('Rp 60.000');
      await expect(payments.nth(1)).toContainText(
        t('workspace.paymentMethod.CASH'),
      );
      await expect(payments.nth(1)).toContainText('Rp 40.000');
      await payments.nth(1).scrollIntoViewIfNeeded();
      await capture('applied-history');
      expect(errors).toEqual([]);
    } catch (error) {
      await capture('failure');
      throw error;
    } finally {
      await launched.close();
    }
  });
}
