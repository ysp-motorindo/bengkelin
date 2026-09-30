import type { AppDatabase } from '@/main/database/connection';
import { bool, flag, textOrNull, toNumber } from '@/main/database/rows';
import type { OwnershipDto, VehicleDto } from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';

interface VehicleRow {
  id: string;
  plate_number: string;
  normalized_plate_number: string;
  vehicle_model_id: string | null;
  model_name: string | null;
  brand_id: string | null;
  brand_name: string | null;
  year: bigint | null;
  color: string | null;
  notes: string | null;
  is_active: bigint;
  created_at: string;
  updated_at: string;
  owner_id: string | null;
  owner_name: string | null;
  owner_phone: string | null;
}

export function toVehicleDto(row: VehicleRow): VehicleDto {
  const ownerId = textOrNull(row.owner_id);
  return {
    id: row.id,
    plateNumber: row.plate_number,
    normalizedPlateNumber: row.normalized_plate_number,
    brandId: textOrNull(row.brand_id),
    brandName: textOrNull(row.brand_name),
    vehicleModelId: textOrNull(row.vehicle_model_id),
    modelName: textOrNull(row.model_name),
    year: row.year === null ? null : toNumber(row.year),
    color: textOrNull(row.color),
    notes: textOrNull(row.notes),
    isActive: bool(row.is_active),
    activeOwnerId: ownerId,
    activeOwner: ownerId
      ? {
          id: ownerId,
          name: textOrNull(row.owner_name),
          phoneNumber: textOrNull(row.owner_phone),
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface OwnershipRow {
  id: string;
  vehicle_id: string;
  customer_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  effective_from: string;
  effective_until: string | null;
}

export function toOwnershipDto(row: OwnershipRow): OwnershipDto {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    customerId: row.customer_id,
    customerName: textOrNull(row.customer_name),
    customerPhone: textOrNull(row.customer_phone),
    effectiveFrom: row.effective_from,
    effectiveUntil: textOrNull(row.effective_until),
  };
}

/** A vehicle joined to its model, brand and current (open) ownership. */
const VEHICLE_SELECT = `
  SELECT v.id, v.plate_number, v.normalized_plate_number, v.vehicle_model_id,
         m.name AS model_name, b.id AS brand_id, b.name AS brand_name,
         v.year, v.color, v.notes, v.is_active, v.created_at, v.updated_at,
         o.customer_id AS owner_id, c.name AS owner_name, c.phone_number AS owner_phone
  FROM vehicles v
  LEFT JOIN vehicle_models m ON m.id = v.vehicle_model_id
  LEFT JOIN vehicle_brands b ON b.id = m.brand_id
  LEFT JOIN vehicle_ownerships o ON o.vehicle_id = v.id AND o.effective_until IS NULL
  LEFT JOIN customers c ON c.id = o.customer_id`;

export interface VehicleFields {
  plateNumber: string;
  normalizedPlateNumber: string;
  vehicleModelId: string | null;
  year: number | null;
  color: string | null;
  notes: string | null;
}

export interface ActiveOwnership {
  id: string;
  customerId: string;
  effectiveFrom: Instant;
}

export interface ModelWithBrand {
  modelId: string;
  brandId: string;
  modelActive: boolean;
  brandActive: boolean;
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export class VehicleRepository {
  constructor(private readonly db: AppDatabase) {}

  find(id: string): VehicleDto | undefined {
    const row = this.db.prepare(`${VEHICLE_SELECT} WHERE v.id = ?`).get(id) as
      | VehicleRow
      | undefined;
    return row && toVehicleDto(row);
  }

  findByNormalizedPlate(normalized: string): VehicleDto | undefined {
    const row = this.db
      .prepare(`${VEHICLE_SELECT} WHERE v.normalized_plate_number = ?`)
      .get(normalized) as VehicleRow | undefined;
    return row && toVehicleDto(row);
  }

  /** Exact matches first, then prefix, then substring; capped. */
  searchByPlate(normalized: string, limit: number): VehicleDto[] {
    const pattern = likePattern(normalized);
    return (
      this.db
        .prepare(
          `${VEHICLE_SELECT}
           WHERE v.normalized_plate_number LIKE ? ESCAPE '\\'
           ORDER BY (v.normalized_plate_number = ?) DESC,
                    (v.normalized_plate_number LIKE ? ESCAPE '\\') DESC,
                    v.normalized_plate_number
           LIMIT ?`,
        )
        .all(
          pattern,
          normalized,
          `${pattern.slice(1)}`,
          BigInt(limit),
        ) as VehicleRow[]
    ).map(toVehicleDto);
  }

  listOwnedBy(customerId: string): VehicleDto[] {
    return (
      this.db
        .prepare(
          `${VEHICLE_SELECT} WHERE o.customer_id = ? ORDER BY v.normalized_plate_number`,
        )
        .all(customerId) as VehicleRow[]
    ).map(toVehicleDto);
  }

  findModelWithBrand(modelId: string): ModelWithBrand | undefined {
    const row = this.db
      .prepare(
        `SELECT m.id AS model_id, m.brand_id, m.is_active AS model_active, b.is_active AS brand_active
         FROM vehicle_models m JOIN vehicle_brands b ON b.id = m.brand_id
         WHERE m.id = ?`,
      )
      .get(modelId) as
      | {
          model_id: string;
          brand_id: string;
          model_active: bigint;
          brand_active: bigint;
        }
      | undefined;
    return (
      row && {
        modelId: row.model_id,
        brandId: row.brand_id,
        modelActive: bool(row.model_active),
        brandActive: bool(row.brand_active),
      }
    );
  }

  currentModelId(vehicleId: string): string | null {
    const row = this.db
      .prepare('SELECT vehicle_model_id FROM vehicles WHERE id = ?')
      .get(vehicleId) as { vehicle_model_id: string | null } | undefined;
    return row?.vehicle_model_id ?? null;
  }

  insert(id: string, fields: VehicleFields, now: Instant): void {
    this.db
      .prepare(
        `INSERT INTO vehicles (id, vehicle_model_id, plate_number, normalized_plate_number,
           year, color, notes, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.vehicleModelId,
        fields.plateNumber,
        fields.normalizedPlateNumber,
        fields.year === null ? null : BigInt(fields.year),
        fields.color,
        fields.notes,
        flag(true),
        now,
        now,
      );
  }

  update(id: string, fields: VehicleFields, now: Instant): void {
    this.db
      .prepare(
        `UPDATE vehicles SET vehicle_model_id = ?, plate_number = ?, normalized_plate_number = ?,
           year = ?, color = ?, notes = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        fields.vehicleModelId,
        fields.plateNumber,
        fields.normalizedPlateNumber,
        fields.year === null ? null : BigInt(fields.year),
        fields.color,
        fields.notes,
        now,
        id,
      );
  }

  setActive(id: string, active: boolean, now: Instant): void {
    this.db
      .prepare('UPDATE vehicles SET is_active = ?, updated_at = ? WHERE id = ?')
      .run(flag(active), now, id);
  }

  activeOwnership(vehicleId: string): ActiveOwnership | undefined {
    const row = this.db
      .prepare(
        `SELECT id, customer_id, effective_from FROM vehicle_ownerships
         WHERE vehicle_id = ? AND effective_until IS NULL`,
      )
      .get(vehicleId) as
      | { id: string; customer_id: string; effective_from: string }
      | undefined;
    return (
      row && {
        id: row.id,
        customerId: row.customer_id,
        effectiveFrom: row.effective_from,
      }
    );
  }

  closeOwnership(id: string, until: Instant): void {
    this.db
      .prepare('UPDATE vehicle_ownerships SET effective_until = ? WHERE id = ?')
      .run(until, id);
  }

  openOwnership(
    id: string,
    vehicleId: string,
    customerId: string,
    from: Instant,
  ): void {
    this.db
      .prepare(
        `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, effective_from, effective_until)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(id, vehicleId, customerId, from);
  }

  /** Newest first. */
  ownershipHistory(vehicleId: string): OwnershipDto[] {
    return (
      this.db
        .prepare(
          `SELECT o.id, o.vehicle_id, o.customer_id, c.name AS customer_name,
                  c.phone_number AS customer_phone, o.effective_from, o.effective_until
           FROM vehicle_ownerships o JOIN customers c ON c.id = o.customer_id
           WHERE o.vehicle_id = ?
           ORDER BY o.effective_from DESC, o.id`,
        )
        .all(vehicleId) as OwnershipRow[]
    ).map(toOwnershipDto);
  }
}
