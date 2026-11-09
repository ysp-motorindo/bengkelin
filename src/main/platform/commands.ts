import { commitSupplierImportInputSchema } from '@/shared/contracts';
import {
  supplierOpeningListInputSchema,
  supplierOpeningInputSchema,
  recordSupplierOpeningPaymentInputSchema,
} from '@/shared/contracts';
import { purchasePrintInputSchema } from '@/shared/contracts';
import {
  receivePurchaseInputSchema,
  reversePurchaseReceiptInputSchema,
  purchaseCreditInputSchema,
  previewPurchaseCreditInputSchema,
  previewPurchaseReceiptReversalInputSchema,
} from '@/shared/contracts';
import {
  finalizePurchaseInputSchema,
  purchaseMoneyInputSchema,
  voidPurchaseInputSchema,
  searchPurchasesInputSchema,
} from '@/shared/contracts';
import {
  searchSuppliersInputSchema,
  supplierIdInputSchema,
  saveSupplierInputSchema,
  createPurchaseDraftInputSchema,
  purchaseIdInputSchema,
  purchaseDraftCommandSchema,
} from '@/shared/contracts';
import { commitOpeningImportInputSchema } from '@/shared/contracts';
import {
  openingListInputSchema,
  openingCustomerInputSchema,
  recordOpeningPaymentInputSchema,
} from '@/shared/contracts';
import {
  referenceTransferInputSchema,
  commitReferenceImportInputSchema,
} from '@/shared/contracts';
import { CHANNELS } from '@/shared/channels';
import {
  finalizeInputSchema,
  dailyReportInputSchema,
  invoiceIdInputSchema,
  invoiceSearchInputSchema,
  receivablesInputSchema,
  recordPaymentInputSchema,
  voidInvoiceInputSchema,
  exportPdfInputSchema,
  printInputSchema,
  printSettingsInputSchema,
  previewFinalizeInputSchema,
  adjustStockInputSchema,
  applyPriceChangeInputSchema,
  cashierIdInputSchema,
  createDraftInputSchema,
  draftCommandSchema,
  draftIdSchema,
  previewCatalogPriceInputSchema,
  previewPriceRefreshInputSchema,
  searchAdHocReferencesInputSchema,
  catalogIdInputSchema,
  commitImportInputSchema,
  exportCatalogInputSchema,
  commitCustomerImportInputSchema,
  cancelRestoreInputSchema,
  restoreInputSchema,
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
  menuContextInputSchema,
  listAdHocReferencesInputSchema,
  updateAdHocReferenceInputSchema,
  adHocReferenceIdInputSchema,
} from '@/shared/contracts';
import { command, type Command } from './command';
import type { MaintenanceGate } from './maintenance';
import type { ApplicationServices } from './services';

const C = CHANNELS;

/**
 * Commands that only read the database (or nothing at all). They keep
 * working while a restore blocks writes. Every other command is treated as
 * mutating: a new channel is blocked during a restore unless listed here.
 */
const READ_ONLY_CHANNELS: ReadonlySet<string> = new Set([
  C.purchasePrinting.preview,
  C.purchases.previewCredit,
  C.purchases.previewReceiptReversal,
  C.purchases.previewFinalize,
  C.purchases.get,
  C.purchases.search,
  C.suppliers.search,
  C.suppliers.get,
  C.purchaseDrafts.list,
  C.purchaseDrafts.get,
  C.app.ping,
  C.app.openLogFolder,
  C.app.about,
  // UI state only (no database).
  C.app.setMenuContext,
  C.auth.currentSession,
  C.settings.getPublic,
  C.settings.getShop,
  C.settings.getLogo,
  C.cashiers.list,
  C.cashiers.listNames,
  C.references.listActive,
  C.references.list,
  C.customers.search,
  C.customers.get,
  C.supplierPayables.list,
  C.supplierPayables.get,
  C.customerReceivables.list,
  C.customerReceivables.get,
  C.vehicles.searchByPlate,
  C.vehicles.get,
  C.catalog.search,
  C.catalog.get,
  C.catalog.lookupBarcode,
  C.catalog.listPrices,
  C.inventory.getStock,
  C.inventory.listStock,
  C.inventory.history,
  C.drafts.list,
  C.drafts.get,
  C.drafts.previewCatalogPrice,
  C.adHocReferences.search,
  C.adHocReferences.list,
  C.invoices.previewFinalize,
  C.invoices.get,
  C.invoices.search,
  C.invoices.receivables,
  C.printing.preview,
  C.printing.getOptions,
  C.printing.listPrinters,
  C.printing.getSettings,
  C.reports.daily,
  C.reports.preview,
  C.backups.status,
]);

/** Guards itself: it is the command that sets the maintenance flag. */
const SELF_GUARDED_CHANNELS: ReadonlySet<string> = new Set([C.backups.restore]);

