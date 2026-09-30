import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  clickMenuItem,
  menuItem,
  readMenu,
  visibleMenuIds,
} from './helpers/app-probe';
import { tr, type Lang } from './helpers/i18n';
import { launchApp, type LaunchedApp } from './helpers/launch';
import {
  ADMIN_PASSWORD,
  CASHIER_PASSWORD,
  OIL_BARCODE,
  exact,
  loginWithKeyboard,
  scan,
  searchBox,
  seedWorkshop,
} from './helpers/workflow-seed';

/**
 * Task 17 companions to the workflow: the native menu in both languages
 * (rebuilt on language change), role-aware items and main-process
 * authorization, About, Backup and Reload (with the draft flush), and the
 * completed ADMIN screens (cashiers, shop settings).
 */

let launched: LaunchedApp | undefined;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-menu-'));
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

const topLabels = async (app: LaunchedApp['app']) =>
  ((await readMenu(app)) ?? []).map((item) => item.label);

const expectedTop = (lang: Lang) =>
  process.platform === 'darwin'
    ? expect.arrayContaining([tr(lang, 'shell.menu.file')])
    : [
        tr(lang, 'shell.menu.file'),
        tr(lang, 'shell.menu.edit'),
        tr(lang, 'shell.menu.view'),
        tr(lang, 'shell.menu.transaction'),
        tr(lang, 'shell.menu.reports'),
        tr(lang, 'shell.menu.help'),
      ];

test('ADMIN menu in both languages: rebuilt on language change; About, Backup and Daily Report dispatch', async () => {
  launched = await launchApp({ dataDir });
  const { page, app } = launched;
  await seedWorkshop(page);
  await loginWithKeyboard(page, 'admin', ADMIN_PASSWORD);

  await expect.poll(() => topLabels(app)).toEqual(expectedTop('id'));
  const ids = await visibleMenuIds(app);
  expect(ids).toContain('backupDatabase');
  expect(ids).toContain('openLogFolder');
  expect((await menuItem(app, 'newTransaction'))?.label).toBe(
    tr('id', 'shell.menu.newTransaction'),
  );

  // Switch to English: the UI and the native menu follow.
  await page
    .getByLabel(tr('id', 'shell.preferences.language'), exact)
    .selectOption('en');
  await expect(
    page.getByRole('button', {
      name: tr('en', 'shell.nav.workspace'),
      ...exact,
    }),
  ).toBeVisible();
  await expect.poll(() => topLabels(app)).toEqual(expectedTop('en'));
  expect((await menuItem(app, 'finalize'))?.label).toBe(
    tr('en', 'shell.menu.finalize'),
  );

  // Help > About: app version and schema version.
  await clickMenuItem(app, 'about');
  const about = page.getByRole('dialog', {
    name: tr('en', 'shell.about.title'),
  });
  await expect(about).toBeVisible();
  await expect(about.getByTestId('about-version')).toHaveText('1.0.0');
  await expect(about.getByTestId('about-schema')).toHaveText(/^\d+$/);
  await page.keyboard.press('Escape');
  await expect(about).toHaveCount(0);

  // File > Backup Database (ADMIN): a validated backup is written to the
  // configured (default) folder.
  await clickMenuItem(app, 'backupDatabase');
  await expect(page.getByTestId('menu-notice')).toContainText(
    tr('en', 'shell.menuNotice.backupDone').split('{{')[0]!.trim(),
  );
  expect(
    readdirSync(path.join(dataDir, 'backups')).some((f) =>
      f.endsWith('.sqlite'),
    ),
  ).toBe(true);

  // Reports > Daily Report switches the view.
  await clickMenuItem(app, 'dailyReport');
  await expect(
    page.getByRole('button', { name: tr('en', 'shell.nav.reports'), ...exact }),
  ).toHaveAttribute('aria-current', 'page');

  // Transaction > Search Item returns to the workspace and focuses search.
  await clickMenuItem(app, 'searchItem');
  await expect(searchBox(page, 'en')).toBeFocused();

  // Logout: the menu drops back to the safe items.
  await page
    .getByRole('button', { name: tr('en', 'shell.logout'), ...exact })
    .click();
  await expect.poll(() => visibleMenuIds(app)).not.toContain('newTransaction');
  expect(await visibleMenuIds(app)).not.toContain('backupDatabase');
});

test('CASHIER: no ADMIN menu items; direct ADMIN IPC is FORBIDDEN in main', async () => {
  launched = await launchApp({ dataDir });
  const { page, app } = launched;
  await seedWorkshop(page);
  await loginWithKeyboard(page, 'siti', CASHIER_PASSWORD);
  await expect.poll(() => visibleMenuIds(app)).toContain('finalize');
  const ids = await visibleMenuIds(app);
  expect(ids).not.toContain('backupDatabase');
  expect(ids).not.toContain('openLogFolder');

  const forbidden = await page.evaluate(async () => {
    const b = window.bengkelin;
    const results = await Promise.all([
      b.backups.create(),
      b.cashiers.list(),
      b.app.openLogFolder(),
      b.adHocReferences.list({}),
      b.settings.updateShop({
        name: 'X',
        address: 'Y',
        timezone: 'Asia/Jakarta',
      }),
    ]);
    return results.map((r) => (r.ok ? 'ok' : r.error.code));
  });
  expect(forbidden).toEqual([
    'FORBIDDEN',
    'FORBIDDEN',
    'FORBIDDEN',
    'FORBIDDEN',
    'FORBIDDEN',
  ]);
  // The names-only listing is open to any session.
  const names = await page.evaluate(async () =>
    window.bengkelin.cashiers.listNames(),
  );
  expect(names.ok && names.value.map((c) => c.displayName).sort()).toEqual([
    'Pak Budi',
    'Siti',
  ]);
});

