import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { tr, type Lang } from './helpers/i18n';
import { clickMenuItem } from './helpers/app-probe';
import { launchApp, type LaunchedApp } from './helpers/launch';

/**
 * Task 9: the keyboard-first cashier workspace. Data is seeded through the
 * preload bridge as ADMIN (the same pattern as catalog/inventory specs), then
 * the cashier signs in through the UI.
 */

const ADMIN_PASSWORD = 'correct-horse-battery';
const CASHIER_PASSWORD = 'siti-password-1';
const BARCODE = '8991234567890';
const INACTIVE_BARCODE = '8990000000001';
const INACTIVE_ITEM_BARCODE = '8990000000002';
const NO_PRICE_BARCODE = '8990000000003';
const exact = { exact: true } as const;
const t = (key: string, lang: Lang = 'id') => tr(lang, key);

let launched: LaunchedApp | undefined;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-cashier-'));
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

async function seed(page: Page): Promise<void> {
  await page.evaluate(
    async ({ adminPassword, cashierPassword, codes }) => {
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
          preferences: { language: 'id', appearance: 'LIGHT' },
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
      const serviceUnit = units.find((u) => u.code === 'SERVICE')!;
      const bengkel = channels.find((c) => c.code === 'BENGKEL')!;

      async function item(
        title: string,
        type: 'STOCK_ITEM' | 'SERVICE',
        barcode: string | null,
        price: string | null,
      ) {
        const saved = must(
          await b.catalog.save({
            type,
            title,
            unitId: type === 'SERVICE' ? serviceUnit.id : pcs.id,
          }),
          `item ${title}`,
        );
        if (barcode) {
          must(
            await b.catalog.saveBarcodes({
              catalogItemId: saved.id,
              barcodes: [{ barcode, isActive: true }],
            }),
            `barcode ${title}`,
          );
        }
        if (price) {
          const preview = must(
            await b.catalog.previewPriceChange({
              catalogItemId: saved.id,
              channelId: bengkel.id,
              effectiveStartAt: '2024-01-01T00:00:00.000Z',
              price,
            }),
            `preview ${title}`,
          );
          must(
            await b.catalog.applyPriceChange({ token: preview.token }),
            `price ${title}`,
          );
        }
        return saved;
      }

      await item('Oli MPX2 0.8L', 'STOCK_ITEM', codes.barcode, '65000');
      await item('Jasa Servis Ringan', 'SERVICE', null, '50000');
      const pads = await item(
        'Kampas Rem',
        'STOCK_ITEM',
        codes.inactiveBarcode,
        '40000',
      );
      must(
        await b.catalog.saveBarcodes({
          catalogItemId: pads.id,
          barcodes: [{ barcode: codes.inactiveBarcode, isActive: false }],
        }),
        'deactivate barcode',
      );
      const old = await item(
        'Busi Lama',
        'STOCK_ITEM',
        codes.inactiveItemBarcode,
        '20000',
      );
      must(
        await b.catalog.save({
          id: old.id,
          type: 'STOCK_ITEM',
          title: 'Busi Lama',
          unitId: pcs.id,
          isActive: false,
        }),
        'deactivate item',
      );
      await item('Filter Udara', 'STOCK_ITEM', codes.noPriceBarcode, null);
      must(await b.auth.logout(), 'logout');
    },
    {
      adminPassword: ADMIN_PASSWORD,
      cashierPassword: CASHIER_PASSWORD,
      codes: {
        barcode: BARCODE,
        inactiveBarcode: INACTIVE_BARCODE,
        inactiveItemBarcode: INACTIVE_ITEM_BARCODE,
        noPriceBarcode: NO_PRICE_BARCODE,
      },
    },
  );
  await page.reload();
}

async function login(
  page: Page,
  username = 'siti',
  password = CASHIER_PASSWORD,
  lang: Lang = 'id',
): Promise<void> {
  await page.getByLabel(t('auth.login.username', lang), exact).fill(username);
  await page.getByLabel(t('auth.login.password', lang), exact).fill(password);
  await page
    .getByRole('button', { name: t('auth.login.submit', lang), ...exact })
    .click();
  await expect(page.getByTestId('session-name')).toBeVisible();
}

function searchBox(page: Page, lang: Lang = 'id') {
  return page.getByRole('combobox', {
    name: t('workspace.search.label', lang),
  });
}

/** A keyboard-wedge scanner: types into whatever has focus, then Enter. */
function scanner(page: Page) {
  return async function scan(code: string): Promise<void> {
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
  };
}

