import { z } from 'zod';
import {
  DomainError,
  parseRupiah,
  type Instant,
  type LocalDate,
  type PercentageBps,
  type Rupiah,
} from '../primitives';
import { adHocItemTypeSchema, type AdHocItemType } from './ad-hoc-references';
import { instantSchema, priceSchema, type CatalogItemType } from './catalog';
import { localDateSchema, requiredText, uuidSchema, type UUID } from './common';
import { paymentMethodSchema, type PaymentMethod } from './payments';

/**
 * Drafts (spec 15-20, 27, 28; Part A). A draft is an invoice with status
 * DRAFT, shared by every cashier of the shop. Every change goes through
 * `drafts.apply` with a `requestId` (idempotency: generate once per user
 * action, reuse it on retry) and the `expectedVersion` the UI last saw
 * (optimistic concurrency: a stale command gets DRAFT_VERSION_CONFLICT and
 * never overwrites newer state).
 */

export const MAX_LINE_QUANTITY = 1_000_000;
export const MAX_DISCOUNT_STAGE_COUNT = 4;
export const MAX_CHECKOUT_ALLOCATIONS = 10;
export const MAX_TOP_DAYS = 3650;

const requestId = uuidSchema;

const quantitySchema = z
  .number('validation.invalid')
  .int('validation.invalid')
  .min(1, 'validation.invalid')
  .max(MAX_LINE_QUANTITY, 'validation.invalid');

