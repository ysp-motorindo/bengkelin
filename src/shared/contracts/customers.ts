import { z } from 'zod';
import type { Instant } from '../primitives';
import {
  optionalLocalDate,
  optionalPhone,
  optionalText,
  uuidSchema,
  type UUID,
} from './common';
import type { VehicleDto } from './vehicles';

export const saveCustomerInputSchema = z.strictObject({
  /** Present: edit that customer. Absent: create. */
  id: uuidSchema.optional(),
  name: optionalText(120),
  phoneNumber: optionalPhone,
  email: z
    .string('validation.invalid')
    .trim()
    .max(200, 'validation.tooLong')
    .refine(
      (v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
      'validation.invalidEmail',
    )
    .nullish()
    .transform((value) => (value ? value : null)),
  birthdate: optionalLocalDate,
  address: optionalText(300),
  rt: optionalText(10),
  rw: optionalText(10),
  kelurahan: optionalText(100),
  kecamatan: optionalText(100),
  cityOrRegency: optionalText(100),
  province: optionalText(100),
  postalCode: optionalText(10),
  /** Save even though another customer has the same normalized phone. */
  acknowledgeDuplicates: z.boolean('validation.invalid').optional(),
});
export type SaveCustomerInput = z.input<typeof saveCustomerInputSchema>;
export type SaveCustomerData = z.output<typeof saveCustomerInputSchema>;

export const searchCustomersInputSchema = z.strictObject({
  query: z.string('validation.required').trim().max(100, 'validation.tooLong'),
  limit: z.number('validation.invalid').int().min(1).max(50).optional(),
});
export type SearchCustomersInput = z.input<typeof searchCustomersInputSchema>;

export const customerIdInputSchema = z.strictObject({ id: uuidSchema });
export type CustomerIdInput = z.infer<typeof customerIdInputSchema>;

export interface CustomerDto {
  id: UUID;
  name: string | null;
  phoneNumber: string | null;
  email: string | null;
  birthdate: string | null;
  address: string | null;
  rt: string | null;
  rw: string | null;
  kelurahan: string | null;
  kecamatan: string | null;
  cityOrRegency: string | null;
  province: string | null;
  postalCode: string | null;
  createdAt: Instant;
  updatedAt: Instant;
}

export type SaveCustomerResult =
  | { saved: true; customer: CustomerDto }
  | {
      saved: false;
      /** Nothing was written. Resend with `acknowledgeDuplicates: true` to keep both. */
      warning: { code: 'DUPLICATE_PHONE'; matches: CustomerDto[] };
    };

export interface SearchCustomersResult {
  results: CustomerDto[];
}

export interface CustomerDetailDto {
  customer: CustomerDto;
  /** Vehicles this customer currently owns. */
  vehicles: VehicleDto[];
}