async function choosePreference(
  page: Page,
  key: string,
  value: string,
  lang: Lang,
) {
  const option = page.getByRole('radio', {
    name: t(`shell.preferences.${key}.${value}`, lang),
  });
  const menu = page.locator('details.relative > div.absolute');
  if (!(await menu.isVisible())) await page.getByTestId('session-name').click();
  if (!(await option.isVisible())) {
    const section = key === 'languages' ? 'language' : 'appearance';
    await page
      .locator('summary')
      .filter({ hasText: t(`shell.preferences.${section}`, lang) })
      .click();
  }
  await option.locator('..').click();
}

async function startAsCashier(args: string[] = []): Promise<Page> {
  launched = await launchApp({ dataDir, args });
  const { page } = launched;
  await seed(page);
  await login(page);
  await expect(searchBox(page)).toBeFocused();
  await expect(page.getByTestId('save-state')).toHaveAttribute(
    'data-state',
    'saved',
  );
  return page;
}

async function openEditor(page: Page, index: number) {
  const row = page.getByTestId('line-row').nth(index);
  return row.or(row.locator('xpath=following-sibling::tr[1]'));
}

test('scanning adds, merges, keeps focus in search, and override/discount lines stay separate', async () => {
  const page = await startAsCashier();
  const scan = scanner(page);

  await scan('8991234567890');
  await scan('8991234567890');
  await expect(page.getByTestId('line-quantity')).toHaveValue('2');
  await expect(
    page.getByRole('combobox', { name: 'Cari barang' }),
  ).toBeFocused();
  await expect(page.getByTestId('line-row')).toHaveCount(1);
  await expect(page.getByTestId('line-amount')).toHaveText('Rp 130.000');
  await expect(page.getByTestId('total-amount')).toHaveText('Rp 130.000');
  await expect(page.getByTestId('save-state')).toHaveAttribute(
    'data-state',
    'saved',
  );
  await expect(searchBox(page)).toHaveValue('');

  // Manual override on the line: the next scan becomes a separate line.
  let dialog = await openEditor(page, 0);
  await dialog.getByLabel(t('workspace.editor.unitPrice')).fill('60000');
  await searchBox(page).click();
  await expect(searchBox(page)).toBeFocused();
  await page
    .getByTestId('line-row')
    .nth(0)
    .getByRole('button', {
      name: new RegExp(`^${t('workspace.lines.details')}`),
    })
    .click();
  await expect(
    page.getByTestId('indicator-override').locator('..'),
  ).toContainText(t('workspace.indicators.override'));
  await searchBox(page).focus();
  await scan(BARCODE);
  await expect(page.getByTestId('line-row')).toHaveCount(2);
  await expect(page.getByTestId('line-quantity').nth(0)).toHaveValue('2');
  await expect(page.getByTestId('line-quantity').nth(1)).toHaveValue('1');

  // A line discount also keeps the line separate.
  dialog = await openEditor(page, 1);
  await dialog.getByLabel(t('workspace.editor.discount1')).fill('10');
  await searchBox(page).click();
  await expect(
    page
      .getByTestId('line-row')
      .nth(1)
      .getByLabel(t('workspace.editor.discount1')),
  ).toHaveValue('10');
  await scan(BARCODE);
  await expect(page.getByTestId('line-row')).toHaveCount(3);
  await expect(page.getByTestId('line-quantity').nth(2)).toHaveValue('1');
  // 2 x 60.000 + (65.000 - 10%) + 65.000
  await expect(page.getByTestId('total-amount')).toHaveText('Rp 243.500');

  // Search by name: arrow keys + Enter pick a result.
  await page.keyboard.type('servis');
  const results = page.getByRole('listbox', {
    name: t('workspace.search.results'),
  });
  await expect(results.getByRole('option').first()).toContainText(
    'Jasa Servis Ringan',
  );
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('line-row')).toHaveCount(4);
  await expect(page.getByTestId('line-row').nth(3)).toContainText(
    'Jasa Servis Ringan',
  );
  await expect(searchBox(page)).toBeFocused();
  await expect(searchBox(page)).toHaveValue('');

  // Saving -> Saved: free text is debounced until acknowledged.
  await page.getByLabel(t('workspace.header.odometer'), exact).fill('12500');
  await expect(page.getByTestId('save-state')).toHaveAttribute(
    'data-state',
    'saving',
  );
  await expect(page.getByTestId('save-state')).toHaveText(
    t('workspace.save.saving'),
  );
  await expect(page.getByTestId('save-state')).toHaveAttribute(
    'data-state',
    'saved',
  );
  await expect(page.getByTestId('save-state')).toHaveText(
    t('workspace.save.saved'),
  );
});