test('View > Reload flushes pending draft input first', async () => {
  launched = await launchApp({ dataDir });
  const { page, app } = launched;
  await seedWorkshop(page);
  await loginWithKeyboard(page, 'siti', CASHIER_PASSWORD);
  await expect(searchBox(page)).toBeFocused();
  await scan(page, OIL_BARCODE);
  await expect(page.getByTestId('line-row')).toHaveCount(1);

  // Typed text is still inside the 300 ms debounce when Reload is chosen.
  await page
    .getByLabel(tr('id', 'workspace.header.note'), exact)
    .fill('Ganti oli dan cek rem');
  await clickMenuItem(app, 'reload');
  await expect(searchBox(page)).toBeFocused();
  await expect(
    page.getByLabel(tr('id', 'workspace.header.note'), exact),
  ).toHaveValue('Ganti oli dan cek rem');
});

test('ADMIN screens: cashier management with LAST_ACTIVE_ADMIN, shop settings with the timezone warning', async () => {
  launched = await launchApp({ dataDir });
  const { page } = launched;
  const t = (key: string) => tr('id', key);
  await seedWorkshop(page);
  await loginWithKeyboard(page, 'admin', ADMIN_PASSWORD);

  // ---- Cashiers ----
  await page
    .getByRole('button', { name: t('shell.nav.cashiers'), ...exact })
    .click();
  await expect(page.getByTestId('cashier-row')).toHaveCount(2);
  const create = page.getByRole('form', { name: t('cashiers.create.title') });
  await create.getByLabel(t('cashiers.fields.username'), exact).fill('joko');
  await create.getByLabel(t('cashiers.fields.displayName'), exact).fill('Joko');
  await create
    .getByLabel(t('cashiers.fields.password'), exact)
    .fill('joko-password-1');
  await create
    .getByRole('button', { name: t('cashiers.create.submit'), ...exact })
    .click();
  await expect(page.getByTestId('cashier-row')).toHaveCount(3);

  // The only ADMIN cannot be demoted: the error is announced.
  await page
    .getByRole('button', { name: `${t('cashiers.actions.manage')}: Pak Budi` })
    .click();
  const manage = page.getByRole('dialog', { name: /Pak Budi/ });
  await manage
    .getByLabel(t('cashiers.fields.role'), exact)
    .selectOption('CASHIER');
  await manage
    .getByRole('button', { name: t('cashiers.manage.saveRole'), ...exact })
    .click();
  await expect(manage.getByRole('alert')).toHaveText(
    t('errors.LAST_ACTIVE_ADMIN'),
  );
  await page.keyboard.press('Escape');

  // Deactivate Joko: the row shows it; reactivate again.
  await page
    .getByRole('button', { name: `${t('cashiers.actions.manage')}: Joko` })
    .click();
  const joko = page.getByRole('dialog', { name: /Joko/ });
  await joko
    .getByRole('button', { name: t('cashiers.manage.deactivate'), ...exact })
    .click();
  await expect(joko.getByRole('status')).toHaveText(t('cashiers.manage.saved'));
  await page.keyboard.press('Escape');
  await expect(
    page.getByTestId('cashier-row').filter({ hasText: 'joko' }),
  ).toContainText(t('cashiers.status.inactive'));

  // ---- Shop settings ----
  await page
    .getByRole('button', { name: t('shell.nav.settings'), ...exact })
    .click();
  const shop = page.getByRole('form', { name: t('settings.shop.title') });
  await expect(shop.getByLabel(t('settings.shop.name'), exact)).toHaveValue(
    'Bengkel Maju',
  );
  await shop
    .getByLabel(t('settings.shop.name'), exact)
    .fill('Bengkel Maju Jaya');
  await expect(shop.getByTestId('timezone-warning')).toHaveCount(0);
  await shop
    .getByLabel(t('settings.shop.timezone'), exact)
    .fill('Asia/Makassar');
  await expect(shop.getByTestId('timezone-warning')).toHaveText(
    t('settings.shop.timezoneWarning'),
  );
  await shop
    .getByRole('button', { name: t('settings.shop.save'), ...exact })
    .click();
  await expect(shop.getByRole('status')).toHaveText(t('settings.shop.saved'));
  await expect(page.getByText('Bengkel Maju Jaya').first()).toBeVisible();

  // An unknown timezone is refused with a field error.
  await shop
    .getByLabel(t('settings.shop.timezone'), exact)
    .fill('Mars/Olympus');
  await shop
    .getByRole('button', { name: t('settings.shop.save'), ...exact })
    .click();
  await expect(shop.getByText(t('validation.invalidTimezone'))).toBeVisible();
});

test('technical log: startup migration outcome and a gone renderer (spec 46/48)', async () => {
  launched = await launchApp({ dataDir });
  const { page, app } = launched;
  // First run: the setup wizard is up once startup (and migration) is done.
  await expect(
    page.getByText(tr('id', 'setup.shop.title')).first(),
  ).toBeVisible();
  const readLog = () =>
    readFileSync(path.join(dataDir, 'logs', 'bengkelin.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const migrations = readLog().find((e) => e.event === 'startup.migrations');
  expect(migrations).toMatchObject({ level: 'info', from: 0 });
  expect(migrations?.to).toBeGreaterThanOrEqual(11);
  expect(migrations?.applied).toEqual(expect.arrayContaining([1]));

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer(),
  );
  await expect
    .poll(() =>
      readLog().some((e) => e.event === 'process.render_process_gone'),
    )
    .toBe(true);
  const gone = readLog().find((e) => e.event === 'process.render_process_gone');
  expect(gone).toMatchObject({ level: 'error', reason: expect.any(String) });
});
