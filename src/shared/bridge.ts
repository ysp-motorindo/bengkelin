import type {
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
    completeSetup(input: SetupInput): Promise<Result<PublicSettings>>;
    updateShop(input: ShopSettingsInput): Promise<Result<void>>;
    updatePreferences(input: PreferencesInput): Promise<Result<PublicSettings>>;
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
  readonly app: {
    openLogFolder(): Promise<Result<void>>;
  };
}