test('unknown and inactive barcodes give inline feedback; a missing price asks for a manual price', async () => {
  const page = await startAsCashier();
  const scan = scanner(page);
  const feedback = page.getByTestId('scan-feedback');

  await scan('0000000000000');
  await expect(feedback).toContainText(t('errors.UNKNOWN_BARCODE'));
  await expect(feedback).toContainText('0000000000000');
  await expect(page.getByTestId('line-row')).toHaveCount(0);
  await expect(searchBox(page)).toBeFocused();

  await scan(INACTIVE_BARCODE);
  await expect(feedback).toContainText(t('errors.BARCODE_INACTIVE'));
  await scan(INACTIVE_ITEM_BARCODE);
  await expect(feedback).toContainText(t('errors.CATALOG_ITEM_INACTIVE'));
  await expect(page.getByTestId('line-row')).toHaveCount(0);

  // No configured price: manual entry, then the line is added.
  await scan(NO_PRICE_BARCODE);
  const price = page
    .getByTestId('line-row')
    .last()
    .getByLabel(t('workspace.editor.unitPrice'));
  await expect(price).toBeFocused();
  await price.fill('15000');
  await price.press('Tab');
  await expect(page.getByTestId('line-row')).toHaveCount(1);
  await expect(page.getByTestId('line-row')).toContainText('Filter Udara');
  await page
    .getByTestId('line-row')
    .nth(0)
    .getByRole('button', {
      name: new RegExp(`^${t('workspace.lines.details')}`),
    })
    .click();
  await expect(page.getByTestId('indicator-missing-price')).toBeVisible();
  await searchBox(page).focus();
  await expect(searchBox(page)).toBeFocused();
  await expect(feedback).toHaveCount(0);

  // A highlighted search result is never picked by a scan's Enter.
  const results = page.getByRole('listbox', {
    name: t('workspace.search.results'),
  });
  await page.keyboard.type('servis');
  await expect(results.getByRole('option').first()).toContainText(
    'Jasa Servis Ringan',
  );
  await page.keyboard.press('ArrowDown');
  await expect(results.getByRole('option').first()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
  );
  await searchBox(page).focus();
  await scan(BARCODE);
  await expect(page.getByTestId('line-row')).toHaveCount(2);
  await expect(page.getByTestId('line-row').nth(1)).toContainText(
    'Oli MPX2 0.8L',
  );

  // Non-barcode text offers the results; the next scan still adds its item.
  await scan('servis');
  await expect(results.getByRole('option').first()).toContainText(
    'Jasa Servis Ringan',
  );
  await expect(searchBox(page)).toHaveValue('');
  await scan(BARCODE);
  await expect(page.getByTestId('line-quantity').nth(1)).toHaveValue('2');
  await expect(page.getByTestId('line-row')).toHaveCount(2);
  await expect(
    page.getByTestId('line-title').filter({ hasText: 'Jasa Servis Ringan' }),
  ).toHaveCount(0);
});

test('customer and vehicle dropdowns keep keyboard actions visible while scrolling', async () => {
  const page = await startAsCashier();
  await page.setViewportSize({ width: 390, height: 560 });
  await page.evaluate(async () => {
    for (let i = 0; i < 24; i++) {
      const result = await window.bengkelin.customers.save({
        name: `Customer ${i + 1}`,
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const vehicle = await window.bengkelin.vehicles.save({
        plateNumber: 'TST' + String(i + 1).padStart(4, '0'),
      });
      if (!vehicle.ok) throw new Error(JSON.stringify(vehicle.error));
    }
  });
  for (const mode of ['customer', 'vehicle'] as const) {
    const input = page.getByRole('combobox', {
      name: t(
        mode === 'customer'
          ? 'workspace.header.customer'
          : 'workspace.header.vehicleNumber',
      ),
      exact: true,
    });
    await input.click();
    if (mode === 'vehicle') await input.fill('TST');
    const results = page.getByRole('listbox', {
      name: t(
        mode === 'customer'
          ? 'workspace.header.customer'
          : 'workspace.header.vehicleNumber',
      ),
      exact: true,
    });
    await expect(results.getByRole('option').first()).toBeVisible();
    await input.press('ArrowUp');
    const last = results.getByRole('option').last();
    await expect(last).toBeInViewport();
    await input.press('Escape');
  }
});

test('short dialogs and custom entry fit a narrow screen', async () => {
  const page = await startAsCashier();
  await clickMenuItem(launched!.app, 'about');
  const about = page.getByRole('dialog', { name: t('shell.about.title') });
  await expect(about.getByTestId('about-version')).toBeVisible();
  expect((await about.boundingBox())!.height).toBeLessThan(350);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 560 });
  await searchBox(page).click();
  await page
    .getByRole('option', { name: t('workspace.custom.open'), ...exact })
    .click();
  const entry = page.getByRole('dialog', { name: t('workspace.custom.title') });
  await expect(page.getByRole('dialog')).toHaveCount(1);
  const cancel = entry
    .locator('.dialog-scroll-area + div')
    .getByRole('button', {
      name: t('workspace.common.cancel'),
      ...exact,
    });
  await expect(cancel).toBeInViewport();
  await cancel.click();
  await expect(searchBox(page)).toBeFocused();
});

