import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { ElectronApplication } from '@playwright/test';

/**
 * Test-side probes of the running app (never part of the app itself):
 * the native menu as main built it, clicking a menu item the way a user
 * would, a network request recorder on every Electron session, and a
 * read-only SQLite query of the app's database after it has closed.
 */

export interface MenuItemSnapshot {
  id: string | null;
  label: string;
  enabled: boolean;
  visible: boolean;
  accelerator: string | null;
  role: string | null;
  submenu: MenuItemSnapshot[];
}

/** The application menu as a plain tree (null when none is set). */
export async function readMenu(
  app: ElectronApplication,
): Promise<MenuItemSnapshot[] | null> {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) return null;
    type Item = Electron.MenuItem;
    const snap = (item: Item): MenuItemSnapshot => ({
      id: item.id ?? null,
      label: item.label,
      enabled: item.enabled,
      visible: item.visible,
      accelerator: item.accelerator ? String(item.accelerator) : null,
      role: item.role ?? null,
      submenu: item.submenu ? item.submenu.items.map(snap) : [],
    });
    return menu.items.map(snap);
  });
}

export function flattenMenu(items: MenuItemSnapshot[]): MenuItemSnapshot[] {
  return items.flatMap((item) => [item, ...flattenMenu(item.submenu)]);
}

/** Ids of every visible menu item. */
export async function visibleMenuIds(
  app: ElectronApplication,
): Promise<string[]> {
  const menu = (await readMenu(app)) ?? [];
  return flattenMenu(menu)
    .filter((item) => item.visible && item.id)
    .map((item) => item.id as string);
}

export async function menuItem(
  app: ElectronApplication,
  id: string,
): Promise<MenuItemSnapshot | undefined> {
  const menu = (await readMenu(app)) ?? [];
  return flattenMenu(menu).find((item) => item.id === id);
}

/** Clicks a native menu item (as the user would with the mouse). */
export async function clickMenuItem(
  app: ElectronApplication,
  id: string,
): Promise<void> {
  await app.evaluate(({ Menu, BrowserWindow }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`No menu item ${itemId}`);
    if (!item.enabled) throw new Error(`Menu item ${itemId} is disabled`);
    const window = BrowserWindow.getAllWindows()[0];
    item.click(undefined, window, window?.webContents);
  }, id);
}

/**
 * Synthetic input reaches native menu accelerators on Linux/Windows.
 * macOS does not activate them from sendInputEvent, so verify the registered
 * accelerator and dispatch its menu item there. Physical macOS keys need
 * manual acceptance testing.
 */
export async function pressShortcut(
  app: ElectronApplication,
  shortcut: string,
): Promise<void> {
  if (process.platform === 'darwin') {
    const items = flattenMenu((await readMenu(app)) ?? []);
    const item = items.find(
      (item) => item.accelerator?.toLowerCase() === shortcut.toLowerCase(),
    );
    if (!item?.id || !item.visible || !item.enabled) {
      throw new Error(`No enabled menu item for ${shortcut}`);
    }
    await clickMenuItem(app, item.id);
    return;
  }
  const parts = shortcut.split('+');
  const keyCode = parts.pop()!;
  const modifiers = parts.map((part) =>
    part.toLowerCase() === 'cmdorctrl' ? 'control' : part.toLowerCase(),
  );
  await app.evaluate(
    ({ BrowserWindow }, key) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const modifiers =
        key.modifiers as Electron.KeyboardInputEvent['modifiers'];
      contents.sendInputEvent({
        type: 'keyDown',
        keyCode: key.keyCode,
        modifiers,
      });
      contents.sendInputEvent({
        type: 'keyUp',
        keyCode: key.keyCode,
        modifiers,
      });
    },
    { keyCode, modifiers },
  );
}

/**
 * Records every request any Electron session makes (the app's window and
 * the hidden print window). Installed by the TEST through the Playwright
 * main-process handle; the app has no such hook.
 */
export async function recordRequests(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, session }) => {
    const store = globalThis as unknown as { __requests?: string[] };
    store.__requests = [];
    const watched = new WeakSet<Electron.Session>();
    const watch = (target: Electron.Session) => {
      if (watched.has(target)) return;
      watched.add(target);
      target.webRequest.onBeforeRequest((details, callback) => {
        store.__requests!.push(details.url);
        callback({});
      });
    };
    watch(session.defaultSession);
    watch(session.fromPartition('bengkelin-print'));
    electronApp.on('session-created', watch);
  });
}

/** Requests that left the machine (anything but local app/document URLs). */
export async function networkRequests(
  app: ElectronApplication,
): Promise<string[]> {
  const urls = await app.evaluate(
    () => (globalThis as unknown as { __requests?: string[] }).__requests ?? [],
  );
  return urls.filter(
    (url) => !/^(file|data|blob|devtools|chrome-extension|about):/i.test(url),
  );
}

export async function allRequests(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { __requests?: string[] }).__requests ?? [],
  );
}

const projectRoot = path.resolve(__dirname, '../../..');

/**
 * Runs a read-only query against the app's database with Electron's own
 * Node (better-sqlite3 is built for Electron's ABI). Call it after the app
 * has closed. Integers come back as numbers.
 */
export function queryDatabase<T = Record<string, unknown>>(
  dataDir: string,
  sql: string,
): T[] {
  // `require('electron')` in plain Node resolves to the binary's path.
  const electronBinary = require('electron') as unknown as string;
  const script = `
    const Database = require(${JSON.stringify(path.join(projectRoot, 'node_modules/better-sqlite3'))});
    const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
    const rows = db.prepare(process.argv[2]).all();
    db.close();
    process.stdout.write(JSON.stringify(rows));
  `;
  const output = execFileSync(
    electronBinary,
    ['-e', script, path.join(dataDir, 'bengkelin.sqlite'), sql],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    },
  );
  return JSON.parse(output) as T[];
}
