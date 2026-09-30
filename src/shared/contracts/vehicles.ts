import { z } from 'zod';
import type { Instant } from '../primitives';
import { optionalText, uuidSchema, type UUID } from './common';

export const saveVehicleInputSchema = z
  .strictObject({
    /** Present: edit that vehicle. Absent: create (or reuse by plate). */
    id: uuidSchema.optional(),
    plateNumber: z
      .string('validation.required')
      .trim()
      .min(1, 'validation.required')
      .max(20, 'validation.tooLong')
      .refine((v) => /[A-Za-z0-9]/.test(v), 'validation.invalidPlate'),
    /** The brand the picker showed; the model must belong to it. */
    brandId: uuidSchema.nullish(),
    vehicleModelId: uuidSchema.nullish(),
    year: z
      .number('validation.invalid')
      .int('validation.invalid')
      .min(1900, 'validation.invalid')
      .max(2100, 'validation.invalid')
      .nullish(),
    color: optionalText(50),
    notes: optionalText(500),
    /** Create only: makes this customer the first owner of a new vehicle. */
    ownerCustomerId: uuidSchema.nullish(),
  })
  .refine((v) => v.id === undefined || !v.ownerCustomerId, {
    message: 'validation.invalid',
    path: ['ownerCustomerId'],
  });
export type SaveVehicleInput = z.input<typeof saveVehicleInputSchema>;
export type SaveVehicleData = z.output<typeof saveVehicleInputSchema>;

export const searchVehiclesInputSchema = z.strictObject({
  query: z.string('validation.required').trim().max(30, 'validation.tooLong'),
  limit: z.number('validation.invalid').int().min(1).max(50).optional(),
});
export type SearchVehiclesInput = z.input<typeof searchVehiclesInputSchema>;

export const vehicleIdInputSchema = z.strictObject({ id: uuidSchema });
export type VehicleIdInput = z.infer<typeof vehicleIdInputSchema>;

export const transferOwnershipInputSchema = z.strictObject({
  requestId: uuidSchema.optional(),
  vehicleId: uuidSchema,
  newCustomerId: uuidSchema,
});
export type OwnershipTransferInput = z.input<
  typeof transferOwnershipInputSchema
>;

export interface OwnerSummaryDto {
  id: UUID;
  name: string | null;
  phoneNumber: string | null;
}

export interface VehicleDto {
  id: UUID;
  /** Display text as entered. */
  plateNumber: string;
  normalizedPlateNumber: string;
  brandId: UUID | null;
  brandName: string | null;
  vehicleModelId: UUID | null;
  modelName: string | null;
  year: number | null;
  color: string | null;
  notes: string | null;
  isActive: boolean;
  /** Current owner (`effectiveUntil = null`), or null when unowned. */
  activeOwnerId: UUID | null;
  activeOwner: OwnerSummaryDto | null;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface OwnershipDto {
  id: UUID;
  vehicleId: UUID;
  customerId: UUID;
  customerName: string | null;
  customerPhone: string | null;
  effectiveFrom: Instant;
  effectiveUntil: Instant | null;
}

export interface VehicleDetailDto {
  vehicle: VehicleDto;
  /** Newest first. */
  ownerships: OwnershipDto[];
}

export interface SaveVehicleResult {
  vehicle: VehicleDto;
  /** True when the plate already existed: nothing was written; offer to reuse. */
  reusedExisting: boolean;
  warning: 'PLATE_EXISTS' | null;
}

export interface SearchVehiclesResult {
  results: VehicleDto[];
}