test('draft table scrolls without content padding while its footer stays visible', async () => {
  const page = await startAsCashier();
  await page.setViewportSize({ width: 1120, height: 800 });
  await page.evaluate(async () => {
    const b = window.bengkelin;
    const channels = await b.references.listActive({ entity: 'channel' });
    if (!channels.ok) throw new Error(JSON.stringify(channels.error));
    for (let i = 0; i < 24; i++) {
      const draft = await b.drafts.create({
        requestId: crypto.randomUUID(),
        channelId: channels.value[0]!.id,
        invoiceDate: '2026-10-17',
        pricingAt: new Date().toISOString(),
      });
      if (!draft.ok) throw new Error(JSON.stringify(draft.error));
    }
  });
  await page
    .getByRole('button', { name: t('workspace.drafts.open'), ...exact })
    .click();
  const dialog = page.getByRole('dialog', {
    name: t('workspace.drafts.title'),
  });
  await expect(dialog.getByTestId('draft-row')).toHaveCount(25);
  const body = dialog.locator('.dialog-scroll-area');
  expect(
    await body.evaluate((el) => [
      getComputedStyle(el).paddingTop,
      getComputedStyle(el).paddingBottom,
    ]),
  ).toEqual(['0px', '0px']);
  const tableScroller = dialog.locator('.overflow-auto');
  await tableScroller.hover();
  await page.mouse.wheel(0, 400);
  await expect
    .poll(() => tableScroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(
    dialog.getByRole('heading', { name: t('workspace.drafts.title') }),
  ).toBeInViewport();
  await expect(
    dialog
      .getByRole('button', { name: t('workspace.common.close'), ...exact })
      .filter({ hasText: t('workspace.common.close') }),
  ).toBeInViewport();
});

test('cashier language and appearance persist without changing the admin preferences', async () => {
  const page = await startAsCashier();
  await page.getByTestId('session-name').click();
  const language = (value: 'id' | 'en', lang: Lang = 'id') =>
    page.getByRole('radio', {
      name: t(`shell.preferences.languages.${value}`, lang),
    });
  const appearance = (value: 'LIGHT' | 'DARK' | 'SYSTEM', lang: Lang = 'id') =>
    page.getByRole('radio', {
      name: t(`shell.preferences.appearances.${value}`, lang),
    });
  await page
    .locator('summary')
    .filter({ hasText: t('shell.preferences.language') })
    .click();
  await expect(language('id')).toBeChecked();
  await page
    .locator('summary')
    .filter({ hasText: t('shell.preferences.appearance') })
    .click();
  await expect(appearance('LIGHT')).toBeChecked();
  await language('en').locator('..').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await appearance('DARK', 'en').locator('..').click();
  await expect(page.locator('html')).toHaveClass(/dark/);

  await page.getByRole('button', { name: /Sign out|Keluar/ }).click();
  await login(page, 'siti', CASHIER_PASSWORD);
  await page.getByTestId('session-name').click();
  await page
    .locator('summary')
    .filter({ hasText: t('shell.preferences.language', 'en') })
    .click();
  await expect(language('en', 'en')).toBeChecked();
  await page
    .locator('summary')
    .filter({ hasText: t('shell.preferences.appearance', 'en') })
    .click();
  await expect(appearance('DARK', 'en')).toBeChecked();
  await page.getByRole('button', { name: /Sign out|Keluar/ }).click();
  await login(page, 'admin', ADMIN_PASSWORD);
  await page.getByTestId('session-name').click();
  await page
    .locator('summary')
    .filter({ hasText: t('shell.preferences.language') })
    .click();
  await expect(language('id')).toBeChecked();
  await page
    .locator('summary')
    .filter({ hasText: t('shell.preferences.appearance') })
    .click();
  await expect(appearance('LIGHT')).toBeChecked();
});

test('shell title stays sticky and navigation scrolls horizontally in one row', async () => {
  const page = await startAsCashier();
  await page.setViewportSize({ width: 390, height: 560 });
  const sticky = page.locator('div.sticky.top-0');
  const nav = page.getByRole('navigation', { name: t('shell.nav.label') });
  await expect(nav).toBeVisible();
  const layout = await nav.evaluate((el) => {
    const links = [...el.querySelectorAll('button')].map((item) =>
      item.getBoundingClientRect(),
    );
    return {
      overflow: el.scrollWidth > el.clientWidth,
      oneRow: links.every((rect) => rect.y === links[0]?.y),
    };
  });
  expect(layout).toEqual({ overflow: true, oneRow: true });
  await page.getByTestId('session-name').click();
  const menu = page.locator('details.relative > div.absolute');
  await expect
    .poll(() => menu.evaluate((el) => el.getBoundingClientRect().width))
    .toBeGreaterThanOrEqual(256);
  await menu.locator('..').evaluate((el) => {
    (el as HTMLElement).style.width = '360px';
  });
  await expect
    .poll(() => menu.evaluate((el) => el.getBoundingClientRect().width))
    .toBeGreaterThanOrEqual(360);
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.fonts.check('16px "Plus Jakarta Sans Variable"'),
      ),
    )
    .toBe(true);
  await nav.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect.poll(() => nav.evaluate((el) => el.scrollLeft > 0)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect
    .poll(() =>
      sticky.evaluate((el) => Math.round(el.getBoundingClientRect().top)),
    )
    .toBe(0);
});

