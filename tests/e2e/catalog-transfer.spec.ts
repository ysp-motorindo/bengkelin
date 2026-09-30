import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { tr } from './helpers/i18n';
import { launchApp, type LaunchedApp } from './helpers/launch';

/**
 * Task 15: an ADMIN imports a small catalog CSV. The native open dialog is
 * answered by the test-only env hook BENGKELIN_TEST_OPEN_CSV_PATH (unpackaged
 * builds only); the renderer never supplies a path.
 */

const ADMIN_PASSWORD = 'correct-horse-battery';
const exact = { exact: true } as const;
const t = (key: string) => tr('id', key);
const FIXTURE = path.resolve(__dirname, '../fixtures/csv/e2e-import.csv');

let launched: LaunchedApp | undefined;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-transfer-'));
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

test('ADMIN previews and commits a catalog CSV, then finds the items in the catalog', async () => {
  launched = await launchApp({
    dataDir,
    env: { BENGKELIN_TEST_OPEN_CSV_PATH: FIXTURE },
  });
  const { page } = launched;
  await page.evaluate(async (adminPassword) => {
    const result = await window.bengkelin.settings.completeSetup({
      shop: { name: 'Bengkel', address: 'Jl. A', timezone: 'Asia/Jakarta' },
      admin: {
        username: 'admin',
        displayName: 'Pak Budi',
        password: adminPassword,
      },
      preferences: { language: 'id', appearance: 'LIGHT' },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    await window.bengkelin.auth.login({
      username: 'admin',
      password: adminPassword,
    });
  }, ADMIN_PASSWORD);
  await page.reload();
  await expect(page.getByTestId('session-name')).toBeVisible();

  const nav = page.getByRole('navigation');
  await nav
    .getByRole('button', { name: t('shell.nav.catalogTransfer'), ...exact })
    .click();
  await page
    .getByRole('button', { name: t('catalogTransfer.import'), ...exact })
    .click();

  const preview = page.getByTestId('catalog-import-preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId('import-count-creates')).toHaveText('2');
  await expect(preview.getByTestId('import-count-openingBalances')).toHaveText(
    '1',
  );
  await expect(preview.getByTestId('import-errors')).toContainText(
    t('catalogTransfer.preview.noErrors'),
  );
  const rows = preview.getByTestId('import-rows');
  await expect(rows).toContainText('E2E-BUSI');
  await expect(rows).toContainText('0012345678905');
  await expect(preview).toContainText(t('catalogTransfer.preview.backupNote'));

  await preview
    .getByRole('button', {
      name: t('catalogTransfer.preview.commit'),
      ...exact,
    })
    .click();
  await expect(page.getByTestId('catalog-import-result')).toContainText(
    'bengkelin-safety-',
  );
  await expect(preview).toHaveCount(0);
  // The safety backup exists in userData/backups.
  expect(
    readdirSync(path.join(dataDir, 'backups')).filter((f) =>
      f.startsWith('bengkelin-safety-'),
    ),
  ).toHaveLength(1);

  await nav
    .getByRole('button', { name: t('shell.nav.catalog'), ...exact })
    .click();
  const catalogRows = page.getByTestId('catalog-row');
  await expect(catalogRows.filter({ hasText: 'Busi Iridium E2E' })).toHaveCount(
    1,
  );
  await expect(
    catalogRows.filter({ hasText: 'Servis Ringan E2E' }),
  ).toHaveCount(1);
});
