import { Menu, type BrowserWindow } from 'electron';
import { CHANNELS } from '@/shared/channels';
import type { Language } from '@/shared/contracts';
import type { MenuAction } from '@/shared/menu';
import { buildMenuTemplate } from './menu-template';
import type { ApplicationServices } from './services';
import { isTrustedAppUrl } from './trust';
import { getTrustedAppLocation } from './window';

/** Commands after which the menu is rebuilt (language, role, sign-in). */
export const MENU_REFRESH_CHANNELS: ReadonlySet<string> = new Set([
  CHANNELS.auth.login,
  CHANNELS.auth.logout,
  CHANNELS.settings.completeSetup,
  CHANNELS.settings.updatePreferences,
  CHANNELS.cashiers.changeRole,
  CHANNELS.cashiers.deactivate,
  CHANNELS.cashiers.resetPassword,
]);

/** A renderer that never reloads after a Reload request is reloaded anyway. */
export const RELOAD_FLUSH_TIMEOUT_MS = 3000;

export interface ApplicationMenu {
  refresh(): void;
  dispose(): void;
}

/**
 * The application menu for the main window (spec 53). Rebuilt from the
 * window's session (role), the shop language and the renderer's printable
 * context whenever one of them changes. Chosen custom items are sent to the
 * window's own trusted document on ONE fixed channel as a finite
 * MenuAction; the renderer dispatches them to existing APIs, which main
 * authorizes as always.
 */
export function installApplicationMenu(deps: {
  window: BrowserWindow;
  services: ApplicationServices;
  appName: string;
  platform?: NodeJS.Platform;
}): ApplicationMenu {
  const { window, services } = deps;
  const windowId = window.webContents.id;
  let language: Language = 'id';
  let disposed = false;

  function send(action: MenuAction): void {
    if (window.isDestroyed()) return;
    const contents = window.webContents;
    if (action === 'reload' && contents.isCrashed()) {
      contents.reload();
      return;
    }
    // Only the app's own top-level document ever receives menu actions.
    if (!isTrustedAppUrl(contents.getURL(), getTrustedAppLocation())) return;
    if (action === 'reload') {
      // Ruling: Reload goes through the draft flush first. The renderer
      // flushes and reloads itself; if it cannot (hung), reload anyway.
      const timer = setTimeout(() => {
        if (!contents.isDestroyed()) contents.reload();
      }, RELOAD_FLUSH_TIMEOUT_MS);
      contents.once('did-start-loading', () => clearTimeout(timer));
    }
    contents.send(CHANNELS.app.menuAction, action);
  }

  function refresh(): void {
    if (disposed || window.isDestroyed()) return;
    const session = services.sessions.get(windowId);
    try {
      language = session?.language ?? services.settings.getPublic().language;
    } catch {
      // Database closed (restore in progress): keep the last language.
    }
    const template = buildMenuTemplate({
      platform: deps.platform ?? process.platform,
      language,
      role: session?.role ?? null,
      printable: services.menu.get(windowId).printable,
      appName: deps.appName,
      dispatch: send,
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  const onWindow = (changed: number) => {
    if (changed === windowId) refresh();
  };
  const unsubscribe = [
    services.sessions.onChange(onWindow),
    services.menu.onChange(onWindow),
  ];
  refresh();

  return {
    refresh,
    dispose() {
      disposed = true;
      for (const stop of unsubscribe) stop();
    },
  };
}