test('keyboard inline editing saves on Tab; Escape cancels; digits outside search never scan', async () => {
  const page = await startAsCashier();
  await scanner(page)(BARCODE);
  const row = page.getByTestId('line-row');
  const qty = row.getByLabel(t('workspace.editor.quantity'));
  await qty.focus();
  await qty.fill('3');
  await page.keyboard.press('Escape');
  await expect(qty).toHaveValue('1');
  const discount = row.getByLabel(t('workspace.editor.discount1'));
  await discount.focus();
  await page.keyboard.type('12,5');
  await page.keyboard.press('Tab');
  await expect(row.getByTestId('line-amount')).toHaveText('Rp 56.875');
  const note = page.getByRole('textbox', {
    name: t('workspace.header.note'),
    ...exact,
  });
  await note.fill(BARCODE);
  await note.press('Enter');
  await page.getByLabel(t('workspace.header.odometer'), exact).fill('12345');
  await expect(page.getByTestId('save-state')).toHaveAttribute(
    'data-state',
    'saved',
  );
  await expect(page.getByTestId('line-row')).toHaveCount(1);
});

test('drafts survive an app restart and can be switched, created and discarded', async () => {
  const page = await startAsCashier();
  const scan = scanner(page);
  await scan(BARCODE);
  await scan(BARCODE);
  await page.getByLabel(t('workspace.header.odometer'), exact).fill('15200');
  await page
    .getByRole('textbox', { name: t('workspace.header.note'), ...exact })
    .fill('Rem bunyi');
  // Close immediately: the before-close handshake flushes the debounced text.
  await launched!.close();

  launched = await launchApp({ dataDir });
  const next = launched.page;
  await login(next);
  await expect(next.getByTestId('line-quantity')).toHaveValue('2');
  await expect(next.getByTestId('line-row')).toContainText('Oli MPX2 0.8L');
  await expect(
    next.getByLabel(t('workspace.header.odometer'), exact),
  ).toHaveValue('15.200');
  await expect(
    next.getByRole('textbox', { name: t('workspace.header.note'), ...exact }),
  ).toHaveValue('Rem bunyi');
  await next.keyboard.press('Escape');
  await expect(next.getByTestId('header-customer')).toHaveValue(
    t('workspace.header.anonymous'),
  );

  // A new transaction is a second draft; the switcher lists both.
  await next
    .getByRole('button', { name: t('workspace.drafts.new'), ...exact })
    .click();
  await expect(next.getByTestId('line-row')).toHaveCount(0);
  await expect(searchBox(next)).toBeFocused();
  await scanner(next)(BARCODE);
  await expect(next.getByTestId('line-row')).toHaveCount(1);

  await next
    .getByRole('button', { name: t('workspace.drafts.open'), ...exact })
    .click();
  const switcher = next.getByRole('dialog', {
    name: t('workspace.drafts.title'),
  });
  await expect(switcher.getByTestId('draft-row')).toHaveCount(2);
  await expect(switcher.getByTestId('draft-row').first()).toContainText('Siti');
  await expect(switcher.getByTestId('draft-row').first()).toContainText(
    'Rp 65.000',
  );
  await switcher
    .getByTestId('draft-row')
    .nth(1)
    .getByRole('button', {
      name: `${t('workspace.drafts.resume')}: ${t('workspace.header.anonymous')}`,
      ...exact,
    })
    .click();
  await expect(switcher).toHaveCount(0);
  await expect(next.getByTestId('line-quantity')).toHaveValue('2');

  // Discard the other (newer) draft, with confirmation; the open one stays.
  await next
    .getByRole('button', { name: t('workspace.drafts.open'), ...exact })
    .click();
  await switcher
    .getByTestId('draft-row')
    .first()
    .getByRole('button', {
      name: `${t('workspace.drafts.discard')}: ${t('workspace.header.anonymous')}`,
      ...exact,
    })
    .click();
  const confirm = next.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await confirm
    .getByRole('button', {
      name: t('workspace.drafts.confirmDiscard'),
      ...exact,
    })
    .click();
  await expect(switcher.getByTestId('draft-row')).toHaveCount(1);
  await next.keyboard.press('Escape');
  await expect(switcher).toHaveCount(0);
  await expect(next.getByTestId('line-quantity')).toHaveValue('2');
});

