import { contextBridge, ipcRenderer } from 'electron';
import type { BengkelinApi } from './shared/bridge';
import { CHANNELS } from './shared/channels';

// The only surface the renderer sees. Feature tasks add named methods here;
// nothing generic (no raw ipcRenderer) is ever exposed. Main validates every
// payload, so the preload is a thin, typed forwarder.
// Result types come from BengkelinApi; `invoke` is untyped at the boundary.
const call =
  (channel: string) =>
  (input?: unknown): Promise<never> =>
    ipcRenderer.invoke(channel, input) as Promise<never>;

const c = CHANNELS;
const api: BengkelinApi = Object.freeze({
  auth: Object.freeze({
    login: call(c.auth.login),
    logout: call(c.auth.logout),
    currentSession: call(c.auth.currentSession),
  }),
  settings: Object.freeze({
    getPublic: call(c.settings.getPublic),
    completeSetup: call(c.settings.completeSetup),
    updateShop: call(c.settings.updateShop),
    updatePreferences: call(c.settings.updatePreferences),
  }),
  cashiers: Object.freeze({
    list: call(c.cashiers.list),
    create: call(c.cashiers.create),
    updateDisplayName: call(c.cashiers.updateDisplayName),
    changeRole: call(c.cashiers.changeRole),
    deactivate: call(c.cashiers.deactivate),
    reactivate: call(c.cashiers.reactivate),
    resetPassword: call(c.cashiers.resetPassword),
  }),
  app: Object.freeze({
    openLogFolder: call(c.app.openLogFolder),
  }),
});

contextBridge.exposeInMainWorld('bengkelin', api);
