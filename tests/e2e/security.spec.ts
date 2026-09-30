import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './helpers/launch';

const rawIpcPreload = path.resolve(__dirname, 'fixtures/untrusted-preload.cjs');

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched?.close();
});

test('renderer is isolated and exposes only the preload bridge', async () => {
  const { page } = launched;
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  expect(await page.evaluate(() => typeof window.process)).toBe('undefined');
  expect(await page.evaluate(() => typeof window.bengkelin)).toBe('object');
  await expect(page.locator('#root')).not.toBeEmpty();
});

test('DevTools are not opened outside development', async () => {
  const state = await launched.app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents;
    return { devTools: wc.isDevToolsOpened(), url: wc.getURL() };
  });
  expect(state.devTools).toBe(false);
  expect(state.url.startsWith('file://')).toBe(true);
});

test('production CSP allows no remote origins', async () => {
  const csp = await launched.page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toBeTruthy();
  expect(csp).not.toMatch(/https?:|wss?:|\*/);
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
});

test('navigation to an external URL is blocked', async () => {
  const { page } = launched;
  const before = page.url();
  // A local server stands in for the internet: an unblocked navigation would
  // reach it, so the test is deterministic with or without network access.
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.end('<title>external</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await page.evaluate((url) => {
      window.location.href = url;
    }, `http://127.0.0.1:${port}/`);
    await page.waitForTimeout(1000);
    expect(requests).toBe(0);
    expect(page.url()).toBe(before);
  } finally {
    server.close();
  }
});

test('window.open creates no new window', async () => {
  const { page, app } = launched;
  const opened = await page.evaluate(
    () => window.open('https://example.com/', '_blank') !== null,
  );
  await page.waitForTimeout(500);
  expect(opened).toBe(false);
  expect(app.windows()).toHaveLength(1);
  expect(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
});

test('IPC is rejected from untrusted frames and accepted from the app frame', async () => {
  const { app } = launched;
  const trustedUrl = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.getURL(),
  );

  // Harness windows get a preload exposing raw ipcRenderer.invoke so the
  // main-process sender validation can be exercised directly.
  const open = (url: string) =>
    app.evaluate(
      async ({ BrowserWindow }, args) => {
        const win = new BrowserWindow({
          show: false,
          webPreferences: { preload: args.preload, sandbox: false },
        });
        await win.loadURL(args.url);
      },
      { url, preload: rawIpcPreload },
    );

  await open('data:text/html,<title>untrusted</title>');
  await open(trustedUrl);

  const results: Record<string, string> = {};
  for (const p of app.windows()) {
    const hasRawIpc = await p.evaluate(() => 'rawInvoke' in window);
    if (!hasRawIpc) continue; // the real app window has no raw IPC access
    const key = p.url().startsWith('data:') ? 'untrusted' : 'trusted';
    results[key] = await p.evaluate(async () => {
      try {
        const invoke = (
          window as unknown as { rawInvoke(channel: string): Promise<unknown> }
        ).rawInvoke;
        return `ok:${String(await invoke('bengkelin:app:ping'))}`;
      } catch (error) {
        return `error:${(error as Error).message}`;
      }
    });
  }

  expect(results.untrusted).toMatch(/^error:.*untrusted/i);
  expect(results.trusted).toBe('ok:pong');
});
