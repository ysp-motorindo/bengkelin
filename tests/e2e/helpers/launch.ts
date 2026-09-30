import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  close(): Promise<void>;
}

const projectRoot = path.resolve(__dirname, '../../..');

/**
 * Launches the built (unpackaged) app headlessly with an isolated, temporary
 * BENGKELIN_DATA_DIR. Run `npm run build:app` first (the test:e2e script does).
 * Pass `dataDir` to reuse a directory that was seeded before launch.
 */
export async function launchApp(
  options: {
    dataDir?: string;
    env?: Record<string, string>;
    /** Extra Chromium/Electron switches (before the app path). */
    args?: string[];
  } = {},
): Promise<LaunchedApp> {
  const ownsDataDir = options.dataDir === undefined;
  const dataDir =
    options.dataDir ?? (await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-')));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') {
      env[key] = value;
    }
  }
  // Linux without a display server: run Chromium on the headless ozone
  // platform. When a display exists (desktop, CI under xvfb-run) use it.
  const hasDisplay = Boolean(
    process.env.DISPLAY || process.env.WAYLAND_DISPLAY,
  );
  const linuxArgs =
    process.platform === 'linux'
      ? [
          '--no-sandbox',
          '--disable-gpu',
          ...(hasDisplay ? [] : ['--ozone-platform=headless']),
        ]
      : [];
  const app = await electron.launch({
    args: [...linuxArgs, ...(options.args ?? []), projectRoot],
    env: { ...env, ...options.env, BENGKELIN_DATA_DIR: dataDir },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  return {
    app,
    page,
    dataDir,
    async close() {
      await app.close().catch(() => undefined);
      if (ownsDataDir) {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  };
}