test('custom service line with mechanic, checkout allocations and the review step', async () => {
  const page = await startAsCashier();
  const scan = scanner(page);
  await scan(BARCODE);

  await searchBox(page).click();
  await page
    .getByRole('option', { name: t('workspace.custom.open'), ...exact })
    .click();
  const custom = page.getByRole('dialog', {
    name: t('workspace.custom.title'),
  });
  await custom
    .getByLabel(t('workspace.custom.type'), exact)
    .selectOption('SERVICE');
  await custom
    .getByRole('combobox', { name: t('workspace.custom.itemTitle') })
    .fill('Jasa las bracket');
  await custom.getByLabel(t('workspace.custom.price'), exact).fill('35000');
  await custom
    .getByLabel(t('workspace.custom.mechanic'), exact)
    .selectOption({ label: 'Andi' });
  await custom
    .getByRole('button', { name: t('workspace.custom.add'), ...exact })
    .click();
  await expect(custom).toHaveCount(0);
  await expect(page.getByTestId('line-row')).toHaveCount(2);
  const serviceRow = page.getByTestId('line-row').nth(1);
  await expect(
    serviceRow.getByRole('textbox', {
      name: `${t('workspace.editor.itemTitle')}: Jasa las bracket`,
    }),
  ).toHaveValue('Jasa las bracket');
  await openEditor(page, 1);
  await expect(page.getByTestId('indicator-mechanic')).toContainText('Andi');
  await expect(page.getByTestId('total-amount')).toHaveText('Rp 100.000');

  // Invoice discount 10% (sequential stages come from the view).
  await page
    .getByLabel(t('workspace.checkout.singleDiscount'), exact)
    .fill('10');
  await page
    .getByLabel(t('workspace.checkout.singleDiscount'), exact)
    .press('Enter');
  await expect(page.getByTestId('total-amount')).toHaveText('Rp 90.000');
  await expect(page.getByTestId('invoice-discount-amount')).toHaveText(
    'Rp 10.000',
  );

  await page
    .getByRole('button', { name: t('workspace.checkout.payments'), ...exact })
    .click();
  const payments = page.getByRole('dialog', {
    name: t('workspace.checkout.payments'),
    ...exact,
  });
  await payments
    .getByLabel(`${t('workspace.checkout.amount')} 1`, exact)
    .fill('100000');
  await payments
    .getByRole('button', { name: t('workspace.checkout.apply'), ...exact })
    .click();
  await expect(payments).toHaveCount(0);
  await expect(page.getByTestId('cash-change')).toHaveText('Rp 10.000');

  await page
    .getByRole('button', { name: t('workspace.checkout.review'), ...exact })
    .click();
  const review = page.getByRole('dialog', {
    name: t('workspace.review.title'),
  });
  await expect(review).toBeVisible();
  await expect(review.getByTestId('review-total')).toHaveText('Rp 90.000');
  // No opening stock was recorded: finalization would make it negative, so
  // Finalize needs an explicit acknowledgement (T10).
  const finalizeButton = review.getByRole('button', {
    name: t('workspace.review.finalize'),
    ...exact,
  });
  await expect(review.getByTestId('negative-stock-warning')).toBeVisible();
  await expect(finalizeButton).toBeDisabled();
  await review.getByLabel(t('workspace.finalize.acknowledgeNegative')).check();
  await expect(finalizeButton).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(review).toHaveCount(0);
});

