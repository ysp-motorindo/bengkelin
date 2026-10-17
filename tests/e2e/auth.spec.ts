import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './helpers/launch';
import { tr, type Lang } from './helpers/i18n';

const PASSWORD = 'correct-horse-battery';

let launched: LaunchedApp | undefined;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-auth-'));
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

const exact = { exact: true } as const;

/** Drives the real wizard UI. Steps 1-2 render in the default language (id). */
async function runSetupWizard(
  page: Page,
  options: { language: Lang; appearance: 'LIGHT' | 'DARK' | 'SYSTEM' },
) {
  const id = (key: string) => tr('id', key);
  const lang = (key: string) => tr(options.language, key);

  await expect(
    page.getByRole('heading', { name: id('setup.shop.title') }),
  ).toBeVisible();
  await page.getByLabel(id('setup.shop.name'), exact).fill('Bengkel Maju Jaya');
  await page
    .getByLabel(id('setup.shop.address'), exact)
    .fill('Jl. Merdeka 1, Bandung');
  await page.getByRole('button', { name: id('common.next') }).click();

  await page.getByLabel(id('setup.admin.username'), exact).fill('admin');
  await page.getByLabel(id('setup.admin.displayName'), exact).fill('Pak Budi');
  await page.getByLabel(id('setup.admin.password'), exact).fill(PASSWORD);
  await page
    .getByLabel(id('setup.admin.confirmPassword'), exact)
    .fill(PASSWORD);
  await page.getByRole('button', { name: id('common.next') }).click();

  await page
    .getByLabel(id('setup.preferences.language'), exact)
    .selectOption(options.language);
  // The wizard switches language immediately.
  await page
    .getByLabel(lang('setup.preferences.appearance'), exact)
    .selectOption(options.appearance);
  await page.getByRole('button', { name: lang('common.next') }).click();

  await expect(
    page.getByRole('heading', { name: lang('setup.printer.title') }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: lang('common.skip'), ...exact })
    .click();

  await page
    .getByRole('button', { name: lang('setup.finish.start'), ...exact })
    .click();
  await expect(
    page.getByRole('heading', { name: lang('auth.login.title') }),
  ).toBeVisible();
}

async function login(
  page: Page,
  lang: Lang,
  username: string,
  password: string,
) {
  await page.getByLabel(tr(lang, 'auth.login.username'), exact).fill(username);
  await page.getByLabel(tr(lang, 'auth.login.password'), exact).fill(password);
  await page
    .getByRole('button', { name: tr(lang, 'auth.login.submit'), ...exact })
    .click();
}

for (const language of ['id', 'en'] as const) {
  test(`setup, login and logout in ${language}`, async () => {
    launched = await launchApp({ dataDir });
    const { page } = launched;
    await runSetupWizard(page, { language, appearance: 'LIGHT' });
    await expect(page.locator('html')).toHaveAttribute('lang', language);

    // Wrong password: translated error, still on the login screen.
    await login(page, language, 'admin', 'not-the-password');
    await expect(page.getByRole('alert')).toHaveText(
      tr(language, 'errors.INVALID_CREDENTIALS'),
    );

    await login(page, language, 'admin', PASSWORD);
    await expect(page.getByTestId('session-name')).toHaveText('Pak Budi');
    await expect(page.getByTestId('session-role')).toHaveText(
      `(${tr(language, 'common.role.ADMIN')})`,
    );

    // A reload keeps the window-bound session.
    await page.reload();
    await expect(page.getByTestId('session-name')).toHaveText('Pak Budi');

    await page.getByTestId('session-name').click();
    await page
      .getByRole('button', { name: tr(language, 'shell.logout') })
      .click();
    await expect(
      page.getByRole('heading', { name: tr(language, 'auth.login.title') }),
    ).toBeVisible();

    // Session is really gone in main, not only hidden in the UI.
    const denied = await page.evaluate(() => window.bengkelin.cashiers.list());
    expect(denied).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED' },
    });
  });
}

