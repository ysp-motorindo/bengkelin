import type { MenuItemConstructorOptions } from 'electron';
import type { Language, Role } from '@/shared/contracts';
import type { MenuAction } from '@/shared/menu';
import { menuLabels } from './menu-labels';

/**
 * The native menu (spec 53) as a pure function of platform, language,
 * role and the renderer's printable context; `menu.ts` turns it into an
 * Electron Menu. Role-aware: before login only safe items (Exit, Edit,
 * View, About); ADMIN-only items (Backup Database, Open Log Folder) exist
 * only for an ADMIN. Hiding is never the control: main enforces
 * authorization for every command anyway.
 *
 * Custom items dispatch a finite MenuAction to the renderer; standard
 * items are Electron roles. Reload is custom (not the `reload` role) so
 * the renderer flushes draft input first.
 */
export interface MenuTemplateInput {
  platform: NodeJS.Platform;
  language: Language;
  /** null: nobody is signed in on the window. */
  role: Role | null;
  /** A committed invoice's print actions are on screen. */
  printable: boolean;
  appName: string;
  dispatch(action: MenuAction): void;
}

type Item = MenuItemConstructorOptions;
const separator: Item = { type: 'separator' };

export function buildMenuTemplate(input: MenuTemplateInput): Item[] {
  const { platform, role, printable, dispatch } = input;
  const L = menuLabels(input.language);
  const signedIn = role !== null;
  const admin = role === 'ADMIN';
  const mac = platform === 'darwin';

  const action = (id: MenuAction, extra: Partial<Item> = {}): Item => ({
    id,
    label: L[id],
    click: () => dispatch(id),
    ...extra,
  });
  const standard = (
    id: keyof typeof L,
    role: NonNullable<Item['role']>,
    extra: Partial<Item> = {},
  ): Item => ({ id, role, label: L[id], ...extra });
  const menu = (id: string, label: string, submenu: Item[]): Item[] =>
    submenu.some((item) => item.type !== 'separator')
      ? [{ id, label, submenu }]
      : [];

  const appMenu: Item[] = mac
    ? menu('menu-app', input.appName, [
        action('about'),
        separator,
        standard('services', 'services'),
        separator,
        standard('hide', 'hide'),
        standard('hideOthers', 'hideOthers'),
        standard('unhide', 'unhide'),
        separator,
        standard('quit', 'quit'),
      ])
    : [];

  const file = menu('menu-file', L.file, [
    ...(signedIn
      ? [
          action('newTransaction', { accelerator: 'CmdOrCtrl+N' }),
          action('print', { accelerator: 'CmdOrCtrl+P', enabled: printable }),
        ]
      : []),
    ...(admin ? [separator, action('backupDatabase')] : []),
    ...(mac ? [] : [separator, standard('exit', 'quit')]),
  ]);

  const edit = menu('menu-edit', L.edit, [
    standard('undo', 'undo'),
    standard('redo', 'redo'),
    separator,
    standard('cut', 'cut'),
    standard('copy', 'copy'),
    standard('paste', 'paste'),
    standard('selectAll', 'selectAll'),
  ]);

  const view = menu('menu-view', L.view, [
    action('reload', { accelerator: 'CmdOrCtrl+R' }),
    separator,
    standard('zoomIn', 'zoomIn'),
    standard('zoomOut', 'zoomOut'),
    standard('resetZoom', 'resetZoom'),
    separator,
    standard('toggleFullScreen', 'togglefullscreen'),
  ]);

  const transaction = signedIn
    ? menu('menu-transaction', L.transaction, [
        action('searchItem', { accelerator: 'F2' }),
        action('addCustomItem'),
        action('saveDraft', { accelerator: 'CmdOrCtrl+S' }),
        separator,
        // Opens the checkout REVIEW only; finalizing is always a separate,
        // explicit confirmation there.
        action('finalize', { accelerator: 'F8' }),
      ])
    : [];

  const reports = signedIn
    ? menu('menu-reports', L.reports, [action('dailyReport')])
    : [];

  const help = menu('menu-help', L.help, [
    ...(mac ? [] : [action('about')]),
    ...(admin ? [action('openLogFolder')] : []),
  ]);

  return [
    ...appMenu,
    ...file,
    ...edit,
    ...view,
    ...transaction,
    ...reports,
    ...help,
  ];
}
