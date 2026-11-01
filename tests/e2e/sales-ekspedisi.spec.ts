import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { tr } from './helpers/i18n';

for (const locale of ['id', 'en'] as const) {
  test(`sales and expedition import, selection and historical output (${locale})`, async () => {
    test.setTimeout(120_000);
    const output = path.resolve('artifacts/sales-ekspedisi');
    fs.mkdirSync(path.join(output, 'screenshots'), { recursive: true });
    const csv = path.join(output, `chosen-${locale}.csv`);
    fs.copyFileSync(path.resolve('references/sales-import.csv'), csv);
    const launched = await launchApp({
      env: { BENGKELIN_TEST_OPEN_CSV_PATH: csv },
    });
    const { page } = launched;
    const t = (key: string) => tr(locale, key);
    const capture = async (id: string) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await page.screenshot({
        path: path.join(output, 'screenshots', `${stamp}-${locale}-${id}.png`),
        fullPage: false,
        scale: 'css',
      });
    };
    try {
      await page.setViewportSize({ width: 1800, height: 1040 });
      expect(await page.evaluate(() => devicePixelRatio)).toBe(1);
      await page.evaluate(async (locale) => {
        const b = window.bengkelin;
        const setup = await b.settings.completeSetup({
          shop: {
            name: 'Demonstration workshop',
            address: 'Demo street',
            timezone: 'Asia/Jakarta',
          },
          admin: {
            username: 'admin',
            displayName: 'Demo Admin',
            password: 'correct-horse-battery',
          },
          preferences: { language: locale, appearance: 'LIGHT' },
        });
        if (!setup.ok) throw new Error(JSON.stringify(setup.error));
        const login = await b.auth.login({
          username: 'admin',
          password: 'correct-horse-battery',
        });
        await b.references.save({
          entity: 'stockLocation',
          code: '01',
          label: 'Gudang',
          isDefault: true,
        });

        if (!login.ok) throw new Error(JSON.stringify(login.error));
      }, locale);
      await page.reload();
      const nav = page.getByRole('navigation');
      await nav
        .getByRole('button', { name: t('shell.nav.references'), exact: true })
        .click();
      for (const entity of ['sales', 'expedition'] as const) {
        fs.copyFileSync(
          path.resolve(
            `references/${entity === 'sales' ? 'sales' : 'ekspedisi'}-import.csv`,
          ),
          csv,
        );
        await page
          .getByRole('tab', {
            name: t(`references.entities.${entity}`),
            exact: true,
          })
          .click();
        await page
          .getByRole('button', {
            name: t('references.actions.add'),
            exact: true,
          })
          .click();
        const form = page.getByRole('form', {
          name: t('references.form.create'),
        });
        await form
          .getByRole('button', {
            name: t('references.actions.save'),
            exact: true,
          })
          .click();
        await expect(
          form.getByLabel(t('references.fields.code'), { exact: true }),
        ).toHaveAttribute('aria-invalid', 'true');
        await form
          .getByRole('button', { name: t('validation.required'), exact: true })
          .first()
          .focus();
        await expect(
          form.getByText(t('validation.required')).first(),
        ).toBeVisible();
        await capture(`${entity}-validation`);
        await form
          .getByRole('button', {
            name: t('references.actions.cancel'),
            exact: true,
          })
          .click();
        await page
          .getByRole('button', {
            name: t('references.import.title'),
            exact: true,
          })
          .click();
        const dialog = page.getByRole('dialog');
        await dialog
          .getByRole('button', {
            name: t('references.import.choose'),
            exact: true,
          })
          .click();
        await expect(
          dialog.getByTestId('reference-import-preview'),
        ).toBeVisible();
        await capture(`${entity}-preview`);
        await dialog
          .getByRole('button', {
            name: t('catalogTransfer.preview.commit'),
            exact: true,
          })
          .click();
        await expect(
          dialog.getByTestId('reference-import-result'),
        ).toContainText('bengkelin-safety-');
        await dialog
          .getByRole('button', {
            name: t('customers.edit.cancel'),
            exact: true,
          })
          .last()
          .click();
        await capture(`${entity}-master`);
      }
      await nav
        .getByRole('button', { name: t('shell.nav.workspace'), exact: true })
        .click();
      const sales = page.getByRole('combobox', {
        name: t('references.entities.sales'),
        exact: true,
      });
      const expedition = page.getByRole('combobox', {
        name: t('references.entities.expedition'),
        exact: true,
      });
      await expect(sales).toHaveValue('');
      await expect(expedition).toHaveValue('');
      await capture('blank-draft');
      await sales.focus();
      await page.keyboard.press('Tab');
      await expect(expedition).toBeFocused();
      const ids = await page.evaluate(async () => {
        const b = window.bengkelin;
        const s = await b.references.listActive({ entity: 'sales' });
        const e = await b.references.listActive({ entity: 'expedition' });
        if (!s.ok || !e.ok) throw new Error('master loading failed');
        return { sales: s.value[0]!, expedition: e.value[0]! };
      });
      await sales.selectOption(ids.sales.id);
      await expedition.selectOption(ids.expedition.id);
      await expect
        .poll(async () =>
          page.evaluate(async () => {
            const list = await window.bengkelin.drafts.list();
            if (!list.ok) return null;
            const draft = await window.bengkelin.drafts.get(list.value[0]!.id);
            return draft.ok && draft.value.sales && draft.value.expedition;
          }),
        )
        .toBeTruthy();
      await page.reload();
      await expect(sales).toHaveValue(ids.sales.id);
      await expect(expedition).toHaveValue(ids.expedition.id);
      await capture('selected-draft');
      await nav
        .getByRole('button', { name: t('shell.nav.references'), exact: true })
        .click();
      await page.evaluate(async (ids) => {
        for (const entity of ['sales', 'expedition'] as const) {
          const saved = await window.bengkelin.references.save({
            entity,
            id: ids[entity].id,
            label: `${ids[entity].label} updated`,
          });
          const deactivated = await window.bengkelin.references.deactivate({
            entity,
            id: ids[entity].id,
          });
          if (!saved.ok || !deactivated.ok)
            throw new Error('draft master edit failed');
        }
      }, ids);
      ids.sales.label += ' updated';
      ids.expedition.label += ' updated';
      await nav
        .getByRole('button', { name: t('shell.nav.workspace'), exact: true })
        .click();
      await expect(sales.locator('option:checked')).toHaveText(ids.sales.label);
      await expect(expedition.locator('option:checked')).toHaveText(
        ids.expedition.label,
      );
      await capture('renamed-inactive-draft');

      await page.evaluate(async () => {
        const b = window.bengkelin;
        const list = await b.drafts.list();
        if (!list.ok) throw new Error('list');
        const get = await b.drafts.get(list.value[0]!.id);
        if (!get.ok) throw new Error('get');
        const add = await b.drafts.apply({
          requestId: crypto.randomUUID(),
          invoiceId: get.value.id,
          expectedVersion: get.value.version,
          op: {
            kind: 'addCustomLine',
            type: 'SERVICE',
            title: 'Demonstration service',
            quantity: 1,
            unitPrice: '10000',
          },
        });
        if (!add.ok) throw new Error(JSON.stringify(add.error));
      });
      await page.reload();
      await page
        .getByLabel(t('workspace.header.topDays'), { exact: true })
        .fill('7');
      await page
        .getByRole('button', {
          name: t('workspace.checkout.review'),
          exact: true,
        })
        .click();
      const review = page.getByRole('dialog', {
        name: t('workspace.review.title'),
      });
      await expect(review).toBeVisible();
      await capture('checkout-review');
      await review
        .getByRole('button', {
          name: t('workspace.review.finalize'),
          exact: true,
        })
        .click();
      const done = page.getByRole('dialog', {
        name: t('workspace.finalize.doneTitle'),
      });
      await expect(done).toBeVisible();
      const number = (await done
        .getByTestId('finalized-invoice-number')
        .textContent())!;
      await done
        .getByRole('button', {
          name: t('workspace.finalize.newTransaction'),
          exact: true,
        })
        .click();
      await nav
        .getByRole('button', { name: t('shell.nav.history'), exact: true })
        .click();
      await page
        .getByRole('button', {
          name: t('history.table.openInvoice').replace('{{number}}', number),
        })
        .click();
      let detail = page.getByTestId('invoice-detail');
      await expect(detail).toContainText(ids.sales.label);
      await expect(detail).toContainText(ids.expedition.label);
      await capture('invoice-details');
      await page.evaluate(async (ids) => {
        for (const entity of ['sales', 'expedition'] as const) {
          const id = ids[entity].id;
          const save = await window.bengkelin.references.save({
            entity,
            id,
            label: 'Renamed after finalization',
          });
          const inactive = await window.bengkelin.references.deactivate({
            entity,
            id,
          });
          if (!save.ok || !inactive.ok) throw new Error('master edit failed');
        }
      }, ids);
      await page.reload();
      await nav
        .getByRole('button', { name: t('shell.nav.history'), exact: true })
        .click();
      await page
        .getByRole('button', {
          name: t('history.table.openInvoice').replace('{{number}}', number),
        })
        .click();
      detail = page.getByTestId('invoice-detail');
      await expect(detail).toContainText(ids.sales.label);
      await expect(detail).not.toContainText('Renamed after finalization');
      await detail
        .getByRole('button', {
          name: t('printing.actions.preview'),
          exact: true,
        })
        .click();
      const print = page.getByRole('dialog', {
        name: t('printing.preview.title'),
      });
      for (const format of ['A4', 'THERMAL_58', 'THERMAL_80']) {
        await print
          .getByLabel(t('printing.preview.format'), { exact: true })
          .selectOption(format);
        const doc = print.getByTestId('print-preview-document');
        await expect(
          doc.getByText(ids.sales.label, { exact: true }),
        ).toBeVisible();
        await expect(
          doc.getByText(ids.expedition.label, { exact: true }),
        ).toBeVisible();
        await capture(`historical-${format}`);
      }
      fs.writeFileSync(
        path.join(output, `result-${locale}.json`),
        JSON.stringify({
          locale,
          status: 'Pass',
          viewport: [1800, 1040],
          deviceScaleFactor: 1,
          timestamp: new Date().toISOString(),
          invoiceNumber: number,
        }),
      );
    } catch (error) {
      await capture('failure');
      throw error;
    } finally {
      await launched.close();
    }
  });
}
