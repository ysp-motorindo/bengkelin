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
    getShop: call(c.settings.getShop),
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
  references: Object.freeze({
    listActive: call(c.references.listActive),
    list: call(c.references.list),
    save: call(c.references.save),
    deactivate: call(c.references.deactivate),
    reactivate: call(c.references.reactivate),
  }),
  customers: Object.freeze({
    search: call(c.customers.search),
    get: call(c.customers.get),
    save: call(c.customers.save),
  }),
  vehicles: Object.freeze({
    searchByPlate: call(c.vehicles.searchByPlate),
    get: call(c.vehicles.get),
    save: call(c.vehicles.save),
    transferOwnership: call(c.vehicles.transferOwnership),
  }),
  catalog: Object.freeze({
    search: call(c.catalog.search),
    get: call(c.catalog.get),
    save: call(c.catalog.save),
    saveBarcodes: call(c.catalog.saveBarcodes),
    lookupBarcode: call(c.catalog.lookupBarcode),
    listPrices: call(c.catalog.listPrices),
    previewPriceChange: call(c.catalog.previewPriceChange),
    applyPriceChange: call(c.catalog.applyPriceChange),
  }),
  inventory: Object.freeze({
    getStock: call(c.inventory.getStock),
    listStock: call(c.inventory.listStock),
    history: call(c.inventory.history),
    openBalance: call(c.inventory.openBalance),
    receive: call(c.inventory.receive),
    adjust: call(c.inventory.adjust),
    setStock: call(c.inventory.setStock),
  }),
  drafts: Object.freeze({
    create: call(c.drafts.create),
    list: call(c.drafts.list),
    get: call(c.drafts.get),
    apply: call(c.drafts.apply),
    previewPriceRefresh: call(c.drafts.previewPriceRefresh),
  }),
  adHocReferences: Object.freeze({
    search: call(c.adHocReferences.search),
  }),
  invoices: Object.freeze({
    previewFinalize: call(c.invoices.previewFinalize),
    finalize: call(c.invoices.finalize),
    get: call(c.invoices.get),
  }),
  app: Object.freeze({
    openLogFolder: call(c.app.openLogFolder),
    // The callback never sees the IPC event object.
    onBeforeClose: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(c.app.beforeClose, listener);
      return () => {
        ipcRenderer.removeListener(c.app.beforeClose, listener);
      };
    },
    readyToClose: () => {
      ipcRenderer.send(c.app.readyToClose);
    },
  }),
});

contextBridge.exposeInMainWorld('bengkelin', api);