test('language and theme switch; 1024x768, 1366x768 and 200% zoom keep key controls usable', async () => {
  launched = await launchApp({ dataDir });
  const { page, app } = launched;
  await seed(page);
  await login(page, 'admin', ADMIN_PASSWORD);
  await expect(searchBox(page)).toBeFocused();

  async function resize(width: number, height: number) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        win.setMinimumSize(320, 240);
        win.setContentSize(size.width, size.height);
      },
      { width, height },
    );
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  }
  async function zoom(factor: number) {
    await app.evaluate(({ BrowserWindow }, value) => {
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(value);
    }, factor);
    await page.waitForTimeout(300);
  }
  async function keyControlsUsable(lang: Lang) {
    for (const locator of [
      searchBox(page, lang),
      page.getByTestId('total-amount'),
      page.getByRole('button', {
        name: t('workspace.checkout.review', lang),
        ...exact,
      }),
      page.getByTestId('save-state'),
    ]) {
      await locator.scrollIntoViewIfNeeded();
      await expect(locator).toBeInViewport();
    }
    // No horizontal page scroll (the lines table may scroll inside itself),
    // and no content spilling out of its box (clipped/overlapping controls).
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      const offenders = [...document.querySelectorAll('body *')]
        .filter((el) => !el.parentElement?.closest('.overflow-x-auto'))
        .filter((el) => {
          const style = getComputedStyle(el);
          if (style.overflowX !== 'visible' || style.display === 'inline')
            return false;
          if (el.closest('.sr-only')) return false;
          return (
            el.getBoundingClientRect().right > root.clientWidth + 1 ||
            el.scrollWidth > el.clientWidth + 1
          );
        })
        .slice(0, 3)
        .map((el) => `${el.tagName} ${el.textContent?.slice(0, 40)}`);
      return { extra: root.scrollWidth - root.clientWidth, offenders };
    });
    expect(overflow).toEqual({ extra: 0, offenders: [] });
  }

  await resize(1024, 768);
  await scanner(page)(BARCODE);
  await expect(page.getByTestId('line-row')).toHaveCount(1);
  await keyControlsUsable('id');
  await resize(1366, 768);
  await keyControlsUsable('id');

  // Language: English everywhere, persisted as the shop preference.
  await choosePreference(page, 'languages', 'en', 'id');
  await expect(searchBox(page, 'en')).toBeVisible();
  await expect(page.getByTestId('save-state')).toHaveText(
    t('workspace.save.saved', 'en'),
  );
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // Theme: dark, then light.
  await choosePreference(page, 'appearances', 'DARK', 'en');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await choosePreference(page, 'appearances', 'LIGHT', 'en');
  await expect(page.locator('html')).not.toHaveClass(/dark/);

  // 200% zoom at 1024x768.
  await resize(1024, 768);
  await zoom(2);
  await keyControlsUsable('en');
  await searchBox(page, 'en').focus();
  await scanner(page)(BARCODE);
  await expect(page.getByTestId('line-quantity')).toHaveValue('2');
});

