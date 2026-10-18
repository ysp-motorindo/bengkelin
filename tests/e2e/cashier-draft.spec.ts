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

async function startAsCashier(): Promise<Page> {
  launched = await launchApp({ dataDir });
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
  await page
    .getByTestId('line-row')
    .nth(index)
    .getByRole('button', { name: new RegExp(`^${t('workspace.lines.edit')}`) })
    .click();
  const dialog = page.getByRole('dialog', {
    name: t('workspace.editor.title'),
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('scanning adds, merges, keeps focus in search, and override/discount lines stay separate', async () => {
  const page = await startAsCashier();
  const scan = scanner(page);

  await scan('8991234567890');
  await scan('8991234567890');
  await expect(page.getByTestId('line-quantity')).toHaveText('2');
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
  await dialog.getByLabel(t('workspace.editor.unitPrice'), exact).fill('60000');
  await dialog
    .getByLabel(t('workspace.editor.reason'), exact)
    .fill('Pelanggan tetap');
  await dialog
    .getByRole('button', { name: t('workspace.editor.save'), ...exact })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(searchBox(page)).toBeFocused();
  const firstRow = page.getByTestId('line-row').nth(0);
  await expect(firstRow.getByTestId('indicator-override')).toBeVisible();
  await scan(BARCODE);
  await expect(page.getByTestId('line-row')).toHaveCount(2);
  await expect(page.getByTestId('line-quantity').nth(0)).toHaveText('2');
  await expect(page.getByTestId('line-quantity').nth(1)).toHaveText('1');

  // A line discount also keeps the line separate.
  dialog = await openEditor(page, 1);
  await dialog.getByLabel(t('workspace.editor.discount1'), exact).fill('10');
  await dialog
    .getByRole('button', { name: t('workspace.editor.save'), ...exact })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByTestId('line-row').nth(1).getByTestId('line-discount'),
  ).toContainText('10%');
  await scan(BARCODE);
  await expect(page.getByTestId('line-row')).toHaveCount(3);
  await expect(page.getByTestId('line-quantity').nth(2)).toHaveText('1');
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
  const custom = page.getByRole('button', {
    name: t('workspace.custom.open'),
    ...exact,
  });
  const scanBox = searchBox(page);
  const aligned = async () => {
    const [scanBounds, customBounds] = await Promise.all([
      scanBox.boundingBox(),
      custom.boundingBox(),
    ]);
    expect(scanBounds).not.toBeNull();
    expect(customBounds?.y).toBe(scanBounds?.y);
    expect(customBounds?.height).toBe(scanBounds?.height);
  };
  await aligned();
  await expect(page.getByTestId('line-row')).toHaveCount(0);
  await expect(searchBox(page)).toBeFocused();

  await scan(INACTIVE_BARCODE);
  await expect(feedback).toContainText(t('errors.BARCODE_INACTIVE'));
  await scan(INACTIVE_ITEM_BARCODE);
  await expect(feedback).toContainText(t('errors.CATALOG_ITEM_INACTIVE'));
  await aligned();
  await expect(page.getByTestId('line-row')).toHaveCount(0);

  // No configured price: manual entry, then the line is added.
  await scan(NO_PRICE_BARCODE);
  const dialog = page.getByRole('dialog', {
    name: t('workspace.manualPrice.title'),
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByLabel(t('workspace.manualPrice.price'), exact),
  ).toBeFocused();
  await page.keyboard.type('15000');
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('line-row')).toHaveCount(1);
  await expect(page.getByTestId('line-row')).toContainText('Filter Udara');
  await expect(page.getByTestId('indicator-missing-price')).toBeVisible();
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
  await expect(page.getByTestId('line-quantity').nth(1)).toHaveText('2');
  await expect(page.getByTestId('line-row')).toHaveCount(2);
  await expect(
    page.getByTestId('line-title').filter({ hasText: 'Jasa Servis Ringan' }),
  ).toHaveCount(0);
});

test('Customer & Vehicle dialog keeps its title and Done action visible while content scrolls', async () => {
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
  await page
    .getByRole('button', { name: t('workspace.header.chooseParty'), ...exact })
    .click();
  const dialog = page.getByRole('dialog', { name: t('workspace.party.title') });
  const title = dialog.getByRole('heading', {
    name: t('workspace.party.title'),
  });
  const done = dialog.getByRole('button', {
    name: t('workspace.party.done'),
    ...exact,
  });
  const panes = dialog.locator('.overflow-y-auto');
  const customerPane = panes.nth(0);
  const vehiclePane = panes.nth(1);
  await expect(title).toBeInViewport();
  await expect(done).toBeInViewport();
  const customerSearch = dialog.getByPlaceholder(
    t('workspace.party.customerSearch'),
  );
  const searchTop = (await customerSearch.boundingBox())!.y;
  await expect
    .poll(() =>
      customerPane.evaluate((el) => el.scrollHeight > el.clientHeight),
    )
    .toBe(true);
  await customerPane.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(title).toBeInViewport();
  await expect(done).toBeInViewport();
  expect((await customerSearch.boundingBox())!.y).toBe(searchTop);
  await expect
    .poll(() => customerPane.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(
    customerPane.getByRole('form', {
      name: t('customers.quickCustomer.title'),
    }),
  ).toBeVisible();
  const plateSearch = dialog.getByPlaceholder(t('workspace.party.plateSearch'));
  await plateSearch.fill('TST');
  await expect(
    dialog.getByRole('button', { name: /Pilih: TST/ }).first(),
  ).toBeVisible();
  await expect
    .poll(() => vehiclePane.evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true);
  await vehiclePane.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect
    .poll(() => vehiclePane.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(
    vehiclePane.getByRole('form', { name: t('customers.quickVehicle.title') }),
  ).toBeVisible();
  await expect(title).toBeInViewport();
  await expect(done).toBeInViewport();

  // Desktop columns keep the search controls stationary while a real wheel scrolls the list.
  await page.setViewportSize({ width: 1120, height: 800 });
  await customerPane.evaluate((el) => {
    el.scrollTop = 0;
  });
  const desktopSearchTop = (await customerSearch.boundingBox())!.y;
  await customerPane.hover();
  await page.mouse.wheel(0, 300);
  await expect
    .poll(() => customerPane.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  expect((await customerSearch.boundingBox())!.y).toBe(desktopSearchTop);
  await expect(dialog.locator('.dialog-scroll-area')).toHaveAttribute(
    'data-scrolling',
    'true',
  );
  await expect(dialog.locator('.dialog-scroll-area')).toHaveAttribute(
    'data-scrolling',
    'false',
  );
  await expect(title).toBeInViewport();
  await expect(done).toBeInViewport();
});

test('dialogs fit short content and scroll long forms with fixed header and footer', async () => {
  const page = await startAsCashier();
  await page.setViewportSize({ width: 1120, height: 800 });
  await clickMenuItem(launched!.app, 'about');
  const about = page.getByRole('dialog', { name: t('shell.about.title') });
  await expect(about.getByTestId('about-version')).toBeVisible();
  // A short dialog uses its content height, rather than filling the 70vh ceiling.
  expect((await about.boundingBox())!.height).toBeLessThan(350);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 560 });
  await page
    .getByRole('button', { name: t('workspace.custom.open'), ...exact })
    .click();
  const dialog = page.getByRole('dialog', {
    name: t('workspace.custom.title'),
  });
  const body = dialog.locator('.dialog-scroll-area');
  const title = dialog.getByRole('heading', {
    name: t('workspace.custom.title'),
  });
  const submit = dialog.getByRole('button', {
    name: t('workspace.custom.add'),
    ...exact,
  });
  const cancel = dialog.getByRole('button', {
    name: t('workspace.common.cancel'),
    ...exact,
  });
  const titleTop = (await title.boundingBox())!.y;
  const submitTop = (await submit.boundingBox())!.y;
  expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(393);
  expect(
    (await cancel.boundingBox())!.x + (await cancel.boundingBox())!.width,
  ).toBeLessThan((await submit.boundingBox())!.x);
  await expect
    .poll(() => body.evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true);
  await body.hover();
  await page.mouse.wheel(0, 300);
  await expect
    .poll(() => body.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(body).toHaveAttribute('data-scrolling', 'true');
  await expect
    .poll(() => body.evaluate((el) => getComputedStyle(el).scrollbarColor))
    .not.toBe('rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');
  expect((await title.boundingBox())!.y).toBe(titleTop);
  expect((await submit.boundingBox())!.y).toBe(submitTop);
  await expect(body).toHaveAttribute('data-scrolling', 'false');
  await expect
    .poll(() => body.evaluate((el) => getComputedStyle(el).scrollbarColor))
    .toBe('rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');
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

test('keyboard only: add, edit a discount, close, focus back in search; digits in other fields are not scans', async () => {
  const page = await startAsCashier();
  const scan = scanner(page);
  await scan(BARCODE);
  await expect(page.getByTestId('line-row')).toHaveCount(1);

  // Tab to the line's edit button and open the editor with Enter.
  const editName = `${t('workspace.lines.edit')}: Oli MPX2 0.8L`;
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() =>
      document.activeElement?.getAttribute('aria-label'),
    );
    if (label === editName) break;
  }
  await expect(page.getByRole('button', { name: editName })).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: t('workspace.editor.title'),
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByLabel(t('workspace.editor.quantity'), exact),
  ).toBeFocused();

  // Focus is trapped: many Tabs never leave the dialog.
  for (let i = 0; i < 25; i += 1) await page.keyboard.press('Tab');
  expect(
    await dialog.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);

  // Reach Discount 1 with Tab, type, submit with Enter.
  const discountLabel = t('workspace.editor.discount1');
  await dialog.getByLabel(t('workspace.editor.quantity'), exact).focus();
  for (let i = 0; i < 20; i += 1) {
    const focusedLabel = await page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | null;
      return el?.labels?.[0]?.textContent ?? null;
    });
    if (focusedLabel === discountLabel) break;
    await page.keyboard.press('Tab');
  }
  await expect(dialog.getByLabel(discountLabel, exact)).toBeFocused();
  await page.keyboard.type('12,5');
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(searchBox(page)).toBeFocused();
  await expect(page.getByTestId('line-discount')).toContainText('12,5%');
  await expect(page.getByTestId('line-amount')).toHaveText('Rp 56.875');

  // Escape closes a dialog without saving and returns focus to search.
  await page.getByRole('button', { name: editName }).press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(searchBox(page)).toBeFocused();

  // Digits + Enter typed into another field are never treated as a scan.
  await page
    .getByRole('button', { name: t('workspace.header.addNote'), ...exact })
    .press('Enter');
  const note = page.getByRole('textbox', {
    name: t('workspace.header.note'),
    ...exact,
  });
  await note.focus();
  await page.keyboard.type(BARCODE);
  await page.keyboard.press('Enter');
  await page
    .getByRole('button', { name: t('workspace.header.saveNote'), ...exact })
    .press('Enter');
  const odometer = page.getByLabel(t('workspace.header.odometer'), exact);
  await odometer.focus();
  await page.keyboard.type('12345');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('save-state')).toHaveAttribute(
    'data-state',
    'saved',
  );
  await expect(page.getByTestId('line-row')).toHaveCount(1);
  await expect(page.getByTestId('line-quantity')).toHaveText('1');
});

