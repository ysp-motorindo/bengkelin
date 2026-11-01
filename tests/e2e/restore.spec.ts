import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { tr } from './helpers/i18n';
import { launchApp, type LaunchedApp } from './helpers/launch';

/**
 * Task 16: an ADMIN restores a backup from Settings; the app restarts to the
 * login screen with the backed-up data, and invoice numbers are not reused.
 *
 * Test hooks (unpackaged builds only):
 *  - BENGKELIN_TEST_OPEN_RESTORE_PATH answers the native open dialog;
 *  - BENGKELIN_TEST_RESTORE_EXIT=1 makes main EXIT instead of
 *    app.relaunch(), because Playwright cannot attach to a relaunched
 *    process. The test then launches the app again on the same data
 *    folder, which is exactly what the relaunch does (startup recovery,
 *    then the login screen).
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
let pickDir: string;

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-restore-'));
  pickDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-pick-'));
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(dataDir, { recursive: true, force: true });
  await rm(pickDir, { recursive: true, force: true });
});

/** Issues a finalized one-line service invoice through the real bridge. */
function issueInvoice(page: Page, title: string): Promise<string> {
  return page.evaluate(async (lineTitle) => {
    const b = window.bengkelin;
    const must = <T>(result: { ok: boolean; value?: T; error?: unknown }) => {
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value as T;
    };
    const channels = must<{ id: string; code: string | null }[]>(
      await b.references.listActive({ entity: 'channel' }),
    );
    const units = must<{ id: string; code: string | null }[]>(
      await b.references.listActive({ entity: 'unit' }),
    );
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta',
    }).format(new Date());
    let draft = must<{ id: string; version: number }>(
      await b.drafts.create({
        requestId: crypto.randomUUID(),
        channelId: channels.find((c) => c.code === 'BENGKEL')!.id,
        invoiceDate: today,
        pricingAt: new Date().toISOString(),
      }),
    );
    draft = must(
      await b.drafts.apply({
        requestId: crypto.randomUUID(),
        invoiceId: draft.id,
        expectedVersion: draft.version,
        op: {
          kind: 'addCustomLine',
          type: 'SERVICE',
          title: lineTitle,
          unitPrice: '50000',
          unitId: units.find((u) => u.code === 'SERVICE')!.id,
        },
      } as never),
    );
    draft = must(
      await b.drafts.apply({
        requestId: crypto.randomUUID(),
        invoiceId: draft.id,
        expectedVersion: draft.version,
        op: { kind: 'setCashPayment', amount: '50000' },
      }),
    );
    const preview = must<{ draftVersion: number; warnings: unknown[] }>(
      await b.invoices.previewFinalize({ invoiceId: draft.id }),
    );
    const invoice = must<{ invoiceNumber: string }>(
      await b.invoices.finalize({
        requestId: crypto.randomUUID(),
        invoiceId: draft.id,
        expectedVersion: preview.draftVersion,
        acknowledgedWarnings: preview.warnings,
      } as never),
    );
    return invoice.invoiceNumber;
  }, title);
}

function issuedNumbers(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const result = await window.bengkelin.invoices.search({ filters: {} });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value.items.map((item) => item.invoiceNumber).sort();
  });
}

async function signIn(page: Page): Promise<void> {
  await page.getByLabel(t('auth.login.username'), exact).fill('admin');
  await page.getByLabel(t('auth.login.password'), exact).fill(ADMIN_PASSWORD);
  await page
    .getByRole('button', { name: t('auth.login.submit'), ...exact })
    .click();
  await expect(page.getByTestId('session-name')).toBeVisible();
}

test('ADMIN restores backup A over data B; the app restarts to login with A and fresh numbers', async () => {
  const pick = path.join(pickDir, 'cadangan-A.sqlite');
  launched = await launchApp({
    dataDir,
    env: {
      BENGKELIN_TEST_OPEN_RESTORE_PATH: pick,
      BENGKELIN_TEST_RESTORE_EXIT: '1',
    },
  });
  let { page } = launched;
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
  await signIn(page);

  // Data A, a validated backup of it, then data B.
  const numberA = await issueInvoice(page, 'Servis A');
  const backupName = await page.evaluate(async () => {
    const result = await window.bengkelin.backups.create();
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value.fileName;
  });
  copyFileSync(path.join(dataDir, 'backups', backupName), pick);
  const numberB = await issueInvoice(page, 'Servis B');
  expect(numberA).toMatch(/^INV-\d{8}-0001$/);
  expect(numberB).toMatch(/^INV-\d{8}-0002$/);
  expect(await issuedNumbers(page)).toEqual([numberA, numberB]);

  // Settings -> Restore: choose, preview, type the phrase, restore.
  await page
    .getByRole('button', { name: t('shell.nav.settings'), ...exact })
    .click();
  const section = page.getByTestId('restore-section');
  await section
    .getByRole('button', { name: t('restore.chooseFile'), ...exact })
    .click();
  const preview = section.getByTestId('restore-preview');
  await expect(preview).toContainText(
    t('restore.preview.title', { fileName: 'cadangan-A.sqlite' }),
  );
  await expect(section.getByTestId('restore-invoices')).toHaveText(
    /^1 final, 0 batal, \d+ draf$/, // the workspace opens a draft after login
  );
  await expect(section.getByTestId('restore-warning')).toBeVisible();
  const restoreButton = section.getByRole('button', {
    name: t('restore.restore'),
    ...exact,
  });
  await expect(restoreButton).toBeDisabled();
  await section
    .getByLabel(t('restore.confirmLabel', { phrase: 'PULIHKAN' }), exact)
    .fill('PULIHKAN');

  const exited = new Promise<void>((resolve) =>
    launched!.app.process().once('exit', () => resolve()),
  );
  await restoreButton.click();
  await expect(section.getByTestId('restore-restarting')).toHaveText(
    t('restore.restarting'),
  );
  await exited;

  // The swap is done; startup recovery finishes it on the next launch.
  const marker = JSON.parse(
    readFileSync(path.join(dataDir, 'restore-marker.json'), 'utf8'),
  ) as { stage: string };
  expect(marker.stage).toBe('REPLACED');
  await launched.close();

  // "Relaunch": the login screen, with the backed-up data.
  launched = await launchApp({ dataDir });
  page = launched.page;
  await expect(page.getByLabel(t('auth.login.username'), exact)).toBeVisible();
  expect(existsSync(path.join(dataDir, 'restore-marker.json'))).toBe(false);
  expect(existsSync(path.join(dataDir, 'restore-staging'))).toBe(false);
  expect(
    readdirSync(dataDir).filter((name) =>
      name.startsWith('bengkelin.sqlite.pre-restore-'),
    ),
  ).toHaveLength(1);
  expect(
    readdirSync(path.join(dataDir, 'backups')).filter((name) =>
      name.startsWith('bengkelin-safety-'),
    ),
  ).toHaveLength(1);

  expect(existsSync(path.join(dataDir, 'restore-notice.json'))).toBe(true);
  await signIn(page);
  // T17: the outcome is shown once to the next ADMIN, then cleared.
  await expect(page.getByTestId('restore-notice')).toContainText(
    t('shell.restoreNotice.COMPLETED'),
  );
  await expect
    .poll(() => existsSync(path.join(dataDir, 'restore-notice.json')))
    .toBe(false);
  expect(await issuedNumbers(page)).toEqual([numberA]);
  // B's -0002 stays used after restore.
  const next = await issueInvoice(page, 'Servis setelah pemulihan');
  expect(next).toBe(numberB.replace(/-0002$/, '-0003'));
});
