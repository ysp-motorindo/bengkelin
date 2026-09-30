import { z } from 'zod';
import type { Instant, LocalDate, Rupiah } from '../primitives';
import { optionalText, uuidSchema, type UUID } from './common';
import {
  positiveRupiahSchema,
  type CashierRefDto,
  type DiscountStageDto,
  type InvoiceStatus,
  type LineItemType,
} from './drafts';
import { paymentMethodSchema, type PaymentMethod } from './payments';

/**
 * Official invoices (spec 15, 17, 22, 23, 26; Part A).
 *
 * Finalization turns a shared draft into an official invoice in ONE write
 * transaction. The renderer first calls `previewFinalize` (read-only), shows
 * the errors (blocking) and warnings, and then sends `finalize` with the
 * preview's `draftVersion` as `expectedVersion` and the preview's warnings as
 * `acknowledgedWarnings`. If anything the warnings depend on changed in the
 * meantime (stock balances, odometer history, ownership) finalization answers
 * FINALIZE_WARNINGS_CHANGED; if the draft changed, DRAFT_VERSION_CONFLICT.
 * Either way: preview again and ask again.
 */

export type PaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
export type PaymentSource = 'CHECKOUT' | 'LATER';

// ---- warnings and errors ----

const count = z.number('validation.invalid').int('validation.invalid');

/** Tracked stock would go below zero (spec 25): warn strongly, never block. */
export const negativeStockWarningSchema = z.strictObject({
  code: z.literal('NEGATIVE_STOCK'),
  params: z.strictObject({
    catalogItemId: uuidSchema,
    title: z.string('validation.invalid').max(200, 'validation.tooLong'),
    /** SUM of the ledger when the check ran. */
    observedStock: count,
    /** Total quantity of this item over all live lines. */
    demand: count,
    resultingStock: count,
  }),
});

/** Lower than the highest reading on this vehicle's issued invoices (spec 15). */
export const odometerWarningSchema = z.strictObject({
  code: z.literal('ODOMETER_LOWER_THAN_PREVIOUS'),
  params: z.strictObject({ previousOdometer: count }),
});

/** The vehicle's active owner is not the selected customer (informational). */
export const ownerMismatchWarningSchema = z.strictObject({
  code: z.literal('OWNER_MISMATCH'),
  params: z.strictObject({ activeOwnerId: uuidSchema }),
});

export const finalizeWarningSchema = z.discriminatedUnion('code', [
  negativeStockWarningSchema,
  odometerWarningSchema,
  ownerMismatchWarningSchema,
]);
export type FinalizeWarning = z.infer<typeof finalizeWarningSchema>;
export type FinalizeWarningCode = FinalizeWarning['code'];

/** Blocking problems. The same codes are the `finalize` error codes. */
export type FinalizeErrorCode =
  | 'DRAFT_EMPTY'
  | 'INVOICE_DATE_IN_FUTURE'
  /** The draft's pricing time is later than the finalize instant. */
  | 'PRICING_AT_IN_FUTURE'
  | 'ALLOCATION_EXCEEDS_AMOUNT'
  | 'ZERO_TOTAL_WITH_ALLOCATIONS'
  | 'CHANNEL_INACTIVE'
  /** A live line's catalog item was deactivated after it was added. */
  | 'CATALOG_ITEM_INACTIVE';

export interface FinalizeIssue {
  code: FinalizeErrorCode;
  /** Values for the translated message (`errors.<code>`). */
  params: Record<string, string>;
}

// ---- inputs ----

export const previewFinalizeInputSchema = z.strictObject({
  invoiceId: uuidSchema,
});
export type PreviewFinalizeInput = z.input<typeof previewFinalizeInputSchema>;

export const finalizeInputSchema = z.strictObject({
  /** Once per finalize submission; reuse it on retry. */
  requestId: uuidSchema,
  invoiceId: uuidSchema,
  /** The preview's `draftVersion`. */
  expectedVersion: z
    .number('validation.invalid')
    .int('validation.invalid')
    .min(1, 'validation.invalid'),
  /** Exactly the warnings the cashier was shown and accepted. */
  acknowledgedWarnings: z
    .array(finalizeWarningSchema)
    .max(500, 'validation.tooLong'),
});
export type FinalizeInput = z.input<typeof finalizeInputSchema>;
export type FinalizeData = z.output<typeof finalizeInputSchema>;

export const invoiceIdInputSchema = z.strictObject({ invoiceId: uuidSchema });
export type InvoiceIdInput = z.input<typeof invoiceIdInputSchema>;

/**
 * A later payment (spec 22) on a FINALIZED invoice. `amount` is whole rupiah,
 * > 0 and at most the outstanding amount recomputed inside the write
 * transaction (PAYMENT_EXCEEDS_OUTSTANDING, also on a fully PAID invoice).
 * VOID -> INVOICE_VOID, DRAFT -> INVOICE_NOT_FINALIZED. `paidAt` is the
 * receipt time (never backdated in v1) and the receiver is the session.
 */
export const recordPaymentInputSchema = z.strictObject({
  /** Once per payment submission; reuse it on retry. */
  requestId: uuidSchema,
  invoiceId: uuidSchema,
  method: paymentMethodSchema,
  amount: positiveRupiahSchema,
  reference: optionalText(100),
  note: optionalText(500),
});
export type RecordPaymentInput = z.input<typeof recordPaymentInputSchema>;
export type RecordPaymentData = z.output<typeof recordPaymentInputSchema>;

