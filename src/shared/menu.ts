/**
 * Native menu actions (spec 53). Main sends exactly these over one fixed
 * channel (`CHANNELS.app.menuAction`); the preload drops anything else and
 * the renderer dispatches them to existing application APIs. Standard
 * items (Edit, Zoom, Full Screen, Exit) are Electron roles and never reach
 * the renderer.
 */
export const MENU_ACTIONS = [
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
] as const;

export type MenuAction = (typeof MENU_ACTIONS)[number];

const ACTIONS: ReadonlySet<string> = new Set(MENU_ACTIONS);

export function isMenuAction(value: unknown): value is MenuAction {
  return typeof value === 'string' && ACTIONS.has(value);
}