test('drafts survive an app restart and can be switched, created and discarded', async () => {
  const page = await startAsCashier();
  const scan = scanner(page);
  await scan(BARCODE);
  await scan(BARCODE);
  await page.getByLabel(t('workspace.header.odometer'), exact).fill('15200');
  await page
    .getByRole('button', { name: t('workspace.header.addNote'), ...exact })
    .click();
  await page
    .getByRole('textbox', { name: t('workspace.header.note'), ...exact })
    .fill('Rem bunyi');
  await page
    .getByRole('button', { name: t('workspace.header.saveNote'), ...exact })
    .click();
  // Close immediately: the before-close handshake flushes the debounced text.
  await launched!.close();

  launched = await launchApp({ dataDir });
  const next = launched.page;
  await login(next);
  await expect(next.getByTestId('line-quantity')).toHaveText('2');
  await expect(next.getByTestId('line-row')).toContainText('Oli MPX2 0.8L');
  await expect(
    next.getByLabel(t('workspace.header.odometer'), exact),
  ).toHaveValue('15.200');
  await next
    .getByRole('button', { name: t('workspace.header.updateNote'), ...exact })
    .click();
  await expect(
    next.getByRole('textbox', { name: t('workspace.header.note'), ...exact }),
  ).toHaveValue('Rem bunyi');
  await next.keyboard.press('Escape');
  await expect(next.getByTestId('header-customer')).toHaveText(
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
  await expect(next.getByTestId('line-quantity')).toHaveText('2');

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
  await expect(next.getByTestId('line-quantity')).toHaveText('2');
});

test('custom service line with mechanic, checkout allocations and the review step', async () => {
  const page = await startAsCashier();
  const scan = scanner(page);
  await scan(BARCODE);

  await page
    .getByRole('button', { name: t('workspace.custom.open'), ...exact })
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
  await expect(serviceRow).toContainText('Jasa las bracket');
  await expect(serviceRow.getByTestId('indicator-mechanic')).toContainText(
    'Andi',
  );
  await expect(page.getByTestId('total-amount')).toHaveText('Rp 100.000');

  // Invoice discount 10% (sequential stages come from the view).
  await page
    .getByLabel(t('workspace.checkout.invoiceDiscount1'), exact)
    .fill('10');
  await page
    .getByLabel(t('workspace.checkout.invoiceDiscount1'), exact)
    .press('Enter');
  await expect(page.getByTestId('total-amount')).toHaveText('Rp 90.000');
  await expect(page.getByTestId('invoice-discount-amount')).toHaveText(
    'Rp 10.000',
  );

  await page
    .getByRole('button', {
      name: t('workspace.checkout.payFullCash'),
      ...exact,
    })
    .click();
  await expect(page.getByTestId('allocation-row')).toHaveCount(1);
  await expect(page.getByTestId('unallocated-amount')).toHaveText('Rp 0');

  // Tender/change is UI only.
  await page.getByLabel(t('workspace.checkout.tendered'), exact).fill('100000');
  await expect(page.getByTestId('change-amount')).toHaveText('Rp 10.000');

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
  await expect(page.getByTestId('line-quantity')).toHaveText('2');
});
