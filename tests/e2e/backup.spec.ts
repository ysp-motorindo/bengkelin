import { navigateTo } from './helpers/navigation';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { tr } from './helpers/i18n';
import { launchApp, type LaunchedApp } from './helpers/launch';

/**
 * Task 14: an ADMIN makes a manual backup from Settings. The native folder
 * dialog is answered by the test-only env hook BENGKELIN_TEST_BACKUP_DIR
 * (unpackaged builds only), never by the renderer.
 */

const ADMIN_PASSWORD = 'correct-horse-battery';
const exact = { exact: true } as const;
const t = (key: string, params: Record<string, string> = {}) =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{{${name}}}`, value),
    tr('id', key),
  );

let launched: LaunchedApp | undefined;
let dataDir: string;
let backupDir: string;

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-backup-'));
  backupDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-usb-'));
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(dataDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
});

test('ADMIN chooses a folder and "Backup now" writes a validated file there', async () => {
  launched = await launchApp({
    dataDir,
    env: { BENGKELIN_TEST_BACKUP_DIR: backupDir },
  });
  const { page } = launched;
  await page.evaluate(async (adminPassword) => {
    const result = await window.bengkelin.settings.completeSetup({
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
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
  }, ADMIN_PASSWORD);
  await page.reload();

  await page.getByLabel(t('auth.login.username'), exact).fill('admin');
  await page.getByLabel(t('auth.login.password'), exact).fill(ADMIN_PASSWORD);
  await page
    .getByRole('button', { name: t('auth.login.submit'), ...exact })
    .click();
  await navigateTo(page, 'settings');

  const section = page.getByTestId('backup-section');
  await expect(section).toBeVisible();
  await section
    .getByRole('button', { name: t('backups.chooseFolder'), ...exact })
    .click();
  await expect(section.getByTestId('backup-notice')).toHaveText(
    t('backups.folderUpdated'),
  );
  await expect(section.getByTestId('backup-destination')).toContainText(
    backupDir,
  );

  await section
    .getByRole('button', { name: t('backups.backupNow'), ...exact })
    .click();
  const notice = section.getByTestId('backup-notice');
  await expect(notice).toHaveText(
    /^Cadangan dibuat: bengkelin-manual-\d{8}-\d{6}\.sqlite$/,
  );
  const fileName = (await notice.textContent())!.replace(
    'Cadangan dibuat: ',
    '',
  );

  // Exactly the final file: no partial or side files.
  expect(readdirSync(backupDir)).toEqual([fileName]);
  const header = readFileSync(path.join(backupDir, fileName)).subarray(0, 20);
  expect(header.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');
  expect(header[18]).toBe(1);
  // The run is listed and no failure banner is shown.
  await expect(section.getByText(fileName, exact)).toBeVisible();
  await expect(page.getByTestId('backup-failure-banner')).toHaveCount(0);
});

test('the daily automatic backup catches up at startup into userData/backups', async () => {
  launched = await launchApp({ dataDir });
  await launched.page.evaluate(async (adminPassword) => {
    const result = await window.bengkelin.settings.completeSetup({
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
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
  }, ADMIN_PASSWORD);
  await launched.close();

  // Restart: setup is complete and no automatic backup exists today.
  launched = await launchApp({ dataDir });
  await expect(
    launched.page.getByLabel(t('auth.login.username'), exact),
  ).toBeVisible();
  const backups = path.join(dataDir, 'backups');
  await expect
    .poll(() => {
      try {
        return readdirSync(backups);
      } catch {
        return [];
      }
    })
    .toEqual([expect.stringMatching(/^bengkelin-auto-\d{8}-\d{6}\.sqlite$/)]);
});
