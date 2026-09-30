import type { AppDatabase } from '@/main/database/connection';
import { textOrNull } from '@/main/database/rows';
import type { CustomerDto } from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';

interface CustomerRow {
  id: string;
  name: string | null;
  phone_number: string | null;
  email: string | null;
  birthdate: string | null;
  address: string | null;
  rt: string | null;
  rw: string | null;
  kelurahan: string | null;
  kecamatan: string | null;
  city_or_regency: string | null;
  province: string | null;
  postal_code: string | null;
  created_at: string;
  updated_at: string;
}

export function toCustomerDto(row: CustomerRow): CustomerDto {
  return {
    id: row.id,
    name: textOrNull(row.name),
    phoneNumber: textOrNull(row.phone_number),
    email: textOrNull(row.email),
    birthdate: textOrNull(row.birthdate),
    address: textOrNull(row.address),
    rt: textOrNull(row.rt),
    rw: textOrNull(row.rw),
    kelurahan: textOrNull(row.kelurahan),
    kecamatan: textOrNull(row.kecamatan),
    cityOrRegency: textOrNull(row.city_or_regency),
    province: textOrNull(row.province),
    postalCode: textOrNull(row.postal_code),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Editable customer fields (everything except identity and timestamps). */
export type CustomerFields = Omit<
  CustomerDto,
  'id' | 'createdAt' | 'updatedAt'
>;

const COLUMNS =
  'id, name, phone_number, email, birthdate, address, rt, rw, kelurahan, kecamatan, city_or_regency, province, postal_code, created_at, updated_at';

/** Escapes LIKE wildcards so user input is always matched literally. */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export class CustomerRepository {
  constructor(private readonly db: AppDatabase) {}

  find(id: string): CustomerDto | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM customers WHERE id = ?`)
      .get(id) as CustomerRow | undefined;
    return row && toCustomerDto(row);
  }

  /** Other customers with exactly this normalized phone (spec 36). */
  findByNormalizedPhone(
    normalizedPhone: string,
    excludingId?: string,
  ): CustomerDto[] {
    if (normalizedPhone === '') return [];
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM customers
           WHERE normalized_phone = ? AND id <> ?
           ORDER BY created_at, id`,
        )
        .all(normalizedPhone, excludingId ?? '') as CustomerRow[]
    ).map(toCustomerDto);
  }

  normalizedPhoneOf(id: string): string | undefined {
    const row = this.db
      .prepare('SELECT normalized_phone FROM customers WHERE id = ?')
      .get(id) as { normalized_phone: string } | undefined;
    return row?.normalized_phone;
  }

  /** Name (case-insensitive substring) or normalized-phone (substring) match. */
  search(
    query: string,
    normalizedPhoneQuery: string,
    limit: number,
  ): CustomerDto[] {
    const clauses: string[] = ["name LIKE ? ESCAPE '\\'"];
    const params: unknown[] = [likePattern(query)];
    if (normalizedPhoneQuery !== '') {
      clauses.push("normalized_phone LIKE ? ESCAPE '\\'");
      params.push(likePattern(normalizedPhoneQuery));
    }
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM customers
           WHERE ${clauses.join(' OR ')}
           ORDER BY name COLLATE NOCASE, created_at, id
           LIMIT ?`,
        )
        .all(...params, BigInt(limit)) as CustomerRow[]
    ).map(toCustomerDto);
  }

  insert(
    id: string,
    fields: CustomerFields,
    normalizedPhone: string,
    now: Instant,
  ): void {
    this.db
      .prepare(
        `INSERT INTO customers (${COLUMNS}, normalized_phone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.name,
        fields.phoneNumber,
        fields.email,
        fields.birthdate,
        fields.address,
        fields.rt,
        fields.rw,
        fields.kelurahan,
        fields.kecamatan,
        fields.cityOrRegency,
        fields.province,
        fields.postalCode,
        now,
        now,
        normalizedPhone,
      );
  }

  update(
    id: string,
    fields: CustomerFields,
    normalizedPhone: string,
    now: Instant,
  ): void {
    this.db
      .prepare(
        `UPDATE customers SET name = ?, phone_number = ?, normalized_phone = ?, email = ?,
           birthdate = ?, address = ?, rt = ?, rw = ?, kelurahan = ?, kecamatan = ?,
           city_or_regency = ?, province = ?, postal_code = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        fields.name,
        fields.phoneNumber,
        normalizedPhone,
        fields.email,
        fields.birthdate,
        fields.address,
        fields.rt,
        fields.rw,
        fields.kelurahan,
        fields.kecamatan,
        fields.cityOrRegency,
        fields.province,
        fields.postalCode,
        now,
        id,
      );
  }
}