test('theme and language persist across restart', async () => {
  launched = await launchApp({ dataDir });
  await runSetupWizard(launched.page, { language: 'en', appearance: 'DARK' });
  await expect(launched.page.locator('html')).toHaveClass(/\bdark\b/);
  await launched.close();

  launched = await launchApp({ dataDir });
  const { page } = launched;
  await expect(
    page.getByRole('heading', { name: tr('en', 'auth.login.title') }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByText('Bengkel Maju Jaya')).toBeVisible();
});

test('SYSTEM appearance follows the OS colour scheme live', async () => {
  launched = await launchApp({ dataDir });
  const { page } = launched;
  await runSetupWizard(page, { language: 'id', appearance: 'SYSTEM' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
});

test('direct ADMIN calls from the renderer are denied without a session and for a CASHIER', async () => {
  launched = await launchApp({ dataDir });
  const { page } = launched;

  // Before setup and without a session.
  const results = await page.evaluate(async () => {
    const b = window.bengkelin;
    return {
      list: await b.cashiers.list(),
      shop: await b.settings.updateShop({
        name: 'x',
        address: 'y',
        timezone: 'Asia/Jakarta',
      }),
      logs: await b.app.openLogFolder(),
    };
  });
  expect(results.list).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHENTICATED' },
  });
  expect(results.shop).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHENTICATED' },
  });
  expect(results.logs).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHENTICATED' },
  });

  // Set up, create a cashier as ADMIN, then act as that CASHIER.
  const codes = await page.evaluate(
    async ({ password }) => {
      const b = window.bengkelin;
      await b.settings.completeSetup({
        shop: { name: 'Bengkel', address: 'Jl. A', timezone: 'Asia/Jakarta' },
        admin: { username: 'admin', displayName: 'Admin', password },
        preferences: { language: 'id', appearance: 'LIGHT' },
      });
      await b.auth.login({ username: 'admin', password });
      const created = await b.cashiers.create({
        username: 'siti',
        displayName: 'Siti',
        password: 'siti-password-1',
        role: 'CASHIER',
      });
      await b.auth.logout();
      await b.auth.login({ username: 'siti', password: 'siti-password-1' });
      const code = (r: { ok: boolean; error?: { code: string } }) =>
        r.ok ? 'OK' : r.error?.code;
      return {
        created: created.ok,
        list: code(await b.cashiers.list()),
        create: code(
          await b.cashiers.create({
            username: 'evil',
            displayName: 'Evil',
            password: 'evil-password-1',
            role: 'ADMIN',
          }),
        ),
        prefs: code(
          await b.settings.updatePreferences({
            numberFormat: 'ID',
            language: 'en',
            appearance: 'DARK',
          }),
        ),
        logs: code(await b.app.openLogFolder()),
        // A malformed payload is a validation error, never a thrown exception.
        malformed: code(await b.auth.login({ username: 1 } as never)),
      };
    },
    { password: PASSWORD },
  );
  expect(codes).toEqual({
    created: true,
    list: 'FORBIDDEN',
    create: 'FORBIDDEN',
    prefs: 'OK',
    logs: 'FORBIDDEN',
    malformed: 'VALIDATION_FAILED',
  });
});

test('technical logs are written and never contain the plaintext password', async () => {
  launched = await launchApp({ dataDir });
  const { page } = launched;
  const secret = 'never-log-this-Passw0rd';
  await page.evaluate(async (password) => {
    await window.bengkelin.auth.login({ username: 'admin', password });
    await window.bengkelin.auth.login({
      username: 'admin',
      password,
      extra: true,
    } as never);
  }, secret);
  await launched.close();

  const logDir = path.join(dataDir, 'logs');
  const files = await readdir(logDir);
  expect(files).toContain('bengkelin.log');
  const text = (
    await Promise.all(files.map((f) => readFile(path.join(logDir, f), 'utf8')))
  ).join('\n');
  expect(text).toContain('startup');
  expect(text).not.toContain(secret);
});
