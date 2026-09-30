import type {
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
    updatePreferences(input: PreferencesInput): Promise<Result<PublicSettings>>;
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
  readonly app: {
    openLogFolder(): Promise<Result<void>>;
    /**
     * Normal exit: main announces the close; the renderer flushes pending
     * draft input and then calls `readyToClose()`. Main closes on ready or
     * after a short timeout. Returns an unsubscribe function.
     */
    onBeforeClose(callback: () => void): () => void;
    readyToClose(): void;
  };
}
