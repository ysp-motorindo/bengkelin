import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  clickMenuItem,
  menuItem,
  networkRequests,
  allRequests,
  pressShortcut,
  queryDatabase,
  recordRequests,
  visibleMenuIds,
} from './helpers/app-probe';
import { tr } from './helpers/i18n';
import { launchApp, type LaunchedApp } from './helpers/launch';
import { NetworkGuard } from './helpers/network-guard';
import {
  CASHIER_PASSWORD,
  HELMET_BARCODE,
  OIL_BARCODE,
  exact,
  loginWithKeyboard,
  scan,
  searchBox,
  seedWorkshop,
  tabTo,
} from './helpers/workflow-seed';

/**
 * Task 17: the whole cashier workflow (spec 57), keyboard first, through
 * the native menu and its shortcuts:
 * login -> new draft -> scan twice (qty 2) -> service line with a mechanic
 * -> sequential 30/50/10 discounts (Rp 31.500) -> restart (the draft
 * survives) -> split/partial payment -> F8 review -> finalize -> Ctrl+P
 * print -> later payment from History -> PAID.
 *
 * Shortcuts are pressed as real input (webContents.sendInputEvent), so they
 * go through the native menu accelerators.
 *
 * Paper prints are routed to printToPDF by the unpackaged-only test hook
 * BENGKELIN_TEST_PRINT_TO_PDF_DIR.
 *
 * Offline (verified for BOTH launches, from process start to exit): the
 * Chromium net-log of each launch holds no request or host lookup that is
 * not local (file:, data:, devtools:, localhost...), non-local names are
 * unresolvable (--host-resolver-rules), and main-process Node made no
 * non-local socket connection (net-guard hook). The in-page webRequest
 * recorder is an extra signal, checked per launch. Not covered: traffic
 * from outside the app's own processes.
 */

