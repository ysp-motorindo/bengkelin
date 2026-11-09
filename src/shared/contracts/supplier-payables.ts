import { z } from 'zod';
import { uuidSchema } from './common';
import { pageInputSchema } from './invoice-history';
import { recordPaymentInputSchema, type PaymentStatus } from './invoices';
import type { PurchaseMoneyDto } from './purchases';
import type { Rupiah } from '../primitives';
export const supplierOpeningListInputSchema = z.strictObject({
  page: pageInputSchema,
});
export const supplierOpeningInputSchema = z.strictObject({
  supplierId: uuidSchema,
});
export const recordSupplierOpeningPaymentInputSchema = recordPaymentInputSchema
  .omit({ invoiceId: true })
  .extend({ supplierId: uuidSchema });
export type RecordSupplierOpeningPaymentInput = z.input<
  typeof recordSupplierOpeningPaymentInputSchema
>;
export type RecordSupplierOpeningPaymentData = z.output<
  typeof recordSupplierOpeningPaymentInputSchema
>;
export interface SupplierOpeningRow {
  supplierId: string;
  externalId: string | null;
  supplierName: string | null;
  asOfDate: string;
  originalAmount: Rupiah;
  paidAmount: Rupiah;
  outstandingAmount: Rupiah;
  paymentStatus: PaymentStatus;
}
export interface SupplierOpeningDetail extends SupplierOpeningRow {
  payments: PurchaseMoneyDto[];
}
export interface SupplierOpeningPage {
  items: SupplierOpeningRow[];
  total: number;
  pageNumber: number;
  pageSize: number;
  hasMore: boolean;
  totalOriginal: Rupiah;
  totalPaid: Rupiah;
  totalOutstanding: Rupiah;
}