/** Positive whole-rupiah decimal string. */
export const positiveRupiahSchema = z
  .string('validation.required')
  .refine((value) => {
    try {
      return parseRupiah(value) > 0n;
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
  }, 'validation.invalidMoney');

/** Sequential discount stages (1-4) in basis points: 275 = 2.75%. */
export const discountStagesSchema = z
  .array(
    z
      .number('validation.invalid')
      .int('validation.invalid')
      .min(0, 'validation.invalid')
      .max(10000, 'validation.invalid'),
  )
  .max(MAX_DISCOUNT_STAGE_COUNT, 'validation.tooLong');

/** Optional free text; blank means "clear it" (null). Absent means "unchanged". */
const clearableText = (max: number) =>
  z
    .string('validation.invalid')
    .trim()
    .max(max, 'validation.tooLong')
    .nullable()
    .transform((value) => (value ? value : null));

const reasonSchema = z
  .string('validation.invalid')
  .trim()
  .max(500, 'validation.tooLong')
  .transform((value) => (value ? value : null))
  .optional();

export const createDraftInputSchema = z.strictObject({
  requestId,
  channelId: uuidSchema,
  invoiceDate: localDateSchema,
  /** Normally "now"; selects catalog prices for new lines. */
  pricingAt: instantSchema,
});
export type CreateDraftInput = z.input<typeof createDraftInputSchema>;

/** `drafts.get(id)`: the bare draft id. */
export const draftIdSchema = uuidSchema;

export const previewPriceRefreshInputSchema = z.strictObject({
  invoiceId: uuidSchema,
});
export type PreviewPriceRefreshInput = z.input<
  typeof previewPriceRefreshInputSchema
>;

export const previewCatalogPriceInputSchema = z.strictObject({
  invoiceId: uuidSchema,
  catalogItemId: uuidSchema,
});
export type PreviewCatalogPriceInput = z.infer<
  typeof previewCatalogPriceInputSchema
>;
export interface CatalogPricePreviewDto {
  invoiceId: UUID;
  version: number;
  catalogItemId: UUID;
  channelId: UUID;
  pricingAt: Instant;
  resolvedPriceId: UUID | null;
  unitPrice: Rupiah;
}

// ---- operations of drafts.apply ----

/**
 * Header edits. Send only the fields that changed. `null` clears an optional
 * field. Changing `channelId` or `pricingAt` NEVER reprices existing lines
 * (use previewPriceRefresh + applyPriceRefresh).
 */
export const updateHeaderOpSchema = z.strictObject({
  kind: z.literal('updateHeader'),
  changes: z
    .strictObject({
      channelId: uuidSchema.optional(),
      invoiceDate: localDateSchema.optional(),
      pricingAt: instantSchema.optional(),
      taxInvoiceNumber: clearableText(100).optional(),
      salesId: uuidSchema.nullable().optional(),
      expeditionId: uuidSchema.nullable().optional(),
      customerId: uuidSchema.nullable().optional(),
      vehicleId: uuidSchema.nullable().optional(),
      odometerKm: z
        .number('validation.invalid')
        .int('validation.invalid')
        .min(0, 'validation.invalid')
        .max(100_000_000, 'validation.invalid')
        .nullable()
        .optional(),
      topDays: z
        .number('validation.invalid')
        .int('validation.invalid')
        .min(0, 'validation.invalid')
        .max(MAX_TOP_DAYS, 'validation.invalid')
        .optional(),
      note: clearableText(1000).optional(),
    })
    .refine(
      (changes) => Object.values(changes).some((v) => v !== undefined),
      'validation.required',
    ),
});

/**
 * Adds a catalog line, picked by id or scanned by barcode (exactly one).
 * The price resolves at the draft's channel and `pricingAt`. When nothing
 * resolves the command fails with PRICE_REQUIRED unless `unitPrice` is given
 * (an audited manual entry); `unitPrice` is refused (UNIT_PRICE_NOT_EXPECTED)
 * when a price does resolve (use updateLine to override).
 * Re-adding an item merges into the most recent eligible line (spec 11).
 */
export const addCatalogLineOpSchema = z
  .strictObject({
    kind: z.literal('addCatalogLine'),
    catalogItemId: uuidSchema.optional(),
    barcode: z
      .string('validation.required')
      .trim()
      .min(1, 'validation.required')
      .max(100, 'validation.tooLong')
      .optional(),
    quantity: quantitySchema.optional(),
    unitPrice: priceSchema.optional(),
    reason: reasonSchema,
  })
  .refine(
    (op) => (op.catalogItemId === undefined) !== (op.barcode === undefined),
    { message: 'validation.invalid', path: ['catalogItemId'] },
  );

/**
 * A free-form line (spec 12). Without `adHocItemReferenceId` a reusable
 * reference is upserted by (type, title). Never touches stock.
 */
export const addCustomLineOpSchema = z.strictObject({
  kind: z.literal('addCustomLine'),
  type: adHocItemTypeSchema,
  title: requiredText(200),
  unitId: uuidSchema.nullable().optional(),
  unitPrice: priceSchema,
  quantity: quantitySchema.optional(),
  adHocItemReferenceId: uuidSchema.optional(),
});

/**
 * Line edits. A different `unitPrice` is a manual override: recorded in the
 * price history (MANUAL_OVERRIDE, with the optional `reason`) and audited.
 * `mechanicId` only on SERVICE lines (null clears). `title` only on custom
 * lines.
 */
export const updateLineOpSchema = z
  .strictObject({
    kind: z.literal('updateLine'),
    lineId: uuidSchema,
    quantity: quantitySchema.optional(),
    unitPrice: priceSchema.optional(),
    reason: reasonSchema,
    mechanicId: uuidSchema.nullable().optional(),
    title: requiredText(200).optional(),
  })
  .refine(
    (op) =>
      op.quantity !== undefined ||
      op.unitPrice !== undefined ||
      op.mechanicId !== undefined ||
      op.title !== undefined,
    'validation.required',
  )
  .refine((op) => op.reason === undefined || op.unitPrice !== undefined, {
    message: 'validation.invalid',
    path: ['reason'],
  });

export const removeLineOpSchema = z.strictObject({
  kind: z.literal('removeLine'),
  lineId: uuidSchema,
});

/** Replaces the line's stages (empty = none). */
export const setLineDiscountsOpSchema = z.strictObject({
  kind: z.literal('setLineDiscounts'),
  lineId: uuidSchema,
  stages: discountStagesSchema,
});

/** Replaces the invoice-level stages (empty = none). */
export const setInvoiceDiscountsOpSchema = z.strictObject({
  kind: z.literal('setInvoiceDiscounts'),
  stages: discountStagesSchema,
});

export const checkoutAllocationInputSchema = z.strictObject({
  method: paymentMethodSchema,
  amount: positiveRupiahSchema,
  reference: clearableText(100).optional(),
  note: clearableText(500).optional(),
});

/**
 * Replaces the planned payment split. The sum may be below the amount (the
 * rest is credit) but never above it (ALLOCATION_EXCEEDS_AMOUNT). These are
 * plans only; no payment exists until finalization.
 */
export const setCheckoutAllocationsOpSchema = z.strictObject({
  kind: z.literal('setCheckoutAllocations'),
  allocations: z
    .array(checkoutAllocationInputSchema)
    .max(MAX_CHECKOUT_ALLOCATIONS, 'validation.tooLong'),
});

/**
 * Applies the proposals the cashier selected from previewPriceRefresh. Each
 * entry repeats the proposal; if the resolution changed since the preview the
 * whole command fails with DRAFT_PRICE_REFRESH_STALE.
 */
export const applyPriceRefreshOpSchema = z.strictObject({
  kind: z.literal('applyPriceRefresh'),
  lines: z
    .array(
      z.strictObject({
        lineId: uuidSchema,
        resolvedPriceId: uuidSchema,
        proposedUnitPrice: priceSchema,
      }),
    )
    .min(1, 'validation.required')
    .max(500, 'validation.tooLong')
    .refine(
      (lines) => new Set(lines.map((l) => l.lineId)).size === lines.length,
      'validation.duplicate',
    ),
});

/** Discards the draft for everyone. Final: it never comes back. */
export const discardOpSchema = z.strictObject({
  kind: z.literal('discard'),
});

export const draftOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reserveInvoiceNumber') }),
  z.strictObject({
    kind: z.literal('confirmLineZeroPrice'),
    lineId: uuidSchema,
  }),
  updateHeaderOpSchema,
  addCatalogLineOpSchema,
  addCustomLineOpSchema,
  updateLineOpSchema,
  removeLineOpSchema,
  setLineDiscountsOpSchema,
  setInvoiceDiscountsOpSchema,
  setCheckoutAllocationsOpSchema,
  applyPriceRefreshOpSchema,
  discardOpSchema,
]);
export type DraftOperation = z.input<typeof draftOperationSchema>;
export type DraftOperationData = z.output<typeof draftOperationSchema>;
export type DraftOperationKind = DraftOperationData['kind'];

