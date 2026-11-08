import { z } from 'zod';
import type { Instant, LocalDate, Rupiah } from '../primitives';
import { localDateSchema, uuidSchema, type UUID } from './common';
import type { CashierRefDto } from './drafts';
import type { PaymentMethod } from './payments';
import type { PrintFailureCode, PrintOutcome, PrintPageInfo } from './printing';

/**
 * Daily report (spec 33, 59; Part A "Void reporting", A.5 "Reports use and
 * display the configured shop timezone").
 *
 * A calendar day in the shop timezone, never a cashier shift. Three activities
 * are kept strictly apart, each bucketed by its own instant:
 *  - sales:    issued invoices whose finalizedAt falls on the day, INCLUDING
 *              ones voided later (a sale stays on its original day);
 *  - voids:    invoices whose voidedAt falls on the day, whenever they were
 *              finalized; their net amount is deducted on the void day;
 *  - payments: payments whose paidAt falls on the day, split by whether the
 *              invoice was finalized that same day or earlier.
 *
 * The screen, the CSV export and the printed report all render ONE
 * `DailyReport` object; none of them recomputes a figure.
 */

export const dailyReportInputSchema = z.strictObject({
  /** The calendar day in the shop timezone. */
  date: localDateSchema,
  /**
   * Sales: the finalizing cashier. Payments: the receiving cashier. Voids:
   * the voiding cashier.
   */
  cashierId: uuidSchema.optional(),
  /** The invoice's channel; excludes opening-balance receipts. */
  channelId: uuidSchema.optional(),
});
export type DailyReportInput = z.input<typeof dailyReportInputSchema>;
export type DailyReportData = z.output<typeof dailyReportInputSchema>;

export interface ChannelRefDto {
  id: UUID;
  label: string;
}

export interface DailyReportChannelRow {
  /** Current channel label (grouped by id). */
  channel: ChannelRefDto;
  invoiceCount: number;
  netBeforeVoids: Rupiah;
}

export interface DailyReportCashierRow {
  /** The finalizing cashier, current display name (grouped by id). */
  cashier: CashierRefDto;
  invoiceCount: number;
  netBeforeVoids: Rupiah;
}

export interface DailyReportVoidRow {
  invoiceId: UUID;
  invoiceNumber: string;
  finalizedAt: Instant;
  /** The sale's own business day (may be earlier than the report day). */
  finalizedDate: LocalDate;
  voidedAt: Instant;
  /** `YYYY-MM-DD HH:mm` in the shop timezone. */
  voidedAtLocal: string;
  /** The invoice's net amount: what this void deducts. */
  amount: Rupiah;
  reason: string;
  /** Name snapshot taken when the invoice was voided. */
  voidedBy: CashierRefDto;
  channel: ChannelRefDto;
}

export interface DailyReportMethodRow {
  method: PaymentMethod;
  count: number;
  amount: Rupiah;
}

export interface PurchaseActivity {
  billCount: number;
  grossSubtotal: Rupiah;
  discountAmount: Rupiah;
  netBeforeAdjustments: Rupiah;
  voidCount: number;
  voidDeduction: Rupiah;
  creditCount: number;
  creditAmount: Rupiah;
  netAfterAdjustments: string;
}
export interface PurchaseCashFlow {
  amount: Rupiah;
  count: number;
  byMethod: DailyReportMethodRow[];
}
export interface PurchaseReporting {
  purchases: PurchaseActivity;
  purchasePayments: PurchaseCashFlow;
  supplierRefunds: PurchaseCashFlow;
}
export interface DailyReport extends PurchaseReporting {
  date: LocalDate;
  /** The shop timezone the day was computed in (shown on every surface). */
  timezone: string;
  /** `[start, end)` of the day as canonical instants. */
  range: { start: Instant; end: Instant };
  generatedAt: Instant;
  /** `YYYY-MM-DD HH:mm` in the shop timezone. */
  generatedAtLocal: string;
  filters: {
    cashier: CashierRefDto | null;
    channel: ChannelRefDto | null;
  };
  sales: {
    invoiceCount: number;
    /** Sum of subtotals (before any discount). */
    grossSubtotal: Rupiah;
    itemDiscounts: Rupiah;
    invoiceDiscounts: Rupiah;
    /** Sum of invoice amounts = gross - item - invoice discounts. */
    netBeforeVoids: Rupiah;
    /** Channels with activity, by label. */
    byChannel: DailyReportChannelRow[];
    /** Finalizing cashiers with activity, by name. */
    byCashier: DailyReportCashierRow[];
  };
  voids: {
    count: number;
    deduction: Rupiah;
    /** Oldest void first. */
    invoices: DailyReportVoidRow[];
  };
  /**
   * netBeforeVoids - voids.deduction. A sales money field that may be
   * negative (a day with a void of an earlier sale and little new sales):
   * a canonical integer string with a leading '-', e.g. '-250000'.
   */
  netAfterVoids: string;
  payments: {
    received: Rupiah;
    count: number;
    /** All six methods in PAYMENT_METHODS order, zeros included. */
    byMethod: DailyReportMethodRow[];
    /** Received on invoices finalized on this same day. */
    sameDayInvoices: Rupiah;
    /** Received on invoices finalized on an earlier day. */
    olderInvoices: Rupiah;
    openingBalanceRepayments: Rupiah;
  };
}

/** The printed report (A4), as shown in the in-app preview. */
export interface ReportPreviewDto {
  html: string;
  pageInfo: PrintPageInfo;
}

/** Printing codes (PRINTER_NOT_FOUND {printerName}, PRINT_FAILED) or a failed CSV write. */
export type ReportFailureCode = PrintFailureCode | 'EXPORT_FAILED';

/** Print or CSV export result. A failure is an outcome, never an error. */
export interface ReportOutcomeDto {
  /** PRINTED also means "CSV written" (as for T12's PDF export). */
  outcome: PrintOutcome;
  code?: ReportFailureCode;
  params?: Record<string, string>;
  /** CSV export only: the base name of the written file. */
  fileName?: string;
}
