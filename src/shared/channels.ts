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
} as const;
