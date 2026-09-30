import { z } from 'zod';
import { optionalPhone, requiredText, uuidSchema, type UUID } from './common';

export const REFERENCE_ENTITIES = [
  'mechanic',
  'vehicleBrand',
  'vehicleModel',
  'channel',
  'unit',
] as const;
export const referenceEntitySchema = z.enum(
  REFERENCE_ENTITIES,
  'validation.invalid',
);
export type ReferenceEntity = z.infer<typeof referenceEntitySchema>;

const codeSchema = z
  .string('validation.required')
  .trim()
  .min(1, 'validation.required')
  .max(30, 'validation.tooLong')
  .regex(/^[A-Za-z0-9_-]+$/, 'validation.codeFormat')
  .transform((value) => value.toUpperCase());

/** Channels and units: `code` is required on create and immutable after. */
const codedShape = {
  id: uuidSchema.optional(),
  code: codeSchema.optional(),
  label: requiredText(100),
};
const requireCodeOnCreate = (value: { id?: string; code?: string }) =>
  value.id !== undefined || value.code !== undefined;
const codeRequired = { message: 'validation.required', path: ['code'] };

export const saveReferenceInputSchema = z.discriminatedUnion('entity', [
  z.strictObject({
    entity: z.literal('mechanic'),
    id: uuidSchema.optional(),
    name: requiredText(100),
    phoneNumber: optionalPhone,
  }),
  z.strictObject({
    entity: z.literal('vehicleBrand'),
    id: uuidSchema.optional(),
    name: requiredText(100),
  }),
  z.strictObject({
    entity: z.literal('vehicleModel'),
    id: uuidSchema.optional(),
    brandId: uuidSchema,
    name: requiredText(100),
  }),
  z
    .strictObject({ entity: z.literal('channel'), ...codedShape })
    .refine(requireCodeOnCreate, codeRequired),
  z
    .strictObject({ entity: z.literal('unit'), ...codedShape })
    .refine(requireCodeOnCreate, codeRequired),
]);
export type SaveReferenceInput = z.input<typeof saveReferenceInputSchema>;
export type SaveReferenceData = z.output<typeof saveReferenceInputSchema>;

export const referenceIdInputSchema = z.strictObject({
  entity: referenceEntitySchema,
  id: uuidSchema,
});
export type ReferenceIdInput = z.infer<typeof referenceIdInputSchema>;

export const listReferencesInputSchema = z.strictObject({
  entity: referenceEntitySchema,
  /** Vehicle models only: restrict to one brand. */
  brandId: uuidSchema.optional(),
});
export type ListReferencesInput = z.infer<typeof listReferencesInputSchema>;

/**
 * One shape for every reference entity: `label` is the name (mechanic, brand,
 * model) or the editable label (channel, unit); `code` is set for channels and
 * units; `phoneNumber` for mechanics; `brandId` for models.
 */
export interface ReferenceDto {
  entity: ReferenceEntity;
  id: UUID;
  label: string;
  code: string | null;
  phoneNumber: string | null;
  brandId: UUID | null;
  isActive: boolean;
}
