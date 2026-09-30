import { z } from 'zod';

/** Payment methods (spec 22). Shared by checkout allocations and payments. */
export const PAYMENT_METHODS = [
  'CASH',
  'QRIS',
  'BANK_TRANSFER',
  'DEBIT_CARD',
  'CREDIT_CARD',
  'OTHER',
] as const;
export const paymentMethodSchema = z.enum(
  PAYMENT_METHODS,
  'validation.invalid',
);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
