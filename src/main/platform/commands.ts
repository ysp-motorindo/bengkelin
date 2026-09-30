import { CHANNELS } from '@/shared/channels';
import {
  adjustStockInputSchema,
  applyPriceChangeInputSchema,
  cashierIdInputSchema,
  createDraftInputSchema,
  draftCommandSchema,
  draftIdSchema,
  previewPriceRefreshInputSchema,
  searchAdHocReferencesInputSchema,
  catalogIdInputSchema,
  changeRoleInputSchema,
  createCashierInputSchema,
  customerIdInputSchema,
  listPricesInputSchema,
  listStockInputSchema,
  listReferencesInputSchema,
  loginInputSchema,
  lookupBarcodeInputSchema,
  noInput,
  openBalanceInputSchema,
  preferencesInputSchema,
  priceChangeInputSchema,
  receiveStockInputSchema,
  referenceIdInputSchema,
  resetPasswordInputSchema,
  saveBarcodesInputSchema,
  saveCatalogItemInputSchema,
  saveCustomerInputSchema,
  saveReferenceInputSchema,
  saveVehicleInputSchema,
  searchCatalogInputSchema,
  searchCustomersInputSchema,
  searchVehiclesInputSchema,
  setStockInputSchema,
  setupInputSchema,
  shopSettingsInputSchema,
  stockHistoryInputSchema,
  stockItemInputSchema,
  transferOwnershipInputSchema,
  updateDisplayNameInputSchema,
  vehicleIdInputSchema,
} from '@/shared/contracts';
import { command, type Command } from './command';
import type { ApplicationServices } from './services';

/**
 * The application's whole command surface: channel + Zod schema + handler.
 * Handlers are one-liners that resolve the caller's session from the window
 * and delegate to a service; services enforce authorization and return DTOs.
 * Add a feature by appending its commands here (and its channels/bridge/preload).
 */