/**
 * Voids an unpaid FINALIZED invoice (spec 29; Part A "Voiding"). A blank
 * reason is VOID_REASON_REQUIRED; any payment is
 * PAID_INVOICE_CANNOT_BE_VOIDED; a second void is INVOICE_ALREADY_VOID.
 */
export const voidInvoiceInputSchema = z.strictObject({
  /** Once per void submission; reuse it on retry. */
  requestId: uuidSchema,
  invoiceId: uuidSchema,
  /** Trimmed; blank is checked by the service (VOID_REASON_REQUIRED). */
  reason: z.string('validation.required').trim().max(500, 'validation.tooLong'),
});
export type VoidInvoiceInput = z.input<typeof voidInvoiceInputSchema>;
export type VoidInvoiceData = z.output<typeof voidInvoiceInputSchema>;

// ---- DTOs ----

export interface FinalizePreviewTotalsDto {
  subtotal: Rupiah;
  itemDiscountAmount: Rupiah;
  invoiceDiscountAmount: Rupiah;
  discountAmount: Rupiah;
  amount: Rupiah;
  /** Sum of the checkout allocations that become payments. */
  checkoutPaymentAmount: Rupiah;
  /** amount - checkoutPaymentAmount (negative when allocations exceed). */
  outstandingAmount: Rupiah;
}

export interface CheckoutPaymentPreviewDto {
  method: PaymentMethod;
  amount: Rupiah;
  reference: string | null;
  note: string | null;
}

export interface FinalizePreviewDto {
  invoiceId: UUID;
  /** Send as `expectedVersion`. */
  draftVersion: number;
  totals: FinalizePreviewTotalsDto;
  /** The allocations as the payments finalization will record. */
  checkoutPayments: CheckoutPaymentPreviewDto[];
  /** Derived status right after checkout; null while there are errors. */
  paymentStatusAfterCheckout: PaymentStatus | null;
  errors: FinalizeIssue[];
  /** Send back unchanged as `acknowledgedWarnings`. */
  warnings: FinalizeWarning[];
}

/** Printable shop identity frozen at finalization. */
export interface ShopIdentitySnapshot {
  name: string;
  address: string;
  phoneNumber: string | null;
  email: string | null;
  invoiceFooter: string | null;
  /**
   * The shop logo's content-addressed asset key (`<sha256>.png|jpg`) at
   * finalization; null when none was set (and for invoices finalized
   * before logos existed).
   */
  logo: string | null;
}

export interface InvoiceLineDto {
  id: UUID;
  position: number;
  catalogItemId: UUID | null;
  adHocItemReferenceId: UUID | null;
  itemType: LineItemType;
  title: string;
  unitLabel: string | null;
  mechanicId: UUID | null;
  mechanicName: string | null;
  quantity: number;
  listedUnitPrice: Rupiah | null;
  unitPrice: Rupiah;
  manualPriceOverride: boolean;
  subtotal: Rupiah;
  discountAmount: Rupiah;
  amount: Rupiah;
  discounts: DiscountStageDto[];
}

export interface PaymentDto {
  id: UUID;
  method: PaymentMethod;
  amount: Rupiah;
  paidAt: Instant;
  reference: string | null;
  note: string | null;
  receivedBy: CashierRefDto;
  source: PaymentSource;
}

export interface InvoiceTotalsDto {
  subtotal: Rupiah;
  itemDiscountAmount: Rupiah;
  invoiceDiscountAmount: Rupiah;
  discountAmount: Rupiah;
  amount: Rupiah;
}

export interface InvoiceVoidDto {
  voidedAt: Instant;
  voidedBy: CashierRefDto;
  reason: string;
}

/**
 * An issued (FINALIZED or VOID) invoice, built from its frozen snapshots so
 * later master-data edits never change it. Reused by payments (T11),
 * printing (T12) and history.
 */
export interface InvoiceView {
  id: UUID;
  invoiceNumber: string;
  status: Exclude<InvoiceStatus, 'DRAFT'>;
  version: number;
  invoiceDate: LocalDate;
  pricingAt: Instant;
  topDays: number;
  dueDate: LocalDate;
  finalizedAt: Instant;
  channel: { id: UUID; label: string };
  /** Snapshots; null for an anonymous sale. */
  customer: {
    id: UUID;
    name: string | null;
    phoneNumber: string | null;
  } | null;
  vehicle: {
    id: UUID;
    plateNumber: string | null;
    description: string | null;
  } | null;
  odometerKm: number | null;
  note: string | null;
  /** The finalizing cashier (the sale is attributed to them). */
  cashier: CashierRefDto;
  createdBy: CashierRefDto;
  shop: ShopIdentitySnapshot;
  lines: InvoiceLineDto[];
  invoiceDiscounts: DiscountStageDto[];
  totals: InvoiceTotalsDto;
  /** Oldest first. */
  payments: PaymentDto[];
  paidAmount: Rupiah;
  outstandingAmount: Rupiah;
  /** Derived with derivePaymentStatus (spec 23), never stored. */
  paymentStatus: PaymentStatus;
  void: InvoiceVoidDto | null;
}