export const draftCommandSchema = z.strictObject({
  requestId,
  invoiceId: uuidSchema,
  /** The `version` of the DraftView this command was built from. */
  expectedVersion: z
    .number('validation.invalid')
    .int('validation.invalid')
    .min(1, 'validation.invalid'),
  op: draftOperationSchema,
});
export type DraftCommand = z.input<typeof draftCommandSchema>;
export type DraftCommandData = z.output<typeof draftCommandSchema>;

// ---- DTOs ----

export type InvoiceStatus = 'DRAFT' | 'FINALIZED' | 'VOID';
export type LineItemType = CatalogItemType | AdHocItemType;
export type PriceChangeKind =
  | 'MANUAL_OVERRIDE'
  | 'MISSING_PRICE_ENTRY'
  | 'PRICE_REFRESH';

export interface CashierRefDto {
  id: UUID;
  displayName: string;
}

export interface DiscountStageDto {
  sequence: number;
  percentageBps: PercentageBps;
  /** The calculated, persisted amount of this stage. */
  amount: Rupiah;
}

export interface PriceChangeDto {
  id: UUID;
  sequence: number;
  kind: PriceChangeKind;
  /** null only for MISSING_PRICE_ENTRY. */
  previousPrice: Rupiah | null;
  newPrice: Rupiah;
  changedBy: CashierRefDto;
  changedAt: Instant;
  reason: string | null;
}

export interface LinePricingDto {
  /** The catalog price point the line's listed price came from. */
  resolvedPriceId: UUID | null;
  /** The pricingAt used for that resolution. */
  priceResolvedAt: Instant | null;
  manualPriceOverride: boolean;
  /**
   * Informational: what the draft's CURRENT channel and pricingAt resolve to
   * now (null when nothing resolves or for custom lines). Never applied
   * automatically.
   */
  currentResolvedPriceId: UUID | null;
  currentListedPrice: Rupiah | null;
  /** True when the current resolution differs from the line's listed price point. */
  listedPriceDiffersFromCurrent: boolean;
}