const t = (key: string, params: Record<string, string> = {}) =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{{${name}}}`, value),
    tr('id', key),
  );

let launched: LaunchedApp | undefined;
let dataDir: string;
let printDir: string;
let guard: NetworkGuard;

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-workflow-'));
  printDir = await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-prints-'));
  guard = new NetworkGuard(
    await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-netguard-')),
  );
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(dataDir, { recursive: true, force: true });
  await rm(printDir, { recursive: true, force: true });
  await rm(guard.dir, { recursive: true, force: true });
});

async function launch(): Promise<LaunchedApp> {
  const observed = guard.launchOptions();
  const app = await launchApp({
    dataDir,
    args: observed.args,
    env: { ...observed.env, BENGKELIN_TEST_PRINT_TO_PDF_DIR: printDir },
  });
  // Extra signal only (installed after the first window loads).
  await recordRequests(app.app);
  return app;
}

/** The in-page recorder saw requests, and none of them was non-local. */
async function expectNoPageNetwork(app: LaunchedApp['app']): Promise<void> {
  expect(await allRequests(app)).not.toHaveLength(0);
  expect(await networkRequests(app)).toEqual([]);
}

test('full cashier workflow: scan, service, discounts, restart, split payment, F8 review, finalize, print, later payment', async () => {
  test.setTimeout(180_000);
  launched = await launch();
  let { page, app } = launched;
  await seedWorkshop(page);

  // ---- Before login: only safe menu items ----
  await expect.poll(() => visibleMenuIds(app)).toContain('about');
  const signedOut = await visibleMenuIds(app);
  for (const id of [
    'newTransaction',
    'print',
    'backupDatabase',
    'searchItem',
    'finalize',
    'dailyReport',
    'openLogFolder',
  ]) {
    expect(signedOut).not.toContain(id);
  }

  // ---- Login (keyboard only) ----
  await loginWithKeyboard(page, 'siti', CASHIER_PASSWORD);
  await expect(searchBox(page)).toBeFocused();
  await expect.poll(() => visibleMenuIds(app)).toContain('finalize');
  const cashierMenu = await visibleMenuIds(app);
  for (const id of [
    'newTransaction',
    'print',
    'searchItem',
    'addCustomItem',
    'saveDraft',
    'finalize',
    'dailyReport',
    'about',
    'reload',
  ]) {
    expect(cashierMenu).toContain(id);
  }
  // No ADMIN-only items for a CASHIER; nothing printable yet.
  expect(cashierMenu).not.toContain('backupDatabase');
  expect(cashierMenu).not.toContain('openLogFolder');
  expect((await menuItem(app, 'print'))?.enabled).toBe(false);
  expect((await menuItem(app, 'finalize'))?.accelerator).toBe('F8');
  expect((await menuItem(app, 'searchItem'))?.accelerator).toBe('F2');
  expect((await menuItem(app, 'newTransaction'))?.accelerator).toBe(
    'CmdOrCtrl+N',
  );
  expect((await menuItem(app, 'saveDraft'))?.accelerator).toBe('CmdOrCtrl+S');
  expect((await menuItem(app, 'print'))?.accelerator).toBe('CmdOrCtrl+P');

  // ---- Accessible feedback: an unknown barcode is announced ----
  await scan(page, '0000000000000');
  await expect(page.getByRole('alert')).toContainText('0000000000000');
  await expect(page.getByTestId('line-row')).toHaveCount(0);

  // ---- Scan the same barcode twice: one line, qty 2 ----
  await expect(searchBox(page)).toBeFocused();
  await scan(page, OIL_BARCODE);
  await scan(page, OIL_BARCODE);
  await expect(page.getByTestId('line-row')).toHaveCount(1);
  await expect(page.getByTestId('line-quantity')).toHaveValue('2');
  await expect(page.getByTestId('total-amount')).toHaveText('Rp 130.000');

  // ---- F2 returns to "Cari barang" from anywhere ----
  await page.getByLabel(t('workspace.header.odometer'), exact).focus();
  await pressShortcut(app, 'F2');
  await expect(searchBox(page)).toBeFocused();

  // ---- Service line with a mechanic (Transaction > Add Custom Item) ----
  await clickMenuItem(app, 'addCustomItem');
  const custom = page.getByRole('region', {
    name: t('workspace.custom.title'),
  });
  await expect(custom).toBeVisible();
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
  await page
    .getByTestId('line-row')
    .nth(1)
    .getByRole('button', {
      name: new RegExp(`^${t('workspace.lines.details')}`),
    })
    .click();
  await expect(page.getByTestId('indicator-mechanic')).toContainText('Andi');

  // ---- Sequential discounts 30/50/10 on a Rp 100.000 item ----
  await searchBox(page).focus();
  await expect(searchBox(page)).toBeFocused();
  await scan(page, HELMET_BARCODE);
  await expect(page.getByTestId('line-row')).toHaveCount(3);
  const editor = page.getByTestId('line-row').nth(2);
  await editor.getByLabel(t('workspace.editor.discount1')).fill('30');
  await editor.getByLabel(t('workspace.editor.discount2')).fill('50');
  await editor.getByLabel(t('workspace.editor.discount3')).fill('10');
  await editor.getByLabel(t('workspace.editor.discount3')).press('Enter');
  await searchBox(page).click();
  const helmetRow = page.getByTestId('line-row').nth(2);
  await expect(helmetRow.getByTestId('line-amount')).toHaveText('Rp 31.500');
  await expect(page.getByTestId('total-amount')).toHaveText('Rp 196.500');

  // Save Draft (Ctrl+S) flushes: everything acknowledged.
  await pressShortcut(app, 'CmdOrCtrl+S');
  await expect(page.getByTestId('save-state')).toHaveAttribute(
    'data-state',
    'saved',
  );

  // ---- Restart mid-workflow: the draft survives ----
  // First process (setup, login, scans, custom item, discounts): offline.
  await expectNoPageNetwork(app);
  await launched.close();
  expect(guard.netLogFiles()).toHaveLength(1);
  expect(guard.netLogEventCounts()[0]).toBeGreaterThan(0);
  expect(guard.nonLocalActivity()).toEqual([]);
  launched = await launch();
  ({ page, app } = launched);
  await loginWithKeyboard(page, 'siti', CASHIER_PASSWORD);
  await expect(page.getByTestId('line-row')).toHaveCount(3);
  await expect(page.getByTestId('line-quantity').first()).toHaveValue('2');
  await expect(
    page.getByTestId('line-row').nth(2).getByTestId('line-amount'),
  ).toHaveText('Rp 31.500');
  await expect(page.getByTestId('total-amount')).toHaveText('Rp 196.500');

  await page.getByLabel(t('workspace.header.topDays'), exact).fill('7');
  await page
    .getByRole('textbox', {
      name: t('workspace.checkout.payments'),
      exact: true,
    })
    .fill('150000');
  await expect(page.getByTestId('total-amount')).toHaveText('Rp 196.500');

  // ---- F8 opens the review only; nothing is finalized by the shortcut ----
  await searchBox(page).focus();
  await pressShortcut(app, 'F8');
  const review = page.getByRole('dialog', {
    name: t('workspace.review.title'),
  });
  await expect(review).toBeVisible();
  await expect(review.getByTestId('review-total')).toHaveText('Rp 196.500');
  await expect(review.getByTestId('review-payment-status')).toHaveText(
    t('workspace.paymentStatus.PARTIALLY_PAID'),
  );
  const issued = await page.evaluate(async () =>
    window.bengkelin.invoices.search({}),
  );
  expect(issued.ok && issued.value.items.length).toBe(0);
  // F8 again while reviewing does not finalize either.
  await pressShortcut(app, 'F8');
  await expect(review).toBeVisible();

  // Finalize with the keyboard.
  const finalizeButton = review.getByRole('button', {
    name: t('workspace.review.finalize'),
    ...exact,
  });
  await tabTo(page, finalizeButton);
  await page.keyboard.press('Enter');
  const done = page.getByRole('dialog', {
    name: t('workspace.finalize.doneTitle'),
  });
  await expect(done).toBeVisible();
  const number = (await done
    .getByTestId('finalized-invoice-number')
    .textContent())!;
  expect(number).toMatch(/^INV-\d{8}-0001$/);

  // ---- Print (Ctrl+P) acts on the finalized-success view ----
  await expect
    .poll(async () => (await menuItem(app, 'print'))?.enabled)
    .toBe(true);
  await pressShortcut(app, 'CmdOrCtrl+P');
  await expect(done.getByTestId('print-notice')).toHaveText(
    t('printing.outcome.printed', {
      format: t('printing.format.THERMAL_58'),
    }),
  );
  await expect.poll(() => readdirSync(printDir).length).toBe(1);
  const printed = path.join(printDir, readdirSync(printDir)[0]!);
  expect(readFileSync(printed).subarray(0, 5).toString()).toBe('%PDF-');

  // ---- New Transaction (Ctrl+N) leaves the finalized draft ----
  await pressShortcut(app, 'CmdOrCtrl+N');
  await expect(done).toHaveCount(0);
  await expect(page.getByTestId('line-row')).toHaveCount(0);
  await expect(searchBox(page)).toBeFocused();
  await expect
    .poll(async () => (await menuItem(app, 'print'))?.enabled)
    .toBe(false);

  // ---- Later payment from History -> PAID ----
  await page
    .getByRole('button', { name: t('shell.nav.history'), ...exact })
    .click();
  const row = page.getByTestId('history-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('payment-status')).toHaveText(
    t('workspace.paymentStatus.PARTIALLY_PAID'),
  );
  await page
    .getByRole('button', { name: t('history.table.openInvoice', { number }) })
    .click();
  const detail = page.getByTestId('invoice-detail');
  await expect(detail.getByTestId('detail-outstanding')).toHaveText(
    'Rp 46.500',
  );
  await detail
    .getByRole('button', { name: t('history.detail.recordPayment'), ...exact })
    .click();
  const payment = page.getByRole('dialog', {
    name: t('history.payment.title', { number }),
  });
  await expect(
    payment.getByLabel(t('history.payment.amount'), exact),
  ).toHaveValue('46.500');
  await payment
    .getByRole('button', { name: t('history.payment.submit'), ...exact })
    .click();
  await expect(payment).toHaveCount(0);
  await expect(detail.getByTestId('payment-status')).toHaveText(
    t('workspace.paymentStatus.PAID'),
  );
  await detail
    .getByRole('button', { name: t('history.detail.back'), ...exact })
    .click();
  await expect(
    page.getByTestId('history-row').getByTestId('payment-status'),
  ).toHaveText(t('workspace.paymentStatus.PAID'));

  // ---- Offline: second process, in-page signal ----
  await expectNoPageNetwork(app);

  // ---- The print is recorded in print_jobs ----
  await launched.close();
  launched = undefined;
  // Both launches, whole lifetime: no non-local request, lookup or socket.
  expect(guard.netLogFiles()).toHaveLength(2);
  for (const events of guard.netLogEventCounts()) {
    expect(events).toBeGreaterThan(0);
  }
  expect(guard.nonLocalActivity()).toEqual([]);
  const jobs = queryDatabase<{
    format: string;
    action: string;
    outcome: string;
    invoice_number: string;
  }>(
    dataDir,
    `SELECT p.format, p.action, p.outcome, i.invoice_number
       FROM print_jobs p JOIN invoices i ON i.id = p.invoice_id`,
  );
  expect(jobs).toEqual([
    {
      format: 'THERMAL_58',
      action: 'PRINT',
      outcome: 'PRINTED',
      invoice_number: number,
    },
  ]);
  expect(existsSync(printed)).toBe(true);
});
