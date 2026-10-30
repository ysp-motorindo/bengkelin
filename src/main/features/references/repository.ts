import type { AppDatabase } from '@/main/database/connection';
import { bool, flag, textOrNull } from '@/main/database/rows';
import type { ReferenceDto, ReferenceEntity } from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';

interface ReferenceRow {
  id: string;
  label: string;
  code: string | null;
  phone_number: string | null;
  brand_id: string | null;
  address?: string | null;
  city?: string | null;
  is_active: bigint;
}

export function toReferenceDto(
  entity: ReferenceEntity,
  row: ReferenceRow,
): ReferenceDto {
  return {
    address: row.address ?? null,
    city: row.city ?? null,
    entity,
    id: row.id,
    label: row.label,
    code: textOrNull(row.code),
    phoneNumber: textOrNull(row.phone_number),
    brandId: textOrNull(row.brand_id),
    isActive: bool(row.is_active),
  };
}

const TABLES: Record<ReferenceEntity, string> = {
  mechanic: 'mechanics',
  vehicleBrand: 'vehicle_brands',
  vehicleModel: 'vehicle_models',
  channel: 'channels',
  unit: 'units',
  sales: 'sales',
  expedition: 'expeditions',
};

/** Projects every entity onto the same six columns. */
const SELECTS: Record<ReferenceEntity, string> = {
  sales:
    'SELECT id, label, code, phone_number, address, city, NULL AS brand_id, is_active FROM sales',
  expedition:
    'SELECT id, label, code, NULL AS phone_number, address, city, NULL AS brand_id, is_active FROM expeditions',
  mechanic:
    'SELECT id, name AS label, NULL AS code, phone_number, NULL AS brand_id, is_active FROM mechanics',
  vehicleBrand:
    'SELECT id, name AS label, NULL AS code, NULL AS phone_number, NULL AS brand_id, is_active FROM vehicle_brands',
  vehicleModel:
    'SELECT id, name AS label, NULL AS code, NULL AS phone_number, brand_id, is_active FROM vehicle_models',
  channel:
    'SELECT id, label, code, NULL AS phone_number, NULL AS brand_id, is_active FROM channels',
  unit: 'SELECT id, label, code, NULL AS phone_number, NULL AS brand_id, is_active FROM units',
};

export class ReferenceRepository {
  constructor(private readonly db: AppDatabase) {}

  find(entity: ReferenceEntity, id: string): ReferenceDto | undefined {
    const row = this.db.prepare(`${SELECTS[entity]} WHERE id = ?`).get(id) as
      | ReferenceRow
      | undefined;
    return row && toReferenceDto(entity, row);
  }

  list(
    entity: ReferenceEntity,
    options: { activeOnly: boolean; brandId?: string | undefined },
  ): ReferenceDto[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.activeOnly) where.push('is_active = 1');
    if (entity === 'vehicleModel' && options.brandId) {
      where.push('brand_id = ?');
      params.push(options.brandId);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    return (
      this.db
        .prepare(`${SELECTS[entity]}${clause} ORDER BY label COLLATE NOCASE`)
        .all(...params) as ReferenceRow[]
    ).map((row) => toReferenceDto(entity, row));
  }

  setActive(
    entity: ReferenceEntity,
    id: string,
    isActive: boolean,
    now: Instant,
  ): void {
    // Table names come from the fixed map above, never from input.
    if (
      entity === 'mechanic' ||
      entity === 'sales' ||
      entity === 'expedition'
    ) {
      this.db
        .prepare(
          `UPDATE ${TABLES[entity]} SET is_active = ?, updated_at = ? WHERE id = ?`,
        )
        .run(flag(isActive), now, id);
      return;
    }
    this.db
      .prepare(`UPDATE ${TABLES[entity]} SET is_active = ? WHERE id = ?`)
      .run(flag(isActive), id);
  }

  saveContact(
    entity: 'sales' | 'expedition',
    id: string,
    code: string,
    label: string,
    address: string | null,
    city: string | null,
    phone: string | null,
    now: Instant,
  ): void {
    const phoneColumn = entity === 'sales' ? ', phone_number' : '';
    const phoneValue = entity === 'sales' ? ', @phone' : '';
    const phoneUpdate = entity === 'sales' ? ', phone_number = @phone' : '';
    this.db
      .prepare(`INSERT INTO ${TABLES[entity]} (id, code, label, address, city, created_at, updated_at${phoneColumn})
      VALUES (@id, @code, @label, @address, @city, @now, @now${phoneValue})
      ON CONFLICT(id) DO UPDATE SET label = @label, address = @address, city = @city, updated_at = @now${phoneUpdate}`)
      .run({
        id,
        code,
        label,
        address,
        city,
        now,
        ...(entity === 'sales' ? { phone } : {}),
      });
  }

  insertMechanic(
    id: string,
    name: string,
    phone: string | null,
    now: Instant,
  ): void {
    this.db
      .prepare(
        'INSERT INTO mechanics (id, name, phone_number, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
      )
      .run(id, name, phone, now, now);
  }

  updateMechanic(
    id: string,
    name: string,
    phone: string | null,
    now: Instant,
  ): void {
    this.db
      .prepare(
        'UPDATE mechanics SET name = ?, phone_number = ?, updated_at = ? WHERE id = ?',
      )
      .run(name, phone, now, id);
  }

  insertBrand(id: string, name: string): void {
    this.db
      .prepare(
        'INSERT INTO vehicle_brands (id, name, is_active) VALUES (?, ?, 1)',
      )
      .run(id, name);
  }

  updateBrand(id: string, name: string): void {
    this.db
      .prepare('UPDATE vehicle_brands SET name = ? WHERE id = ?')
      .run(name, id);
  }

  insertModel(id: string, brandId: string, name: string): void {
    this.db
      .prepare(
        'INSERT INTO vehicle_models (id, brand_id, name, is_active) VALUES (?, ?, ?, 1)',
      )
      .run(id, brandId, name);
  }

  updateModel(id: string, name: string): void {
    this.db
      .prepare('UPDATE vehicle_models SET name = ? WHERE id = ?')
      .run(name, id);
  }

  insertCoded(
    entity: 'channel' | 'unit',
    id: string,
    code: string,
    label: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO ${TABLES[entity]} (id, code, label, is_active) VALUES (?, ?, ?, 1)`,
      )
      .run(id, code, label);
  }

  updateCodedLabel(
    entity: 'channel' | 'unit',
    id: string,
    label: string,
  ): void {
    this.db
      .prepare(`UPDATE ${TABLES[entity]} SET label = ? WHERE id = ?`)
      .run(label, id);
  }
}
