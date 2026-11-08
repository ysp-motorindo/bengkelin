import { contextBridge, ipcRenderer } from 'electron';
import type { BengkelinApi } from './shared/bridge';
import { CHANNELS } from './shared/channels';
import { isMenuAction, type MenuAction } from './shared/menu';

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
  suppliers: Object.freeze({
    search: call(c.suppliers.search),
    get: call(c.suppliers.get),
    save: call(c.suppliers.save),
  }),
  purchaseDrafts: Object.freeze({
    create: call(c.purchaseDrafts.create),
    list: call(c.purchaseDrafts.list),
    get: call(c.purchaseDrafts.get),
    apply: call(c.purchaseDrafts.apply),
  }),
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
    chooseLogo: call(c.settings.chooseLogo),
    removeLogo: call(c.settings.removeLogo),
    getLogo: call(c.settings.getLogo),
  }),
  cashiers: Object.freeze({
    list: call(c.cashiers.list),
    create: call(c.cashiers.create),
    updateDisplayName: call(c.cashiers.updateDisplayName),
    changeRole: call(c.cashiers.changeRole),
    deactivate: call(c.cashiers.deactivate),
    reactivate: call(c.cashiers.reactivate),
    resetPassword: call(c.cashiers.resetPassword),
    listNames: call(c.cashiers.listNames),
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
    deactivate: call(c.vehicles.deactivate),
    reactivate: call(c.vehicles.reactivate),
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
    previewCatalogPrice: call(c.drafts.previewCatalogPrice),
  }),
  adHocReferences: Object.freeze({
    search: call(c.adHocReferences.search),
    list: call(c.adHocReferences.list),
    update: call(c.adHocReferences.update),
    deactivate: call(c.adHocReferences.deactivate),
    reactivate: call(c.adHocReferences.reactivate),
  }),
  invoices: Object.freeze({
    previewFinalize: call(c.invoices.previewFinalize),
    finalize: call(c.invoices.finalize),
    get: call(c.invoices.get),
    recordPayment: call(c.invoices.recordPayment),
    void: call(c.invoices.void),
    search: call(c.invoices.search),
    receivables: call(c.invoices.receivables),
  }),
  printing: Object.freeze({
    preview: call(c.printing.preview),
    print: call(c.printing.print),
    exportPdf: call(c.printing.exportPdf),
    getOptions: call(c.printing.getOptions),
    listPrinters: call(c.printing.listPrinters),
    getSettings: call(c.printing.getSettings),
    updateSettings: call(c.printing.updateSettings),
  }),
  reports: Object.freeze({
    daily: call(c.reports.daily),
    preview: call(c.reports.preview),
    print: call(c.reports.print),
    exportCsv: call(c.reports.exportCsv),
  }),
  referenceTransfer: Object.freeze({
    previewImport: call(c.referenceTransfer.previewImport),
    commitImport: call(c.referenceTransfer.commitImport),
    downloadTemplate: call(c.referenceTransfer.downloadTemplate),
  }),
  customerReceivables: Object.freeze({
    previewImport: call(c.customerReceivables.previewImport),
    commitImport: call(c.customerReceivables.commitImport),
    list: call(c.customerReceivables.list),
    get: call(c.customerReceivables.get),
    recordPayment: call(c.customerReceivables.recordPayment),
  }),
  customerTransfer: Object.freeze({
    previewImport: call(c.customerTransfer.previewImport),
    commitImport: call(c.customerTransfer.commitImport),
  }),
  catalogTransfer: Object.freeze({
    previewImport: call(c.catalogTransfer.previewImport),
    commitImport: call(c.catalogTransfer.commitImport),
    exportCatalog: call(c.catalogTransfer.exportCatalog),
    downloadTemplate: call(c.catalogTransfer.downloadTemplate),
  }),
  backups: Object.freeze({
    create: call(c.backups.create),
    status: call(c.backups.status),
    chooseDestination: call(c.backups.chooseDestination),
    inspectRestore: call(c.backups.inspectRestore),
    restore: call(c.backups.restore),
    cancelRestore: call(c.backups.cancelRestore),
    takeRestoreNotice: call(c.backups.takeRestoreNotice),
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
    about: call(c.app.about),
    setMenuContext: call(c.app.setMenuContext),
    // One fixed channel, main -> renderer; only the finite MenuAction values
    // pass, and the callback never sees the IPC event object.
    onMenuAction: (callback: (action: MenuAction) => void) => {
      const listener = (_event: unknown, action: unknown) => {
        if (isMenuAction(action)) callback(action);
      };
      ipcRenderer.on(c.app.menuAction, listener);
      return () => {
        ipcRenderer.removeListener(c.app.menuAction, listener);
      };
    },
  }),
});

contextBridge.exposeInMainWorld('bengkelin', api);