/**
 * The maintenance gate (T16 restore): reads are refused only once the live
 * connection is closed; mutating commands are refused as soon as a restore
 * starts, and running ones are tracked so the restore can wait for them.
 */
function guarded(cmd: Command, maintenance: MaintenanceGate): Command {
  if (
    READ_ONLY_CHANNELS.has(cmd.channel) ||
    SELF_GUARDED_CHANNELS.has(cmd.channel)
  ) {
    return {
      ...cmd,
      handler: (context, input) => {
        maintenance.assertReadable();
        return cmd.handler(context, input);
      },
    };
  }
  return {
    ...cmd,
    handler: (context, input) =>
      maintenance.runWrite(() => cmd.handler(context, input)),
  };
}

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
    invoices,
    printing,
    reports,
    logo,
    backups,
    restore,
    catalogTransfer,
    referenceTransfer,
    customerReceivables,
    supplierPayables,
    customerTransfer,
    supplierTransfer,
    app,
    menu,
    restoreNotice,
    sessions,
    maintenance,
  } = services;
  const session = (windowId: number) => sessions.get(windowId);

  const commands: Command[] = [
    command(
      C.purchasePrinting.preview,
      purchasePrintInputSchema,
      ({ windowId }, input) =>
        services.purchasePrinting.preview(session(windowId), input),
    ),
    command(
      C.purchasePrinting.print,
      purchasePrintInputSchema,
      ({ windowId }, input) =>
        services.purchasePrinting.print(session(windowId), input),
    ),
    command(
      C.purchasePrinting.exportPdf,
      purchasePrintInputSchema,
      ({ windowId }, input) =>
        services.purchasePrinting.exportPdf(session(windowId), input),
    ),

    command(
      C.purchases.receive,
      receivePurchaseInputSchema,
      ({ windowId }, input) =>
        services.purchases.receive(session(windowId), input),
    ),
    command(
      C.purchases.reverseReceipt,
      reversePurchaseReceiptInputSchema,
      ({ windowId }, input) =>
        services.purchases.reverseReceipt(session(windowId), input),
    ),
    command(
      C.purchases.credit,
      purchaseCreditInputSchema,
      ({ windowId }, input) =>
        services.purchases.credit(session(windowId), input),
    ),
    command(
      C.purchases.previewCredit,
      previewPurchaseCreditInputSchema,
      ({ windowId }, input) =>
        services.purchases.previewCredit(session(windowId), input),
    ),
    command(
      C.purchases.previewReceiptReversal,
      previewPurchaseReceiptReversalInputSchema,
      ({ windowId }, input) =>
        services.purchases.previewReceiptReversal(session(windowId), input),
    ),

    command(
      C.purchases.previewFinalize,
      purchaseIdInputSchema,
      ({ windowId }, input) =>
        services.purchases.previewFinalize(session(windowId), input),
    ),
    command(
      C.purchases.finalize,
      finalizePurchaseInputSchema,
      ({ windowId }, input) =>
        services.purchases.finalize(session(windowId), input),
    ),
    command(C.purchases.get, purchaseIdInputSchema, ({ windowId }, input) =>
      services.purchases.get(session(windowId), input),
    ),
    command(
      C.purchases.search,
      searchPurchasesInputSchema,
      ({ windowId }, input) =>
        services.purchases.search(session(windowId), input),
    ),
    command(
      C.purchases.recordPayment,
      purchaseMoneyInputSchema,
      ({ windowId }, input) =>
        services.purchases.recordPayment(session(windowId), input),
    ),
    command(
      C.purchases.recordRefund,
      purchaseMoneyInputSchema,
      ({ windowId }, input) =>
        services.purchases.recordRefund(session(windowId), input),
    ),
    command(C.purchases.void, voidPurchaseInputSchema, ({ windowId }, input) =>
      services.purchases.void(session(windowId), input),
    ),

    command(
      C.suppliers.search,
      searchSuppliersInputSchema,
      ({ windowId }, input) =>
        services.suppliers.search(session(windowId), input),
    ),
    command(C.suppliers.get, supplierIdInputSchema, ({ windowId }, input) =>
      services.suppliers.get(session(windowId), input),
    ),
    command(C.suppliers.save, saveSupplierInputSchema, ({ windowId }, input) =>
      services.suppliers.save(session(windowId), input),
    ),
    command(
      C.purchaseDrafts.create,
      createPurchaseDraftInputSchema,
      ({ windowId }, input) =>
        services.purchaseDrafts.create(session(windowId), input),
    ),
    command(C.purchaseDrafts.list, noInput, ({ windowId }) =>
      services.purchaseDrafts.list(session(windowId)),
    ),
    command(
      C.purchaseDrafts.get,
      purchaseIdInputSchema,
      ({ windowId }, input) =>
        services.purchaseDrafts.get(session(windowId), input),
    ),
    command(
      C.purchaseDrafts.apply,
      purchaseDraftCommandSchema,
      ({ windowId }, input) =>
        services.purchaseDrafts.apply(session(windowId), input),
    ),

    command(C.app.ping, noInput, () => 'pong'),
    command(C.app.openLogFolder, noInput, ({ windowId }) =>
      app.openLogFolder(session(windowId)),
    ),
    command(C.app.about, noInput, () => app.about()),
    command(
      C.app.setMenuContext,
      menuContextInputSchema,
      ({ windowId }, input) => menu.report(session(windowId), windowId, input),
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

    command(C.settings.chooseLogo, noInput, ({ windowId }) =>
      logo.chooseLogo(session(windowId)),
    ),
    command(C.settings.removeLogo, noInput, ({ windowId }) =>
      logo.removeLogo(session(windowId)),
    ),
    command(C.settings.getLogo, noInput, ({ windowId }) =>
      logo.getLogo(session(windowId)),
    ),

    command(C.cashiers.list, noInput, ({ windowId }) =>
      cashiers.list(session(windowId)),
    ),
    command(C.cashiers.listNames, noInput, ({ windowId }) =>
      cashiers.listNames(session(windowId)),
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
    command(
      C.vehicles.deactivate,
      vehicleIdInputSchema,
      ({ windowId }, input) => vehicles.deactivate(session(windowId), input),
    ),
    command(
      C.vehicles.reactivate,
      vehicleIdInputSchema,
      ({ windowId }, input) => vehicles.reactivate(session(windowId), input),
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

    command(
      C.drafts.previewCatalogPrice,
      previewCatalogPriceInputSchema,
      ({ windowId }, input) =>
        drafts.previewCatalogPrice(session(windowId), input),
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
    command(
      C.adHocReferences.list,
      listAdHocReferencesInputSchema,
      ({ windowId }, input) => adHocReferences.list(session(windowId), input),
    ),
    command(
      C.adHocReferences.update,
      updateAdHocReferenceInputSchema,
      ({ windowId }, input) => adHocReferences.update(session(windowId), input),
    ),
    command(
      C.adHocReferences.deactivate,
      adHocReferenceIdInputSchema,
      ({ windowId }, input) =>
        adHocReferences.deactivate(session(windowId), input),
    ),
    command(
      C.adHocReferences.reactivate,
      adHocReferenceIdInputSchema,
      ({ windowId }, input) =>
        adHocReferences.reactivate(session(windowId), input),
    ),

    command(
      C.invoices.previewFinalize,
      previewFinalizeInputSchema,
      ({ windowId }, input) =>
        invoices.previewFinalize(session(windowId), input),
    ),
    command(C.invoices.finalize, finalizeInputSchema, ({ windowId }, input) =>
      invoices.finalize(session(windowId), input),
    ),
    command(C.invoices.get, invoiceIdInputSchema, ({ windowId }, input) =>
      invoices.get(session(windowId), input),
    ),
    command(
      C.invoices.recordPayment,
      recordPaymentInputSchema,
      ({ windowId }, input) => invoices.recordPayment(session(windowId), input),
    ),
    command(C.invoices.void, voidInvoiceInputSchema, ({ windowId }, input) =>
      invoices.void(session(windowId), input),
    ),
    command(
      C.invoices.search,
      invoiceSearchInputSchema,
      ({ windowId }, input) => invoices.search(session(windowId), input),
    ),
    command(
      C.invoices.receivables,
      receivablesInputSchema,
      ({ windowId }, input) => invoices.receivables(session(windowId), input),
    ),

    command(C.printing.preview, printInputSchema, ({ windowId }, input) =>
      printing.preview(session(windowId), input),
    ),
    command(C.printing.print, printInputSchema, ({ windowId }, input) =>
      printing.print(session(windowId), input),
    ),
    command(C.printing.exportPdf, exportPdfInputSchema, ({ windowId }, input) =>
      printing.exportPdf(session(windowId), input),
    ),
    command(C.printing.getOptions, noInput, ({ windowId }) =>
      printing.getOptions(session(windowId)),
    ),
    command(C.printing.listPrinters, noInput, ({ windowId }) =>
      printing.listPrinters(session(windowId)),
    ),
    command(C.printing.getSettings, noInput, ({ windowId }) =>
      printing.getSettings(session(windowId)),
    ),
    command(
      C.printing.updateSettings,
      printSettingsInputSchema,
      ({ windowId }, input) =>
        printing.updateSettings(session(windowId), input),
    ),

    command(C.reports.daily, dailyReportInputSchema, ({ windowId }, input) =>
      reports.daily(session(windowId), input),
    ),
    command(C.reports.preview, dailyReportInputSchema, ({ windowId }, input) =>
      reports.preview(session(windowId), input),
    ),
    command(C.reports.print, dailyReportInputSchema, ({ windowId }, input) =>
      reports.print(session(windowId), input),
    ),
    command(
      C.reports.exportCsv,
      dailyReportInputSchema,
      ({ windowId }, input) => reports.exportCsv(session(windowId), input),
    ),

    command(
      C.referenceTransfer.previewImport,
      referenceTransferInputSchema,
      ({ windowId }, input) =>
        referenceTransfer.previewImport(session(windowId), input),
    ),
    command(
      C.referenceTransfer.commitImport,
      commitReferenceImportInputSchema,
      ({ windowId }, input) =>
        referenceTransfer.commitImport(session(windowId), input),
    ),
    command(
      C.referenceTransfer.downloadTemplate,
      referenceTransferInputSchema,
      ({ windowId }, input) =>
        referenceTransfer.downloadTemplate(session(windowId), input),
    ),
    command(C.customerReceivables.previewImport, noInput, ({ windowId }) =>
      customerReceivables.previewImport(session(windowId)),
    ),
    command(
      C.customerReceivables.commitImport,
      commitOpeningImportInputSchema,
      ({ windowId }, input) =>
        customerReceivables.commitImport(session(windowId), input),
    ),
    command(
      C.customerReceivables.list,
      openingListInputSchema,
      ({ windowId }, input) =>
        customerReceivables.list(session(windowId), input),
    ),
    command(
      C.customerReceivables.get,
      openingCustomerInputSchema,
      ({ windowId }, input) =>
        customerReceivables.get(session(windowId), input),
    ),
    command(
      C.customerReceivables.recordPayment,
      recordOpeningPaymentInputSchema,
      ({ windowId }, input) =>
        customerReceivables.recordPayment(session(windowId), input),
    ),
    command(
      C.supplierPayables.list,
      supplierOpeningListInputSchema,
      ({ windowId }, input) => supplierPayables.list(session(windowId), input),
    ),
    command(
      C.supplierPayables.get,
      supplierOpeningInputSchema,
      ({ windowId }, input) => supplierPayables.get(session(windowId), input),
    ),
    command(
      C.supplierPayables.recordPayment,
      recordSupplierOpeningPaymentInputSchema,
      ({ windowId }, input) =>
        supplierPayables.recordPayment(session(windowId), input),
    ),
    command(C.customerTransfer.previewImport, noInput, ({ windowId }) =>
      customerTransfer.previewImport(session(windowId)),
    ),
    command(
      C.customerTransfer.commitImport,
      commitCustomerImportInputSchema,
      ({ windowId }, input) =>
        customerTransfer.commitImport(session(windowId), input),
    ),
    command(C.supplierTransfer.previewImport, noInput, ({ windowId }) =>
      supplierTransfer.previewImport(session(windowId)),
    ),
    command(
      C.supplierTransfer.commitImport,
      commitSupplierImportInputSchema,
      ({ windowId }, input) =>
        supplierTransfer.commitImport(session(windowId), input),
    ),
    command(C.catalogTransfer.previewImport, noInput, ({ windowId }) =>
      catalogTransfer.previewImport(session(windowId)),
    ),
    command(
      C.catalogTransfer.commitImport,
      commitImportInputSchema,
      ({ windowId }, input) =>
        catalogTransfer.commitImport(session(windowId), input),
    ),
    command(
      C.catalogTransfer.exportCatalog,
      exportCatalogInputSchema,
      ({ windowId }, input) =>
        catalogTransfer.exportCatalog(session(windowId), input),
    ),
    command(C.catalogTransfer.downloadTemplate, noInput, ({ windowId }) =>
      catalogTransfer.downloadTemplate(session(windowId)),
    ),
    command(C.backups.create, noInput, ({ windowId }) =>
      backups.create(session(windowId)),
    ),
    command(C.backups.status, noInput, ({ windowId }) =>
      backups.status(session(windowId)),
    ),
    command(C.backups.chooseDestination, noInput, ({ windowId }) =>
      backups.chooseDestination(session(windowId)),
    ),
    command(C.backups.inspectRestore, noInput, ({ windowId }) =>
      restore.inspect(session(windowId)),
    ),
    command(C.backups.restore, restoreInputSchema, ({ windowId }, input) =>
      restore.restore(session(windowId), input),
    ),
    command(
      C.backups.cancelRestore,
      cancelRestoreInputSchema,
      ({ windowId }, input) => restore.cancel(session(windowId), input),
    ),
    command(C.backups.takeRestoreNotice, noInput, ({ windowId }) =>
      restoreNotice.take(session(windowId)),
    ),
  ];
  return commands.map((cmd) => guarded(cmd, maintenance));
}
