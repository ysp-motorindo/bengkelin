import { z } from 'zod';
import { uuidSchema } from './common';
import { pageInputSchema } from './invoice-history';
import {
  recordPaymentInputSchema,
  type PaymentDto,
  type PaymentStatus,
} from './invoices';
import type { Rupiah } from '../primitives';
export const openingListInputSchema = z.strictObject({ page: pageInputSchema });
export const openingCustomerInputSchema = z.strictObject({
  customerId: uuidSchema,
});
export const recordOpeningPaymentInputSchema = recordPaymentInputSchema
  .omit({ invoiceId: true })
  .extend({ customerId: uuidSchema });
export type RecordOpeningPaymentInput = z.input<
  typeof recordOpeningPaymentInputSchema
>;
export type RecordOpeningPaymentData = z.output<
  typeof recordOpeningPaymentInputSchema
>;
export interface CustomerOpeningRow {
  customerId: string;
  externalId: string | null;
  customerName: string | null;
  asOfDate: string;
  originalAmount: Rupiah;
  paidAmount: Rupiah;
  outstandingAmount: Rupiah;
  paymentStatus: PaymentStatus;
}
export interface CustomerOpeningDetail extends CustomerOpeningRow {
  payments: Omit<PaymentDto, 'source'>[];
}
export interface CustomerOpeningPage {
  items: CustomerOpeningRow[];
  total: number;
  pageNumber: number;
  pageSize: number;
  hasMore: boolean;
  totalOriginal: Rupiah;
  totalPaid: Rupiah;
  totalOutstanding: Rupiah;
}
