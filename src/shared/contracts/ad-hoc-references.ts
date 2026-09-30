import { z } from 'zod';
import type { Instant, Rupiah } from '../primitives';
import type { UUID } from './common';

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