export function buildCommands(services: ApplicationServices): Command[] {
  const {
    auth,
    settings,
    cashiers,
    references,
    customers,
    vehicles,
    catalog,
    inventory,
    drafts,
    adHocReferences,
    app,
    sessions,
  } = services;
  const C = CHANNELS;
  const session = (windowId: number) => sessions.get(windowId);

  return [
    command(C.app.ping, noInput, () => 'pong'),
    command(C.app.openLogFolder, noInput, ({ windowId }) =>
      app.openLogFolder(session(windowId)),
    ),

    command(C.auth.login, loginInputSchema, ({ windowId }, input) =>
      auth.login(input, windowId),
    ),
    command(C.auth.logout, noInput, ({ windowId }) => auth.logout(windowId)),
    command(C.auth.currentSession, noInput, ({ windowId }) =>
      auth.currentSession(session(windowId)),
    ),

    command(C.settings.getPublic, noInput, () => settings.getPublic()),
    command(C.settings.getShop, noInput, ({ windowId }) =>
      settings.getShop(session(windowId)),
    ),
    command(C.settings.completeSetup, setupInputSchema, (_ctx, input) =>
      settings.completeSetup(input),
    ),
    command(
      C.settings.updateShop,
      shopSettingsInputSchema,
      ({ windowId }, input) => settings.updateShop(session(windowId), input),
    ),
    command(
      C.settings.updatePreferences,
      preferencesInputSchema,
      ({ windowId }, input) =>
        settings.updatePreferences(session(windowId), input),
    ),

    command(C.cashiers.list, noInput, ({ windowId }) =>
      cashiers.list(session(windowId)),
    ),
    command(
      C.cashiers.create,
      createCashierInputSchema,
      ({ windowId }, input) => cashiers.create(session(windowId), input),
    ),
    command(
      C.cashiers.updateDisplayName,
      updateDisplayNameInputSchema,
      ({ windowId }, input) =>
        cashiers.updateDisplayName(session(windowId), input),
    ),
    command(
      C.cashiers.changeRole,
      changeRoleInputSchema,
      ({ windowId }, input) => cashiers.changeRole(session(windowId), input),
    ),
    command(
      C.cashiers.deactivate,
      cashierIdInputSchema,
      ({ windowId }, input) => cashiers.deactivate(session(windowId), input),
    ),
    command(
      C.cashiers.reactivate,
      cashierIdInputSchema,
      ({ windowId }, input) => cashiers.reactivate(session(windowId), input),
    ),
    command(
      C.cashiers.resetPassword,
      resetPasswordInputSchema,
      ({ windowId }, input) => cashiers.resetPassword(session(windowId), input),
    ),

    command(
      C.references.listActive,
      listReferencesInputSchema,
      ({ windowId }, input) => references.listActive(session(windowId), input),
    ),
    command(
      C.references.list,
      listReferencesInputSchema,
      ({ windowId }, input) => references.list(session(windowId), input),
    ),
    command(
      C.references.save,
      saveReferenceInputSchema,
      ({ windowId }, input) => references.save(session(windowId), input),
    ),
    command(
      C.references.deactivate,
      referenceIdInputSchema,
      ({ windowId }, input) => references.deactivate(session(windowId), input),
    ),
    command(
      C.references.reactivate,
      referenceIdInputSchema,
      ({ windowId }, input) => references.reactivate(session(windowId), input),
    ),

    command(
      C.customers.search,
      searchCustomersInputSchema,
      ({ windowId }, input) => customers.search(session(windowId), input),
    ),
    command(C.customers.get, customerIdInputSchema, ({ windowId }, input) =>
      customers.get(session(windowId), input),
    ),
    command(C.customers.save, saveCustomerInputSchema, ({ windowId }, input) =>
      customers.save(session(windowId), input),
    ),

    command(
      C.vehicles.searchByPlate,
      searchVehiclesInputSchema,
      ({ windowId }, input) => vehicles.searchByPlate(session(windowId), input),
    ),
    command(C.vehicles.get, vehicleIdInputSchema, ({ windowId }, input) =>
      vehicles.get(session(windowId), input),
    ),
    command(C.vehicles.save, saveVehicleInputSchema, ({ windowId }, input) =>
      vehicles.save(session(windowId), input),
    ),
    command(
      C.vehicles.transferOwnership,
      transferOwnershipInputSchema,
      ({ windowId }, input) =>
        vehicles.transferOwnership(session(windowId), input),
    ),

    command(C.catalog.search, searchCatalogInputSchema, ({ windowId }, input) =>
      catalog.search(session(windowId), input),
    ),
    command(C.catalog.get, catalogIdInputSchema, ({ windowId }, input) =>
      catalog.get(session(windowId), input),
    ),
    command(C.catalog.save, saveCatalogItemInputSchema, ({ windowId }, input) =>
      catalog.save(session(windowId), input),
    ),
    command(
      C.catalog.saveBarcodes,
      saveBarcodesInputSchema,
      ({ windowId }, input) => catalog.saveBarcodes(session(windowId), input),
    ),
    command(
      C.catalog.lookupBarcode,
      lookupBarcodeInputSchema,
      ({ windowId }, input) => catalog.lookupBarcode(session(windowId), input),
    ),
    command(
      C.catalog.listPrices,
      listPricesInputSchema,
      ({ windowId }, input) => catalog.listPrices(session(windowId), input),
    ),
    command(
      C.catalog.previewPriceChange,
      priceChangeInputSchema,
      ({ windowId }, input) =>
        catalog.previewPriceChange(session(windowId), input),
    ),
    command(
      C.catalog.applyPriceChange,
      applyPriceChangeInputSchema,
      ({ windowId }, input) =>
        catalog.applyPriceChange(session(windowId), input.token),
    ),

    command(C.inventory.getStock, stockItemInputSchema, ({ windowId }, input) =>
      inventory.getStock(session(windowId), input),
    ),
    command(
      C.inventory.listStock,
      listStockInputSchema,
      ({ windowId }, input) => inventory.listStock(session(windowId), input),
    ),
    command(
      C.inventory.history,
      stockHistoryInputSchema,
      ({ windowId }, input) => inventory.history(session(windowId), input),
    ),
    command(
      C.inventory.openBalance,
      openBalanceInputSchema,
      ({ windowId }, input) => inventory.openBalance(session(windowId), input),
    ),
    command(
      C.inventory.receive,
      receiveStockInputSchema,
      ({ windowId }, input) => inventory.receive(session(windowId), input),
    ),
    command(C.inventory.adjust, adjustStockInputSchema, ({ windowId }, input) =>
      inventory.adjust(session(windowId), input),
    ),
    command(C.inventory.setStock, setStockInputSchema, ({ windowId }, input) =>
      inventory.setStock(session(windowId), input),
    ),

    command(C.drafts.create, createDraftInputSchema, ({ windowId }, input) =>
      drafts.create(session(windowId), input),
    ),
    command(C.drafts.list, noInput, ({ windowId }) =>
      drafts.list(session(windowId)),
    ),
    command(C.drafts.get, draftIdSchema, ({ windowId }, id) =>
      drafts.get(session(windowId), id),
    ),
    command(C.drafts.apply, draftCommandSchema, ({ windowId }, input) =>
      drafts.apply(session(windowId), input),
    ),
    command(
      C.drafts.previewPriceRefresh,
      previewPriceRefreshInputSchema,
      ({ windowId }, input) =>
        drafts.previewPriceRefresh(session(windowId), input),
    ),
    command(
      C.adHocReferences.search,
      searchAdHocReferencesInputSchema,
      ({ windowId }, input) => adHocReferences.search(session(windowId), input),
    ),
  ];
}
