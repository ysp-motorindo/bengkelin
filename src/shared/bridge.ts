import type {
  ReferenceTransferInput,
  ReferenceImportPreviewDto,
  ReferenceImportSummaryDto,
  CommitReferenceImportInput,
} from './contracts';
import type {
  CustomerImportPreviewDto,
  CustomerImportSummaryDto,
  CommitCustomerImportInput,
} from './contracts';
import type { MenuAction } from './menu';
import type {
  AboutDto,
  AdHocReferenceDto,
  AdHocReferenceIdInput,
  CashierNameDto,
  VehicleDto,
  ListAdHocReferencesInput,
  MenuContextInput,
  RestoreNoticeDto,
  UpdateAdHocReferenceInput,
  CatalogFileOutcomeDto,
  CommitImportInput,
  ImportPreviewDto,
  ImportSummaryDto,
  BackupDestinationChoiceDto,
  CancelRestoreInput,
  RestoreInput,
  RestoreInspectionDto,
  RestoreStartedDto,
  BackupStatusDto,
  BackupSummary,
  DailyReport,
  DailyReportInput,
  ReportOutcomeDto,
  ReportPreviewDto,
  ExportPdfInput,
  LogoChoiceDto,
  LogoDto,
  PrintInput,
  PrintOptionsDto,
  PrintOutcomeDto,
  PrintPreviewDto,
  PrintSettingsDto,
  PrintSettingsInput,
  PrinterDto,
  FinalizeInput,
  FinalizePreviewDto,
  InvoiceIdInput,
  InvoicePage,
  InvoiceSearchInput,
  InvoiceView,
  PreviewFinalizeInput,
  ReceivablesInput,
  ReceivablesPage,
  RecordPaymentInput,
  VoidInvoiceInput,
  CreateDraftInput,
  DraftCommand,
  DraftSummary,
  DraftView,
  PreviewPriceRefreshInput,
  PriceRefreshPreviewDto,
  SearchAdHocReferencesInput,
  SearchAdHocReferencesResult,
  UUID,
  AdjustStockInput,
  LedgerDto,
  ListStockInput,
  OpenBalanceInput,
  ReceiveStockInput,
  SetStockInput,
  StockChangeDto,
  StockDto,
  StockHistoryInput,
  StockItemInput,
  StockListDto,
  AppliedPriceChangeDto,
  CashierDto,
  CatalogIdInput,
  CatalogItemDto,
  CashierIdInput,
  CashierSession,
  ChangeRoleInput,
  CreateCashierInput,
  CustomerDetailDto,
  CustomerIdInput,
  ApplyPriceChangeInput,
  ListPricesInput,
  ListReferencesInput,
  LoginInput,
  LookupBarcodeInput,
  PreferencesInput,
  PriceChangeInput,
  PricePreviewDto,
  PriceTimelineDto,
  OwnershipTransferInput,
  PublicSettings,
  ReferenceDto,
  ReferenceIdInput,
  ResetPasswordInput,
  SaveBarcodesInput,
  SaveCatalogItemInput,
  SaveCustomerInput,
  SaveCustomerResult,
  SaveReferenceInput,
  SaveVehicleInput,
  SaveVehicleResult,
  SearchCatalogInput,
  SearchCatalogResult,
  SearchCustomersInput,
  SearchCustomersResult,
  SearchVehiclesInput,
  SearchVehiclesResult,
  SetupInput,
  ShopSettingsDto,
  ShopSettingsInput,
  UpdateDisplayNameInput,
  VehicleDetailDto,
  VehicleIdInput,
} from './contracts';
import type { Result } from './primitives';

