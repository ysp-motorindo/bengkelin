import { z } from 'zod';
import type { Instant, Rupiah } from '../primitives';
import { optionalText, uuidSchema, type UUID } from './common';

/** AdHocItemReference types (spec 12). */
export const AD_HOC_ITEM_TYPES = ['SERVICE', 'NON_STOCK_ITEM'] as const;
export const adHocItemTypeSchema = z.enum(
  AD_HOC_ITEM_TYPES,
  'validation.invalid',
);
export type AdHocItemType = z.infer<typeof adHocItemTypeSchema>;

/** Autocomplete for custom lines. Any signed-in cashier; active rows only. */
export const searchAdHocReferencesInputSchema = z.strictObject({
  query: z.string('validation.required').trim().max(100, 'validation.tooLong'),
  type: adHocItemTypeSchema.optional(),
  limit: z.number('validation.invalid').int().min(1).max(50).optional(),
});
export type SearchAdHocReferencesInput = z.input<
  typeof searchAdHocReferencesInputSchema
>;

export interface AdHocReferenceDto {
  id: UUID;
  type: AdHocItemType;
  title: string;
  description: string | null;
  unitId: UUID | null;
  /** The price last used with this reference; a suggestion only. */
  defaultPrice: Rupiah | null;
  isActive: boolean;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface SearchAdHocReferencesResult {
  results: AdHocReferenceDto[];
}

/** ADMIN listing: inactive references included, optional title filter. */
export const listAdHocReferencesInputSchema = z.strictObject({
  query: z
    .string('validation.invalid')
    .trim()
    .max(100, 'validation.tooLong')
    .optional(),
});
export type ListAdHocReferencesInput = z.input<
  typeof listAdHocReferencesInputSchema
>;

export const adHocReferenceIdInputSchema = z.strictObject({ id: uuidSchema });
export type AdHocReferenceIdInput = z.infer<typeof adHocReferenceIdInputSchema>;

/** ADMIN: the description is the editable part (type and title identify it). */
export const updateAdHocReferenceInputSchema = z.strictObject({
  id: uuidSchema,
  description: optionalText(300),
});
export type UpdateAdHocReferenceInput = z.input<
  typeof updateAdHocReferenceInputSchema
>;
export type UpdateAdHocReferenceData = z.output<
  typeof updateAdHocReferenceInputSchema
>;
