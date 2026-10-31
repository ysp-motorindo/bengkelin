import { z } from 'zod';
import {
  DomainError,
  parseRupiah,
  type Instant,
  type Rupiah,
} from '../primitives';
import { isInstant } from '../time';
import { optionalText, requiredText, uuidSchema, type UUID } from './common';

export const CATALOG_ITEM_TYPES = ['STOCK_ITEM', 'SERVICE'] as const;
export const catalogItemTypeSchema = z.enum(
  CATALOG_ITEM_TYPES,
  'validation.invalid',
);
export type CatalogItemType = z.infer<typeof catalogItemTypeSchema>;

/** Canonical UTC instant text (`YYYY-MM-DDTHH:mm:ss.SSSZ`). Text order is time order. */
export const instantSchema = z
  .string('validation.required')
  .refine(isInstant, 'validation.invalidInstant');

/** Non-negative whole-rupiah decimal string; parsed with `parseRupiah`, never `Number`. */
export const priceSchema = z.string('validation.required').refine((value) => {
  try {
    return parseRupiah(value) >= 0n;
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}, 'validation.invalidMoney');

export const saveCatalogItemInputSchema = z
  .strictObject({
    /** Present: edit that item. Absent: create. */
    id: uuidSchema.optional(),
    type: catalogItemTypeSchema,
    title: requiredText(200),
    description: optionalText(1000),
    sku: optionalText(64),
    unitId: uuidSchema,
    /** Grams; blank = not set. */
    weight: z
      .number('validation.invalid')
      .int('validation.invalid')
      .min(0, 'validation.invalid')
      .max(1_000_000_000, 'validation.invalid')
      .nullish()
      .transform((value) => value ?? null),
    /** Defaults from the type: STOCK_ITEM tracks, SERVICE never does. */
    trackInventory: z.boolean('validation.invalid').optional(),
    isActive: z.boolean('validation.invalid').optional(),
  })
  .refine((value) => !(value.type === 'SERVICE' && value.trackInventory), {
    message: 'validation.serviceNotTracked',
    path: ['trackInventory'],
  });
export type SaveCatalogItemInput = z.input<typeof saveCatalogItemInputSchema>;
export type SaveCatalogItemData = z.output<typeof saveCatalogItemInputSchema>;

export const saveBarcodesInputSchema = z.strictObject({
  catalogItemId: uuidSchema,
  /**
   * Upserted by value: listed barcodes are added or (de)activated, unlisted
   * ones are left as they are. Nothing is ever deleted.
   */
  barcodes: z
    .array(
      z.strictObject({
        barcode: z
          .string('validation.required')
          .trim()
          .min(1, 'validation.required')
          .max(100, 'validation.tooLong'),
        isActive: z.boolean('validation.invalid'),
      }),
    )
    .max(50, 'validation.tooLong')
    .refine(
      (list) =>
        new Set(list.map((entry) => entry.barcode)).size === list.length,
      'validation.duplicate',
    ),
});
export type SaveBarcodesInput = z.input<typeof saveBarcodesInputSchema>;
export type SaveBarcodesData = z.output<typeof saveBarcodesInputSchema>;

export const catalogIdInputSchema = z.strictObject({ id: uuidSchema });
export type CatalogIdInput = z.infer<typeof catalogIdInputSchema>;

export const lookupBarcodeInputSchema = z.strictObject({
  code: z.string('validation.required').max(100, 'validation.tooLong'),
});
export type LookupBarcodeInput = z.infer<typeof lookupBarcodeInputSchema>;

export const searchCatalogInputSchema = z.strictObject({
  query: z.string('validation.required').trim().max(100, 'validation.tooLong'),
  includeInactive: z.boolean('validation.invalid').optional(),
  limit: z.number('validation.invalid').int().min(1).max(50).optional(),
  offset: z.number('validation.invalid').int().min(0).optional(),
});
export type SearchCatalogInput = z.input<typeof searchCatalogInputSchema>;

export const listPricesInputSchema = z.strictObject({
  catalogItemId: uuidSchema,
});
export type ListPricesInput = z.infer<typeof listPricesInputSchema>;

/** No end timestamp exists anywhere in this input. */
export const priceChangeInputSchema = z.strictObject({
  catalogItemId: uuidSchema,
  channelId: uuidSchema,
  effectiveStartAt: instantSchema,
  price: priceSchema,
  /** Present: an explicit correction of that (non-superseded) revision. */
  correctsPriceId: uuidSchema.optional(),
  reason: optionalText(500),
});
export type PriceChangeInput = z.input<typeof priceChangeInputSchema>;
export type PriceChangeData = z.output<typeof priceChangeInputSchema>;

export const applyPriceChangeInputSchema = z.strictObject({
  token: uuidSchema,
});
export type ApplyPriceChangeInput = z.infer<typeof applyPriceChangeInputSchema>;

export interface BarcodeDto {
  id: UUID;
  barcode: string;
  isActive: boolean;
}

export interface CatalogItemDto {
  id: UUID;
  type: CatalogItemType;
  title: string;
  description: string | null;
  sku: string | null;
  unitId: UUID;
  unitCode: string;
  unitLabel: string;
  /** Grams. */
  weight: number | null;
  trackInventory: boolean;
  isActive: boolean;
  barcodes: BarcodeDto[];
  createdAt: Instant;
  updatedAt: Instant;
}

export interface SearchCatalogResult {
  results: CatalogItemDto[];
}

export interface ResolvedPrice {
  priceId: UUID;
  price: Rupiah;
  effectiveStartAt: Instant;
}

/**
 * CURRENT: resolves right now. SCHEDULED: starts in the future.
 * PREVIOUS: non-superseded but replaced by a later start. SUPERSEDED: an old
 * revision kept after an explicit correction.
 */
export type PricePointState =
  | 'CURRENT'
  | 'SCHEDULED'
  | 'PREVIOUS'
  | 'SUPERSEDED';

export interface PricePointDto {
  id: UUID;
  catalogItemId: UUID;
  channelId: UUID;
  effectiveStartAt: Instant;
  price: Rupiah;
  state: PricePointState;
  createdAt: Instant;
  createdByCashierId: UUID;
  supersededAt: Instant | null;
  supersededByCashierId: UUID | null;
  /** Set on a correction: the revision it replaced. */
  supersedesPriceId: UUID | null;
  /** Set on a correction: why. */
  correctionReason: string | null;
  /** Set on a superseded point: the correction that replaced it. */
  supersededByPriceId: UUID | null;
  /** Set on a superseded point: the reason given by that correction. */
  supersededReason: string | null;
}

export interface PriceTimelineDto {
  catalogItemId: UUID;
  /** Shop timezone (IANA) the timeline should be shown in. */
  timezone: string;
  now: Instant;
  points: PricePointDto[];
}

export interface PricePointRef {
  priceId: UUID;
  price: Rupiah;
  effectiveStartAt: Instant;
}

export interface PriceConflict {
  code: 'PRICE_START_CONFLICT';
  /** The non-superseded point already occupying the exact start. */
  priceId: UUID;
}

export interface PricePreviewDto {
  /** Opaque, single-use, expires after about ten minutes. */
  token: UUID;
  expiresAt: Instant;
  catalogItemId: UUID;
  channelId: UUID;
  effectiveStartAt: Instant;
  price: Rupiah;
  /** The point that is effective at the proposed start today, if any. */
  current: PricePointRef | null;
  /** The revision an explicit correction would replace. */
  corrects: PricePointRef | null;
  /** Next scheduled non-superseded point after the start. Display only; nothing is stored. */
  successor: PricePointRef | null;
  timing: 'PAST' | 'FUTURE';
  conflicts: PriceConflict[];
}

export interface AppliedPriceChangeDto {
  point: PricePointDto;
  supersededPriceId: UUID | null;
}