export interface DraftLineDto {
  priceEntryConfirmed: boolean;
  id: UUID;
  position: number;
  source: 'CATALOG' | 'CUSTOM';
  catalogItemId: UUID | null;
  adHocItemReferenceId: UUID | null;
  itemType: LineItemType;
  title: string;
  unitId: UUID | null;
  unitLabel: string | null;
  mechanicId: UUID | null;
  mechanicName: string | null;
  quantity: number;
  listedUnitPrice: Rupiah | null;
  unitPrice: Rupiah;
  /** quantity x unitPrice. */
  subtotal: Rupiah;
  discountAmount: Rupiah;
  amount: Rupiah;
  discounts: DiscountStageDto[];
  pricing: LinePricingDto;
  /** Oldest first. */
  priceChanges: PriceChangeDto[];
  createdAt: Instant;
  updatedAt: Instant;
}

export interface CheckoutAllocationDto {
  sequence: number;
  method: PaymentMethod;
  amount: Rupiah;
  reference: string | null;
  note: string | null;
}

export interface DraftTotalsDto {
  /** Before all discounts. */
  subtotal: Rupiah;
  itemDiscountAmount: Rupiah;
  invoiceDiscountAmount: Rupiah;
  /** Item plus invoice discounts. */
  discountAmount: Rupiah;
  /** Payable. */
  amount: Rupiah;
  /** Sum of the planned checkout allocations. */
  allocatedAmount: Rupiah;
  /** amount - allocatedAmount; negative when later edits lowered the amount. */
  unallocatedAmount: Rupiah;
}

export interface DraftCustomerDto {
  id: UUID;
  name: string | null;
  phoneNumber: string | null;
}

export interface DraftVehicleDto {
  id: UUID;
  plateNumber: string;
  /** "Brand Model", or null when unknown. */
  description: string | null;
  activeOwnerId: UUID | null;
}

export interface DraftView {
  invoiceNumber: string | null;
  taxInvoiceNumber: string | null;
  id: UUID;
  status: InvoiceStatus;
  version: number;
  channelId: UUID;
  channelLabel: string;
  invoiceDate: LocalDate;
  pricingAt: Instant;
  topDays: number;
  dueDate: LocalDate;
  sales: { id: UUID; name: string } | null;
  expedition: { id: UUID; name: string } | null;
  customer: DraftCustomerDto | null;
  vehicle: DraftVehicleDto | null;
  /** The vehicle's active owner is not the selected customer (warning only). */
  ownerMismatch: boolean;
  odometerKm: number | null;
  note: string | null;
  /** Live lines only (removed lines are excluded), in position order. */
  lines: DraftLineDto[];
  invoiceDiscounts: DiscountStageDto[];
  checkoutAllocations: CheckoutAllocationDto[];
  totals: DraftTotalsDto;
  /** Later edits lowered the amount below the planned allocations. */
  allocationsExceedAmount: boolean;
  createdBy: CashierRefDto;
  lastEditedBy: CashierRefDto;
  createdAt: Instant;
  updatedAt: Instant;
  discardedAt: Instant | null;
}

export interface DraftSummary {
  invoiceNumber: string | null;
  id: UUID;
  version: number;
  channelId: UUID;
  channelLabel: string;
  invoiceDate: LocalDate;
  /** Customer name, else phone, else null (anonymous). */
  customerLabel: string | null;
  plateNumber: string | null;
  amount: Rupiah;
  lineCount: number;
  createdBy: CashierRefDto;
  lastEditedBy: CashierRefDto;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface PriceRefreshProposalDto {
  lineId: UUID;
  title: string;
  currentUnitPrice: Rupiah;
  proposedUnitPrice: Rupiah;
  /** The price point the proposal comes from (send it back to apply). */
  resolvedPriceId: UUID;
  currentResolvedPriceId: UUID | null;
  manualPriceOverride: boolean;
}

export interface PriceRefreshPreviewDto {
  invoiceId: UUID;
  /** Send as expectedVersion when applying. */
  version: number;
  channelId: UUID;
  pricingAt: Instant;
  proposals: PriceRefreshProposalDto[];
}
