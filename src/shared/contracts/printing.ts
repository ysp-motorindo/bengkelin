import { z } from 'zod';
import type { Instant, LocalDate, PercentageBps, Rupiah } from '../primitives';
import { optionalText, uuidSchema, type Language, type UUID } from './common';
import type { LineItemType } from './drafts';
import type { PaymentStatus } from './invoices';
import type { PaymentMethod } from './payments';

/**
 * Invoice printing (spec 30, 31, 61; Part A "Printing API").
 *
 * A finalized invoice has ONE print model (its snapshots plus the current
 * payment history) and three presentations. Printing always happens after
 * the invoice is committed and never changes business state: a failure,
 * cancellation or missing printer is an outcome, not a rollback.
 */

export const PRINT_FORMATS = ['A4', 'THERMAL_58', 'THERMAL_80'] as const;
export const printFormatSchema = z.enum(PRINT_FORMATS, 'validation.invalid');
export type PrintFormat = z.infer<typeof printFormatSchema>;

export const INVOICE_FORMATS = ['A4', 'THERMAL'] as const;
export const invoiceFormatSchema = z.enum(
  INVOICE_FORMATS,
  'validation.invalid',
);
/** The settings-level choice; THERMAL resolves to the configured width. */
export type InvoiceFormat = z.infer<typeof invoiceFormatSchema>;

// ---- inputs ----

export const printInputSchema = z.strictObject({
  invoiceId: uuidSchema,
  format: printFormatSchema,
});
export type PrintInput = z.input<typeof printInputSchema>;

export const exportPdfInputSchema = z.strictObject({ invoiceId: uuidSchema });
export type ExportPdfInput = z.input<typeof exportPdfInputSchema>;

/** Spec 31. A printer name is always optional (blank = "not set"). */
export const printSettingsInputSchema = z.strictObject({
  defaultInvoiceFormat: invoiceFormatSchema,
  thermalPaperWidthMm: z.union(
    [z.literal(58), z.literal(80)],
    'validation.invalid',
  ),
  defaultA4PrinterName: optionalText(200),
  defaultThermalPrinterName: optionalText(200),
  autoPrintAfterFinalize: z.boolean('validation.invalid'),
});
export type PrintSettingsInput = z.input<typeof printSettingsInputSchema>;
export type PrintSettingsData = z.output<typeof printSettingsInputSchema>;

// ---- DTOs ----

export interface PrintSettingsDto {
  defaultInvoiceFormat: InvoiceFormat;
  thermalPaperWidthMm: 58 | 80;
  defaultA4PrinterName: string | null;
  defaultThermalPrinterName: string | null;
  autoPrintAfterFinalize: boolean;
}

/** What any cashier's screens need to offer printing (no printer names). */
export interface PrintOptionsDto {
  defaultInvoiceFormat: InvoiceFormat;
  /** The configured thermal width as a print format. */
  thermalFormat: Extract<PrintFormat, 'THERMAL_58' | 'THERMAL_80'>;
  autoPrintAfterFinalize: boolean;
}

export interface PrinterDto {
  /** The OS device name (what a setting stores). */
  name: string;
  displayName: string;
  isDefault: boolean;
}

export interface PrintPageInfo {
  format: PrintFormat;
  widthMm: number;
  /** null: continuous roll, the height follows the content. */
  heightMm: number | null;
  printableWidthMm: number;
  /** A4 splits into pages with repeated table headers. */
  paginated: boolean;
}

/** One HTML document shared by preview, print and PDF export. */
export interface PrintPreviewDto {
  html: string;
  format: PrintFormat;
  pageInfo: PrintPageInfo;
}

export type PrintOutcome = 'PRINTED' | 'CANCELLED' | 'FAILED';
/** PRINTER_NOT_FOUND {printerName} | PRINT_FAILED | PRINT_TIMEOUT | PDF_FAILED */
export type PrintFailureCode =
  | 'PRINTER_NOT_FOUND'
  | 'PRINT_FAILED'
  | 'PRINT_TIMEOUT'
  | 'PDF_FAILED';

export interface PrintOutcomeDto {
  outcome: PrintOutcome;
  /** Only when FAILED. */
  code?: PrintFailureCode;
  params?: Record<string, string>;
  format: PrintFormat;
  /** Whether this job printed the REPRINT marking. */
  isReprint: boolean;
  /** PDF export only: the base name of the written file. */
  fileName?: string;
}

export interface LogoDto {
  /** Content-addressed asset key: `<sha256>.png|jpg`. */
  asset: string;
  /** For display in the settings screen (CSP allows data: images). */
  dataUrl: string;
}

export interface LogoChoiceDto {
  outcome: 'UPDATED' | 'CANCELLED';
  logo: LogoDto | null;
}

// ---- the print model (T13 may mirror this for report printing) ----

export interface PrintDiscountStage {
  sequence: number;
  percentageBps: PercentageBps;
  amount: Rupiah;
}

export interface PrintLine {
  position: number;
  itemType: LineItemType;
  title: string;
  quantity: number;
  unitLabel: string | null;
  unitPrice: Rupiah;
  subtotal: Rupiah;
  discounts: PrintDiscountStage[];
  discountAmount: Rupiah;
  amount: Rupiah;
  mechanicName: string | null;
}

export interface PrintPayment {
  method: PaymentMethod;
  amount: Rupiah;
  paidAt: Instant;
  /** `YYYY-MM-DD HH:mm` in the shop timezone. */
  paidAtLocal: string;
  reference: string | null;
  receivedBy: string;
}

/**
 * Everything any layout prints, with every money value as a Rupiah string.
 * Templates format these; they never recompute money.
 */
export interface InvoicePrintModel {
  language: Language;
  timezone: string;
  invoiceId: UUID;
  invoiceNumber: string;
  status: 'FINALIZED' | 'VOID';
  /** A PRINTED print job exists for this invoice. */
  isReprint: boolean;
  void: {
    reason: string;
    voidedAtLocal: string;
    voidedBy: string;
  } | null;
  shop: {
    name: string;
    address: string;
    phoneNumber: string | null;
    email: string | null;
    invoiceFooter: string | null;
    /** Asset key from the snapshot (null: none, or finalized before logos). */
    logo: string | null;
  };
  invoiceDate: LocalDate;
  finalizedAt: Instant;
  finalizedAtLocal: string;
  topDays: number;
  dueDate: LocalDate;
  channel: string;
  cashier: string;
  customer: { name: string | null; phoneNumber: string | null } | null;
  vehicle: { plateNumber: string | null; description: string | null } | null;
  odometerKm: number | null;
  note: string | null;
  lines: PrintLine[];
  invoiceDiscounts: PrintDiscountStage[];
  subtotal: Rupiah;
  itemDiscountAmount: Rupiah;
  invoiceDiscountAmount: Rupiah;
  discountAmount: Rupiah;
  amount: Rupiah;
  payments: PrintPayment[];
  paidAmount: Rupiah;
  outstanding: Rupiah;
  paymentStatus: PaymentStatus;
}
