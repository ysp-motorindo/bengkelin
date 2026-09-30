import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { menuLabels } from '@/main/platform/menu-labels';
import {
  buildMenuTemplate,
  type MenuTemplateInput,
} from '@/main/platform/menu-template';
import { isMenuAction, MENU_ACTIONS } from '@/shared/menu';
import enShell from '@/renderer/locales/en/shell.json';
import idShell from '@/renderer/locales/id/shell.json';

/**
 * The native menu (spec 53) is a pure function of platform, language,
 * role and printable context; main builds it with Electron's Menu.
 */

type Item = MenuItemConstructorOptions;

function build(overrides: Partial<MenuTemplateInput> = {}) {
  const dispatch = vi.fn();
  const template = buildMenuTemplate({
    platform: 'linux',
    language: 'id',
    role: null,
    printable: false,
    appName: 'Bengkelin',
    dispatch,
    ...overrides,
  });
  return { template, dispatch };
}

const flat = (items: Item[]): Item[] =>
  items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flat(item.submenu as Item[]) : []),
  ]);
const ids = (items: Item[]) =>
  flat(items)
    .filter((item) => item.visible !== false && item.id)
    .map((item) => item.id as string);
const byId = (items: Item[], id: string) =>
  flat(items).find((item) => item.id === id);
const submenuIds = (items: Item[], id: string) =>
  ((byId(items, id)?.submenu as Item[]) ?? [])
    .filter((item) => item.type !== 'separator' && item.visible !== false)
    .map((item) => item.id);

describe('menu actions', () => {
  test('the action union is finite and validated', () => {
    expect(MENU_ACTIONS).toEqual([
      'newTransaction',
      'print',
      'backupDatabase',
      'searchItem',
      'addCustomItem',
      'saveDraft',
      'finalize',
      'dailyReport',
      'about',
      'openLogFolder',
      'reload',
    ]);
    expect(isMenuAction('finalize')).toBe(true);
    expect(isMenuAction('finalizeNow')).toBe(false);
    expect(isMenuAction(undefined)).toBe(false);
  });
});

describe('structure and role-aware availability', () => {
  test('signed out: only safe items (Exit, Edit, View, About)', () => {
    const { template } = build();
    expect(template.map((m) => m.id)).toEqual([
      'menu-file',
      'menu-edit',
      'menu-view',
      'menu-help',
    ]);
    expect(submenuIds(template, 'menu-file')).toEqual(['exit']);
    expect(submenuIds(template, 'menu-edit')).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'selectAll',
    ]);
    expect(submenuIds(template, 'menu-view')).toEqual([
      'reload',
      'zoomIn',
      'zoomOut',
      'resetZoom',
      'toggleFullScreen',
    ]);
    expect(submenuIds(template, 'menu-help')).toEqual(['about']);
  });

  test('CASHIER: transaction items and shortcuts, no ADMIN-only items', () => {
    const { template } = build({ role: 'CASHIER' });
    expect(template.map((m) => m.id)).toEqual([
      'menu-file',
      'menu-edit',
      'menu-view',
      'menu-transaction',
      'menu-reports',
      'menu-help',
    ]);
    expect(submenuIds(template, 'menu-file')).toEqual([
      'newTransaction',
      'print',
      'exit',
    ]);
    expect(submenuIds(template, 'menu-transaction')).toEqual([
      'searchItem',
      'addCustomItem',
      'saveDraft',
      'finalize',
    ]);
    expect(submenuIds(template, 'menu-reports')).toEqual(['dailyReport']);
    expect(submenuIds(template, 'menu-help')).toEqual(['about']);
    expect(ids(template)).not.toContain('backupDatabase');
    expect(ids(template)).not.toContain('openLogFolder');

    const accelerators = Object.fromEntries(
      flat(template)
        .filter((item) => item.id && item.accelerator)
        .map((item) => [item.id, item.accelerator]),
    );
    expect(accelerators).toMatchObject({
      newTransaction: 'CmdOrCtrl+N',
      print: 'CmdOrCtrl+P',
      searchItem: 'F2',
      saveDraft: 'CmdOrCtrl+S',
      finalize: 'F8',
      reload: 'CmdOrCtrl+R',
    });
  });

  test('ADMIN adds Backup Database and Open Log Folder', () => {
    const { template } = build({ role: 'ADMIN' });
    expect(submenuIds(template, 'menu-file')).toEqual([
      'newTransaction',
      'print',
      'backupDatabase',
      'exit',
    ]);
    expect(submenuIds(template, 'menu-help')).toEqual([
      'about',
      'openLogFolder',
    ]);
  });

  test('Print is enabled only with a printable context', () => {
    expect(byId(build({ role: 'CASHIER' }).template, 'print')?.enabled).toBe(
      false,
    );
    expect(
      byId(build({ role: 'CASHIER', printable: true }).template, 'print')
        ?.enabled,
    ).toBe(true);
  });

  test('macOS: an app menu with About and Quit; File has no Exit', () => {
    const { template } = build({ platform: 'darwin', role: 'CASHIER' });
    expect(template[0]).toMatchObject({ id: 'menu-app', label: 'Bengkelin' });
    expect(submenuIds(template, 'menu-app')).toEqual(
      expect.arrayContaining(['about', 'hide', 'quit']),
    );
    expect(submenuIds(template, 'menu-file')).toEqual([
      'newTransaction',
      'print',
    ]);
    expect(submenuIds(template, 'menu-help')).toEqual([]);
  });
});

describe('dispatch and roles', () => {
  test('custom items dispatch their action; standard items use Electron roles', () => {
    const { template, dispatch } = build({ role: 'ADMIN', printable: true });
    for (const action of MENU_ACTIONS) {
      const item = byId(template, action);
      expect(item, action).toBeDefined();
      (item!.click as () => void)();
    }
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      ...MENU_ACTIONS,
    ]);
    expect(byId(template, 'exit')?.role).toBe('quit');
    expect(byId(template, 'copy')?.role).toBe('copy');
    expect(byId(template, 'zoomIn')?.role).toBe('zoomIn');
    expect(byId(template, 'toggleFullScreen')?.role).toBe('togglefullscreen');
    // Reload is custom: it must flush drafts first, never the raw role.
    expect(byId(template, 'reload')?.role).toBeUndefined();
  });
});

describe('localized labels (id/en)', () => {
  test('labels come from the shell locale files in both languages', () => {
    for (const [language, shell] of [
      ['id', idShell],
      ['en', enShell],
    ] as const) {
      const { template } = build({ role: 'ADMIN', language });
      expect(byId(template, 'menu-transaction')?.label).toBe(
        shell.menu.transaction,
      );
      expect(byId(template, 'finalize')?.label).toBe(shell.menu.finalize);
      expect(byId(template, 'copy')?.label).toBe(shell.menu.copy);
      for (const item of flat(template)) {
        if (item.type === 'separator') continue;
        expect(item.label, String(item.id)).toMatch(/\S/);
      }
    }
    expect(menuLabels('id').file).not.toBe(menuLabels('en').file);
  });
});
