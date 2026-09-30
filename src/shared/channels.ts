/**
 * IPC channel names, shared by preload (caller) and main (handlers) so the two
 * can never drift. Add new channels here first.
 */
export const CHANNELS = {
  app: {
    ping: 'bengkelin:app:ping',
    openLogFolder: 'bengkelin:app:openLogFolder',
  },
  auth: {
    login: 'bengkelin:auth:login',
    logout: 'bengkelin:auth:logout',
    currentSession: 'bengkelin:auth:currentSession',
  },
  settings: {
    getPublic: 'bengkelin:settings:getPublic',
    completeSetup: 'bengkelin:settings:completeSetup',
    updateShop: 'bengkelin:settings:updateShop',
    updatePreferences: 'bengkelin:settings:updatePreferences',
  },
  cashiers: {
    list: 'bengkelin:cashiers:list',
    create: 'bengkelin:cashiers:create',
    updateDisplayName: 'bengkelin:cashiers:updateDisplayName',
    changeRole: 'bengkelin:cashiers:changeRole',
    deactivate: 'bengkelin:cashiers:deactivate',
    reactivate: 'bengkelin:cashiers:reactivate',
    resetPassword: 'bengkelin:cashiers:resetPassword',
  },
  references: {
    listActive: 'bengkelin:references:listActive',
    list: 'bengkelin:references:list',
    save: 'bengkelin:references:save',
    deactivate: 'bengkelin:references:deactivate',
    reactivate: 'bengkelin:references:reactivate',
  },
  customers: {
    search: 'bengkelin:customers:search',
    get: 'bengkelin:customers:get',
    save: 'bengkelin:customers:save',
  },
  vehicles: {
    searchByPlate: 'bengkelin:vehicles:searchByPlate',
    get: 'bengkelin:vehicles:get',
    save: 'bengkelin:vehicles:save',
    transferOwnership: 'bengkelin:vehicles:transferOwnership',
  },
  catalog: {
    search: 'bengkelin:catalog:search',
    get: 'bengkelin:catalog:get',
    save: 'bengkelin:catalog:save',
    saveBarcodes: 'bengkelin:catalog:saveBarcodes',
    lookupBarcode: 'bengkelin:catalog:lookupBarcode',
    listPrices: 'bengkelin:catalog:listPrices',
    previewPriceChange: 'bengkelin:catalog:previewPriceChange',
    applyPriceChange: 'bengkelin:catalog:applyPriceChange',
  },
} as const;