for (const viewport of [
  { width: 1800, height: 1040 },
  { width: 390, height: 560 },
]) {
  for (const lang of ['id', 'en'] as const) {
    for (const appearance of ['light', 'dark'] as const) {
      test(`creation dialogs: ${viewport.width} ${lang} ${appearance}`, async () => {
        const testInfo = test.info();
        test.setTimeout(120_000);
        const page = await startAsCashier(['--force-device-scale-factor=1']);
        await page.setViewportSize(viewport);
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
        if (lang === 'en')
          await choosePreference(page, 'languages', 'en', 'id');
        if (appearance === 'dark')
          await choosePreference(page, 'appearances', 'DARK', lang);
        await page.keyboard.press('Escape');
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const capture = async (name: string) => {
          await page.evaluate(() => document.fonts.ready);
          const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
          await page.screenshot({
            path: testInfo.outputPath(`${stamp}-${name}.png`),
          });
        };
        const open = async (mode: 'custom' | 'customer' | 'vehicle') => {
          const input =
            mode === 'custom'
              ? searchBox(page, lang)
              : page.getByTestId(`header-${mode}`);
          await input.click();
          await page
            .getByRole('option', {
              name: t(
                mode === 'custom'
                  ? 'workspace.custom.open'
                  : mode === 'customer'
                    ? 'workspace.party.createCustomer'
                    : 'workspace.party.createVehicle',
                lang,
              ),
              ...exact,
            })
            .click();
          return { input, dialog: page.getByRole('dialog') };
        };
        const layout = async () => {
          const dialog = page.getByRole('dialog');
          await expect(dialog).toHaveCount(1);
          await expect(dialog.getByRole('heading')).toHaveCount(1);
          await expect(dialog.locator('.shadow-sm')).toHaveCount(0);
          const footer = dialog.locator('.dialog-scroll-area + div');
          for (const button of await footer.getByRole('button').all())
            await expect(button).toBeInViewport({ ratio: 1 });
          expect(
            await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
          const body = dialog.locator('.dialog-scroll-area');
          expect(
            await body.evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
          const headerBefore = await dialog.getByRole('heading').boundingBox();
          const footerBefore = await footer.boundingBox();
          await body.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          await expect(dialog.getByRole('heading')).toBeInViewport({
            ratio: 1,
          });
          expect(await dialog.getByRole('heading').boundingBox()).toEqual(
            headerBefore,
          );
          expect(await footer.boundingBox()).toEqual(footerBefore);
          return body;
        };
        for (const mode of ['custom', 'customer', 'vehicle'] as const) {
          for (const dismissal of ['cancel', 'corner', 'escape'] as const) {
            const { input, dialog } = await open(mode);
            await layout();
            if (dismissal === 'cancel') {
              await dialog.locator('.dialog-scroll-area').evaluate((el) => {
                el.scrollTop = 0;
              });
              await capture(`${mode}-initial`);
              await dialog
                .locator('.dialog-scroll-area + div')
                .getByRole('button', {
                  name: t('workspace.common.cancel', lang),
                  ...exact,
                })
                .click();
            } else if (dismissal === 'corner')
              await dialog
                .getByRole('button', {
                  name: t('workspace.common.close', lang),
                  ...exact,
                })
                .click();
            else await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);
            await expect(input).toBeFocused();
          }
          const { input, dialog } = await open(mode);
          const submit = dialog
            .locator('.dialog-scroll-area + div')
            .getByRole('button')
            .last();
          await submit.click();
          if (mode === 'customer')
            await expect(dialog.getByRole('alert')).toBeVisible();
          else
            await expect(
              dialog.locator('[aria-invalid="true"]').first(),
            ).toBeVisible();
          await layout();
          await dialog.locator('.dialog-scroll-area').evaluate((el) => {
            el.scrollTop = 0;
          });
          await capture(`${mode}-validation`);
          if (mode === 'custom') {
            await dialog
              .getByLabel(t('workspace.custom.itemTitle', lang), exact)
              .fill('Dialog service');
            await dialog
              .getByLabel(t('workspace.custom.price', lang), exact)
              .fill('5000');
          } else if (mode === 'customer')
            await dialog
              .getByLabel(t('customers.quickCustomer.name', lang), exact)
              .fill('Dialog Customer');
          else
            await dialog
              .getByLabel(t('customers.quickVehicle.plate', lang), exact)
              .fill('B 1234 XY');
          await submit.click();
          await expect(dialog).toHaveCount(0);
          await expect(input).toBeFocused();
        }
        // Saved custom references feed the existing autocomplete through the real bridge.
        {
          const { dialog, input } = await open('custom');
          const title = dialog.getByLabel(
            t('workspace.custom.itemTitle', lang),
            exact,
          );
          await title.fill('Dialog service');
          await expect(
            dialog.getByRole('option', { name: /Dialog service/ }),
          ).toBeVisible();
          await title.press('Escape');
          await expect(dialog.getByRole('listbox')).toBeHidden();
          await expect(dialog).toBeVisible();
          await title.press('Escape');
          await expect(dialog).toHaveCount(0);
          await expect(input).toBeFocused();
        }
        // Long duplicate review makes body scrolling necessary at both sizes.
        await page.evaluate(async () => {
          for (let index = 0; index < 20; index++) {
            const result = await window.bengkelin.customers.save({
              name: `Duplicate ${index}`,
              phoneNumber: '08123456789',
              acknowledgeDuplicates: true,
            });
            if (!result.ok) throw new Error(JSON.stringify(result.error));
          }
        });
        {
          const { dialog } = await open('customer');
          await dialog
            .getByLabel(t('customers.quickCustomer.phone', lang), exact)
            .fill('08123456789');
          await dialog
            .getByRole('button', {
              name: t('customers.quickCustomer.submit', lang),
              ...exact,
            })
            .click();
          await expect(dialog.getByRole('group')).toBeVisible();
          const body = await layout();
          expect(
            await body.evaluate(
              (el) => el.scrollHeight > el.clientHeight && el.scrollTop > 0,
            ),
          ).toBe(true);
          await capture('customer-duplicate-scrolled');
          await dialog
            .locator('.dialog-scroll-area + div')
            .getByRole('button', {
              name: t('customers.duplicate.acknowledge', lang),
              ...exact,
            })
            .click();
          await expect(dialog).toHaveCount(0);
        }
        {
          const { dialog } = await open('vehicle');
          await dialog
            .getByLabel(t('customers.quickVehicle.plate', lang), exact)
            .fill('B 1234 XY');
          await dialog
            .getByRole('button', {
              name: t('customers.quickVehicle.submit', lang),
              ...exact,
            })
            .click();
          await expect(dialog.getByRole('group')).toBeVisible();
          await layout();
          await capture('vehicle-reuse');
          await dialog
            .locator('.dialog-scroll-area + div')
            .getByRole('button', {
              name: t('customers.plateExists.use', lang),
              ...exact,
            })
            .click();
          await expect(dialog).toHaveCount(0);
        }
        await page
          .getByRole('button', {
            name: t('shell.nav.customers', lang),
            ...exact,
          })
          .click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        const customerForm = page.getByRole('form', {
          name: t('customers.quickCustomer.title', lang),
          ...exact,
        });
        const vehicleForm = page.getByRole('form', {
          name: t('customers.quickVehicle.title', lang),
          ...exact,
        });
        await expect(customerForm.getByRole('heading')).toBeVisible();
        await expect(vehicleForm.getByRole('heading')).toBeVisible();
        expect(await customerForm.getAttribute('id')).not.toBe(
          await vehicleForm.getAttribute('id'),
        );
        await customerForm.scrollIntoViewIfNeeded();
        await capture('inline-customer');
        await vehicleForm.scrollIntoViewIfNeeded();
        await capture('inline-vehicle');
        expect(errors).toEqual([]);
      });
    }
  }
}
