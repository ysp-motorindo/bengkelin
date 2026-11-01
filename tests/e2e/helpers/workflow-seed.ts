import { expect, type Page } from '@playwright/test';
import { tr, type Lang } from './i18n';

export const ADMIN_PASSWORD = 'correct-horse-battery';
export const CASHIER_PASSWORD = 'siti-password-1';
/** Oli MPX2 0.8L, Rp 65.000, 10 in stock. */
export const OIL_BARCODE = '8991234567890';
/** Helm Bogo, Rp 100.000, 5 in stock (the 30/50/10 discount line). */
export const HELMET_BARCODE = '8990000000017';

export const exact = { exact: true } as const;

/**
 * Setup through the public bridge (seeding only, before the scenario):
 * shop, ADMIN, CASHIER "siti", mechanic Andi, two stocked, priced items.
 */
export async function seedWorkshop(
  page: Page,
  language: Lang = 'id',
): Promise<void> {
  await page.evaluate(
    async ({ adminPassword, cashierPassword, oil, helmet, language }) => {
      const b = window.bengkelin;
      const must = <T>(
        result: { ok: true; value: T } | { ok: false; error: unknown },
        what: string,
      ): T => {
        if (!result.ok)
          throw new Error(`${what}: ${JSON.stringify(result.error)}`);
        return result.value;
      };
      must(
        await b.settings.completeSetup({
          shop: {
            name: 'Bengkel Maju',
            address: 'Jl. A',
            timezone: 'Asia/Jakarta',
          },
          admin: {
            username: 'admin',
            displayName: 'Pak Budi',
            password: adminPassword,
          },
          preferences: { language, appearance: 'LIGHT' },
        }),
        'setup',
      );
      must(
        await b.auth.login({ username: 'admin', password: adminPassword }),
        'login',
      );
      await b.references.save({
        entity: 'stockLocation',
        code: '01',
        label: 'Gudang',
        isDefault: true,
      });

      must(
        await b.cashiers.create({
          username: 'siti',
          displayName: 'Siti',
          password: cashierPassword,
          role: 'CASHIER',
        }),
        'cashier',
      );
      must(
        await b.references.save({ entity: 'mechanic', name: 'Andi' }),
        'mechanic',
      );
      const units = must(await b.references.list({ entity: 'unit' }), 'units');
      const channels = must(
        await b.references.list({ entity: 'channel' }),
        'channels',
      );
      const pcs = units.find((u) => u.code === 'PCS')!;
      const bengkel = channels.find((c) => c.code === 'BENGKEL')!;
      for (const [title, barcode, price, stock] of [
        ['Oli MPX2 0.8L', oil, '65000', 10],
        ['Helm Bogo', helmet, '100000', 5],
      ] as const) {
        const item = must(
          await b.catalog.save({ type: 'STOCK_ITEM', title, unitId: pcs.id }),
          title,
        );
        must(
          await b.catalog.saveBarcodes({
            catalogItemId: item.id,
            barcodes: [{ barcode, isActive: true }],
          }),
          `${title} barcode`,
        );
        const preview = must(
          await b.catalog.previewPriceChange({
            catalogItemId: item.id,
            channelId: bengkel.id,
            effectiveStartAt: '2024-01-01T00:00:00.000Z',
            price,
          }),
          `${title} price preview`,
        );
        must(
          await b.catalog.applyPriceChange({ token: preview.token }),
          `${title} price`,
        );
        must(
          await b.inventory.openBalance({
            stockLocationId: await b.references
              .listActive({ entity: 'stockLocation' })
              .then((r) => {
                if (!r.ok || !r.value[0]) throw new Error('location');
                return r.value[0].id;
              }),
            requestId: crypto.randomUUID(),
            catalogItemId: item.id,
            quantity: stock,
          }),
          `${title} stock`,
        );
      }
      must(await b.auth.logout(), 'logout');
    },
    {
      adminPassword: ADMIN_PASSWORD,
      cashierPassword: CASHIER_PASSWORD,
      oil: OIL_BARCODE,
      helmet: HELMET_BARCODE,
      language,
    },
  );
  await page.reload();
}

/** Signs in with the keyboard only: type, Tab, type, Enter. */
export async function loginWithKeyboard(
  page: Page,
  username: string,
  password: string,
  lang: Lang = 'id',
): Promise<void> {
  const user = page.getByLabel(tr(lang, 'auth.login.username'), exact);
  await expect(user).toBeFocused();
  await page.keyboard.type(username);
  await page.keyboard.press('Tab');
  await expect(
    page.getByLabel(tr(lang, 'auth.login.password'), exact),
  ).toBeFocused();
  await page.keyboard.type(password);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('session-name')).toBeVisible();
}

export function searchBox(page: Page, lang: Lang = 'id') {
  return page.getByRole('combobox', {
    name: tr(lang, 'workspace.search.label'),
  });
}

/** A keyboard-wedge scanner: types into whatever has focus, then Enter. */
export async function scan(page: Page, code: string): Promise<void> {
  await page.keyboard.type(code);
  await page.keyboard.press('Enter');
}

/** Presses Tab until the element is focused (keyboard-only navigation). */
export async function tabTo(
  page: Page,
  target: ReturnType<Page['getByRole']>,
  limit = 40,
): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}