/** Shape of `window.bengkelin`. Feature tasks add named namespaces here. */
export interface BengkelinApi {
  readonly auth: {
    login(input: LoginInput): Promise<Result<CashierSession>>;
    logout(): Promise<Result<void>>;
    currentSession(): Promise<Result<CashierSession | null>>;
  };
  readonly settings: {
    getPublic(): Promise<Result<PublicSettings>>;
    /** Any signed-in cashier. */
    getShop(): Promise<Result<ShopSettingsDto>>;
    completeSetup(input: SetupInput): Promise<Result<PublicSettings>>;
    updateShop(input: ShopSettingsInput): Promise<Result<void>>;
    updatePreferences(
      input: PreferencesInput,
    ): Promise<Result<PreferencesInput>>;
    /** ADMIN: a native open dialog in main picks a PNG/JPEG (<= 512 KB). */
    chooseLogo(): Promise<Result<LogoChoiceDto>>;
    /** ADMIN. */
    removeLogo(): Promise<Result<void>>;
    /** ADMIN: the current logo for display, or null. */
    getLogo(): Promise<Result<LogoDto | null>>;
  };
  readonly cashiers: {
    list(): Promise<Result<CashierDto[]>>;
    create(input: CreateCashierInput): Promise<Result<CashierDto>>;
    updateDisplayName(
      input: UpdateDisplayNameInput,
    ): Promise<Result<CashierDto>>;
    changeRole(input: ChangeRoleInput): Promise<Result<CashierDto>>;
    deactivate(input: CashierIdInput): Promise<Result<CashierDto>>;
    reactivate(input: CashierIdInput): Promise<Result<CashierDto>>;
    resetPassword(input: ResetPasswordInput): Promise<Result<void>>;
    /** Any signed-in cashier: names for filters (no usernames or roles). */
    listNames(): Promise<Result<CashierNameDto[]>>;
  };
  readonly references: {
    /** Active entries for pickers: any signed-in cashier. */
    listActive(input: ListReferencesInput): Promise<Result<ReferenceDto[]>>;
    /** ADMIN: includes inactive entries. */
    list(input: ListReferencesInput): Promise<Result<ReferenceDto[]>>;
    save(input: SaveReferenceInput): Promise<Result<ReferenceDto>>;
    deactivate(input: ReferenceIdInput): Promise<Result<ReferenceDto>>;
    reactivate(input: ReferenceIdInput): Promise<Result<ReferenceDto>>;
  };
  readonly customers: {
    search(input: SearchCustomersInput): Promise<Result<SearchCustomersResult>>;
    get(input: CustomerIdInput): Promise<Result<CustomerDetailDto>>;
    save(input: SaveCustomerInput): Promise<Result<SaveCustomerResult>>;
  };
  readonly vehicles: {
    searchByPlate(
      input: SearchVehiclesInput,
    ): Promise<Result<SearchVehiclesResult>>;
    get(input: VehicleIdInput): Promise<Result<VehicleDetailDto>>;
    save(input: SaveVehicleInput): Promise<Result<SaveVehicleResult>>;
    transferOwnership(
      input: OwnershipTransferInput,
    ): Promise<Result<VehicleDetailDto>>;
    /** ADMIN: hidden from new drafts; history and ownership unchanged. */
    deactivate(input: VehicleIdInput): Promise<Result<VehicleDto>>;
    /** ADMIN. */
    reactivate(input: VehicleIdInput): Promise<Result<VehicleDto>>;
  };
  readonly catalog: {
    search(input: SearchCatalogInput): Promise<Result<SearchCatalogResult>>;
    get(input: CatalogIdInput): Promise<Result<CatalogItemDto>>;
    /** ADMIN. */
    save(input: SaveCatalogItemInput): Promise<Result<CatalogItemDto>>;
    /** ADMIN. */
    saveBarcodes(input: SaveBarcodesInput): Promise<Result<CatalogItemDto>>;
    lookupBarcode(input: LookupBarcodeInput): Promise<Result<CatalogItemDto>>;
    listPrices(input: ListPricesInput): Promise<Result<PriceTimelineDto>>;
    /** ADMIN. */
    previewPriceChange(
      input: PriceChangeInput,
    ): Promise<Result<PricePreviewDto>>;
    /** ADMIN. */
    applyPriceChange(
      input: ApplyPriceChangeInput,
    ): Promise<Result<AppliedPriceChangeDto>>;
  };
  readonly inventory: {
    /** Any signed-in cashier (read-only). */
    getStock(input: StockItemInput): Promise<Result<StockDto>>;
    listStock(input: ListStockInput): Promise<Result<StockListDto>>;
    history(input: StockHistoryInput): Promise<Result<LedgerDto>>;
    /** ADMIN. Every write takes a `requestId`: generate once per submission. */
    openBalance(input: OpenBalanceInput): Promise<Result<StockChangeDto>>;
    /** ADMIN. */
    receive(input: ReceiveStockInput): Promise<Result<StockChangeDto>>;
    /** ADMIN. A reason is required. */
    adjust(input: AdjustStockInput): Promise<Result<StockChangeDto>>;
    /** ADMIN. A reason is required; the delta is computed in main. */
    setStock(input: SetStockInput): Promise<Result<StockChangeDto>>;
  };
  /**
   * Shared shop drafts (any signed-in cashier). Every `apply` carries a
   * `requestId` (once per user action, reused on retry) and the
   * `expectedVersion` of the view it was built from.
   */
  readonly drafts: {
    previewCatalogPrice(
      input: import('./contracts').PreviewCatalogPriceInput,
    ): Promise<Result<import('./contracts').CatalogPricePreviewDto>>;
    create(input: CreateDraftInput): Promise<Result<DraftView>>;
    list(): Promise<Result<DraftSummary[]>>;
    get(id: UUID): Promise<Result<DraftView>>;
    apply(input: DraftCommand): Promise<Result<DraftView>>;
    /** Read-only proposals at the draft's current channel and pricingAt. */
    previewPriceRefresh(
      input: PreviewPriceRefreshInput,
    ): Promise<Result<PriceRefreshPreviewDto>>;
  };
  readonly adHocReferences: {
    search(
      input: SearchAdHocReferencesInput,
    ): Promise<Result<SearchAdHocReferencesResult>>;
    /** ADMIN: every reference, inactive ones included. */
    list(input: ListAdHocReferencesInput): Promise<Result<AdHocReferenceDto[]>>;
    /** ADMIN: edit the description. */
    update(
      input: UpdateAdHocReferenceInput,
    ): Promise<Result<AdHocReferenceDto>>;
    /** ADMIN: hide from autocomplete; lines that used it are unchanged. */
    deactivate(
      input: AdHocReferenceIdInput,
    ): Promise<Result<AdHocReferenceDto>>;
    /** ADMIN. */
    reactivate(
      input: AdHocReferenceIdInput,
    ): Promise<Result<AdHocReferenceDto>>;
  };
  /** Official invoices (any signed-in cashier). */
  readonly invoices: {
    /** Read-only: totals, blocking errors and warnings to acknowledge. */
    previewFinalize(
      input: PreviewFinalizeInput,
    ): Promise<Result<FinalizePreviewDto>>;
    /**
     * Atomic finalization with checkout payments. `requestId` once per
     * submission (reused on retry); `expectedVersion` and
     * `acknowledgedWarnings` from the preview.
     */
    finalize(input: FinalizeInput): Promise<Result<InvoiceView>>;
    /** A FINALIZED or VOID invoice. */
    get(input: InvoiceIdInput): Promise<Result<InvoiceView>>;
    /**
     * A later payment on a FINALIZED invoice, at most the outstanding
     * amount. `requestId` once per submission (reused on retry).
     */
    recordPayment(input: RecordPaymentInput): Promise<Result<InvoiceView>>;
    /** Voids an invoice with no payments; a reason is required. */
    void(input: VoidInvoiceInput): Promise<Result<InvoiceView>>;
    /** History: FINALIZED and VOID invoices matched on their snapshots. */
    search(input: InvoiceSearchInput): Promise<Result<InvoicePage>>;
    /** Outstanding or overdue FINALIZED invoices. */
    receivables(input: ReceivablesInput): Promise<Result<ReceivablesPage>>;
  };
  /**
   * Invoice printing (any signed-in cashier), always of a committed
   * invoice. A printer failure, cancellation or missing printer is an
   * outcome and never changes the invoice.
   */
  readonly printing: {
    /** The same HTML document print and PDF use, for an in-app preview. */
    preview(input: PrintInput): Promise<Result<PrintPreviewDto>>;
    print(input: PrintInput): Promise<Result<PrintOutcomeDto>>;
    /** A4 PDF via a native save dialog in main. */
    exportPdf(input: ExportPdfInput): Promise<Result<PrintOutcomeDto>>;
    getOptions(): Promise<Result<PrintOptionsDto>>;
    /** ADMIN. */
    listPrinters(): Promise<Result<PrinterDto[]>>;
    /** ADMIN. */
    getSettings(): Promise<Result<PrintSettingsDto>>;
    /** ADMIN. */
    updateSettings(
      input: PrintSettingsInput,
    ): Promise<Result<PrintSettingsDto>>;
  };
  /**
   * Daily report for a calendar day in the shop timezone (any signed-in
   * cashier). Sales by finalization, voids by void time, payments by
   * receipt time. Print (A4) and CSV export render the same report; the CSV
   * destination is chosen in a native dialog in main.
   */
  readonly reports: {
    daily(input: DailyReportInput): Promise<Result<DailyReport>>;
    preview(input: DailyReportInput): Promise<Result<ReportPreviewDto>>;
    print(input: DailyReportInput): Promise<Result<ReportOutcomeDto>>;
    exportCsv(input: DailyReportInput): Promise<Result<ReportOutcomeDto>>;
  };
  /**
   * Catalog CSV transfer (ADMIN only). Files are chosen in native dialogs in
   * main; the renderer never passes a path. An import is previewed first and
   * committed with the preview token (a SAFETY backup is taken first).
   */
  readonly referenceTransfer: {
    previewImport(
      input: ReferenceTransferInput,
    ): Promise<Result<ReferenceImportPreviewDto>>;
    commitImport(
      input: CommitReferenceImportInput,
    ): Promise<Result<ReferenceImportSummaryDto>>;
    downloadTemplate(
      input: ReferenceTransferInput,
    ): Promise<Result<CatalogFileOutcomeDto>>;
  };
  readonly customerTransfer: {
    previewImport(): Promise<Result<CustomerImportPreviewDto>>;
    commitImport(
      input: CommitCustomerImportInput,
    ): Promise<Result<CustomerImportSummaryDto>>;
  };
  readonly catalogTransfer: {
    previewImport(): Promise<Result<ImportPreviewDto>>;
    commitImport(input: CommitImportInput): Promise<Result<ImportSummaryDto>>;
    exportCatalog(): Promise<Result<CatalogFileOutcomeDto>>;
    downloadTemplate(): Promise<Result<CatalogFileOutcomeDto>>;
  };
  /**
   * Validated local backups (ADMIN only). The folder is chosen in a native
   * dialog in main; the renderer never passes a path.
   */
  readonly backups: {
    /** "Backup now": a MANUAL backup to the configured folder. */
    create(): Promise<Result<BackupSummary>>;
    /** Folder, recent runs, next automatic backup, failure notice. */
    status(): Promise<Result<BackupStatusDto>>;
    chooseDestination(): Promise<Result<BackupDestinationChoiceDto>>;
    /**
     * Restore, step 1: main shows the open dialog, stages, validates and
     * migrates a copy, and returns a preview with a single-use token.
     */
    inspectRestore(): Promise<Result<RestoreInspectionDto>>;
    /**
     * Restore, step 2 (flush draft input first): replaces the database and
     * restarts the application.
     */
    restore(input: RestoreInput): Promise<Result<RestoreStartedDto>>;
    cancelRestore(input: CancelRestoreInput): Promise<Result<void>>;
    /** The last restore's outcome, once, for the next ADMIN; else null. */
    takeRestoreNotice(): Promise<Result<RestoreNoticeDto | null>>;
  };
  readonly app: {
    openLogFolder(): Promise<Result<void>>;
    /**
     * Normal exit: main announces the close; the renderer flushes pending
     * draft input and then calls `readyToClose()`. Main closes on ready or
     * after a short timeout. Returns an unsubscribe function.
     */
    onBeforeClose(callback: () => void): () => void;
    readyToClose(): void;
    /** Help > About: app and schema version (no session needed). */
    about(): Promise<Result<AboutDto>>;
    /**
     * Native menu: main sends one of the finite MenuAction values; anything
     * else is dropped by the preload. Returns an unsubscribe function.
     */
    onMenuAction(callback: (action: MenuAction) => void): () => void;
    /** Tells main what the menu depends on (the printable context). */
    setMenuContext(input: MenuContextInput): Promise<Result<void>>;
  };
}
