import { z } from 'zod';
import type { Instant, LocalDate, Rupiah } from '../primitives';
import { isLocalDate, uuidSchema, type UUID } from './common';
import type { CashierRefDto } from './drafts';
import type { PaymentStatus } from './invoices';

/**
 * Transaction history and receivables (spec 23, 34, 35).
 *
 * History lists issued invoices only (FINALIZED and VOID, never drafts) and
 * matches their FROZEN snapshots, so renaming a customer, changing a phone,
 * editing a plate or transferring a vehicle never changes what an old
 * invoice matches or shows (spec 60). Order: finalizedAt DESC, then id DESC.
 */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/** Blank text means "no filter". */
const filterText = (max: number) =>
  z
    .string('validation.invalid')
    .trim()
    .max(max, 'validation.tooLong')
    .transform((value) => (value ? value : undefined))
    .optional();

const filterDate = z
  .string('validation.invalid')
  .trim()
  .refine((v) => v === '' || isLocalDate(v), 'validation.invalidDate')
  .transform((value) => (value ? value : undefined))
  .optional();

export const invoiceSearchFiltersSchema = z.strictObject({
  /** Exact number or a prefix of it (case-insensitive). */
  invoiceNumber: filterText(40),
  /** Inclusive range on the invoice's calendar date (invoiceDate). */
  dateFrom: filterDate,
  dateTo: filterDate,
  /** Case-insensitive substring of the customer name snapshot. */
  customerName: filterText(120),
  /** Normalized like customer phones (08…, +628… match), substring. */
  phone: filterText(40),
  /** Normalized like plates (spaces, dashes, case ignored), substring. */
  plate: filterText(20),
  channelId: uuidSchema.optional(),
  /** The finalizing cashier. */
  cashierId: uuidSchema.optional(),
  status: z.enum(['FINALIZED', 'VOID'], 'validation.invalid').optional(),
  /** Derived from SUM(payments) versus the amount. */
  paymentStatus: z
    .enum(['UNPAID', 'PARTIALLY_PAID', 'PAID'], 'validation.invalid')
    .optional(),
});
export type InvoiceSearchFilters = z.input<typeof invoiceSearchFiltersSchema>;
export type InvoiceSearchFiltersData = z.output<
  typeof invoiceSearchFiltersSchema
>;

export const pageInputSchema = z
  .strictObject({
    /** 1-based. */
    number: z
      .number('validation.invalid')
      .int('validation.invalid')
      .min(1, 'validation.invalid')
      .max(1_000_000, 'validation.invalid')
      .default(1),
    size: z
      .number('validation.invalid')
      .int('validation.invalid')
      .min(1, 'validation.invalid')
      .max(MAX_PAGE_SIZE, 'validation.invalid')
      .default(DEFAULT_PAGE_SIZE),
  })
  .default({ number: 1, size: DEFAULT_PAGE_SIZE });
export type PageInput = z.input<typeof pageInputSchema>;
export type PageData = z.output<typeof pageInputSchema>;

export const invoiceSearchInputSchema = z.strictObject({
  filters: invoiceSearchFiltersSchema.default({}),
  page: pageInputSchema,
});
export type InvoiceSearchInput = z.input<typeof invoiceSearchInputSchema>;
export type InvoiceSearchData = z.output<typeof invoiceSearchInputSchema>;

export const RECEIVABLE_KINDS = ['OUTSTANDING', 'OVERDUE'] as const;
export type ReceivableKind = (typeof RECEIVABLE_KINDS)[number];

/**
 * Unpaid and partially paid FINALIZED invoices (VOID excluded). OVERDUE
 * also requires dueDate < today in the shop timezone: due today is not
 * overdue. Order: dueDate ASC, finalizedAt ASC, id ASC (oldest debt first).
 */
export const receivablesInputSchema = z.strictObject({
  kind: z.enum(RECEIVABLE_KINDS, 'validation.invalid'),
  page: pageInputSchema,
});
export type ReceivablesInput = z.input<typeof receivablesInputSchema>;
export type ReceivablesData = z.output<typeof receivablesInputSchema>;

/** One history / receivables row, from snapshots only. */
export interface InvoiceSummaryDto {
  id: UUID;
  invoiceNumber: string;
  invoiceDate: LocalDate;
  dueDate: LocalDate;
  finalizedAt: Instant;
  voidedAt: Instant | null;
  customerName: string | null;
  customerPhone: string | null;
  plateNumber: string | null;
  channel: { id: UUID; label: string };
  /** The finalizing cashier (name snapshot). */
  cashier: CashierRefDto;
  amount: Rupiah;
  paidAmount: Rupiah;
  /** amount - paidAmount (also on VOID, which can have no payments). */
  outstandingAmount: Rupiah;
  status: 'FINALIZED' | 'VOID';
  paymentStatus: PaymentStatus;
}

export interface InvoicePage {
  items: InvoiceSummaryDto[];
  /** Matching invoices over all pages. */
  total: number;
  pageNumber: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ReceivablesPage extends InvoicePage {
  kind: ReceivableKind;
  /** The shop's business day used for OVERDUE. */
  today: LocalDate;
  /** Sum of outstanding amounts over all pages. */
  totalOutstanding: Rupiah;
}
