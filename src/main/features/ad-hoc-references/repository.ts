import type { AppDatabase } from '@/main/database/connection';
import { bool, flag, textOrNull } from '@/main/database/rows';
import { likePattern } from '@/main/features/customers/repository';
import type { AdHocItemType, AdHocReferenceDto } from '@/shared/contracts';
import { formatRupiah, type Instant } from '@/shared/primitives';

interface AdHocReferenceRow {
  id: string;
  type: AdHocItemType;
  title: string;
  description: string | null;
  unit_id: string | null;
  default_price: bigint | null;
  is_active: bigint;
  created_at: string;
  updated_at: string;
}

export function toAdHocReferenceDto(row: AdHocReferenceRow): AdHocReferenceDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: textOrNull(row.description),
    unitId: textOrNull(row.unit_id),
    defaultPrice:
      row.default_price === null ? null : formatRupiah(row.default_price),
    isActive: bool(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `SELECT id, type, title, description, unit_id, default_price, is_active, created_at, updated_at
  FROM ad_hoc_item_references`;

/** AdHocItemReference rows (spec 12). Never deleted; `is_active` hides them. */
export class AdHocReferenceRepository {
  constructor(private readonly db: AppDatabase) {}

  find(id: string): AdHocReferenceDto | undefined {
    const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as
      | AdHocReferenceRow
      | undefined;
    return row && toAdHocReferenceDto(row);
  }

  /** Case-insensitive (the title column is NOCASE). */
  findByTitle(
    type: AdHocItemType,
    title: string,
  ): AdHocReferenceDto | undefined {
    const row = this.db
      .prepare(`${SELECT} WHERE type = ? AND title = ?`)
      .get(type, title) as AdHocReferenceRow | undefined;
    return row && toAdHocReferenceDto(row);
  }

  insert(reference: {
    id: string;
    type: AdHocItemType;
    title: string;
    unitId: string | null;
    defaultPrice: bigint;
    now: Instant;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ad_hoc_item_references
           (id, type, title, description, unit_id, default_price, is_active, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        reference.id,
        reference.type,
        reference.title,
        reference.unitId,
        reference.defaultPrice,
        flag(true),
        reference.now,
        reference.now,
      );
  }

  /** Remembers the latest price (and unit, when given) as the next suggestion. */
  rememberUse(
    id: string,
    use: { defaultPrice: bigint; unitId: string | null; now: Instant },
  ): void {
    this.db
      .prepare(
        `UPDATE ad_hoc_item_references
         SET default_price = ?, unit_id = COALESCE(?, unit_id), updated_at = ?
         WHERE id = ?`,
      )
      .run(use.defaultPrice, use.unitId, use.now, id);
  }

  /** ADMIN listing: active and inactive, optionally filtered by title. */
  list(query: string): AdHocReferenceDto[] {
    const where = query === '' ? '' : "WHERE title LIKE ? ESCAPE '\\'";
    const params = query === '' ? [] : [likePattern(query)];
    const rows = this.db
      .prepare(`${SELECT} ${where} ORDER BY title COLLATE NOCASE, type`)
      .all(...params) as AdHocReferenceRow[];
    return rows.map(toAdHocReferenceDto);
  }

  setActive(id: string, active: boolean, now: Instant): void {
    this.db
      .prepare(
        'UPDATE ad_hoc_item_references SET is_active = ?, updated_at = ? WHERE id = ?',
      )
      .run(flag(active), now, id);
  }

  setDescription(id: string, description: string | null, now: Instant): void {
    this.db
      .prepare(
        'UPDATE ad_hoc_item_references SET description = ?, updated_at = ? WHERE id = ?',
      )
      .run(description, now, id);
  }

  /** Active references whose title contains `query` (LIKE wildcards literal). */
  search(
    query: string,
    type: AdHocItemType | undefined,
    limit: number,
  ): AdHocReferenceDto[] {
    const clauses = ['is_active = 1'];
    const params: unknown[] = [];
    if (query !== '') {
      clauses.push("title LIKE ? ESCAPE '\\'");
      params.push(likePattern(query));
    }
    if (type) {
      clauses.push('type = ?');
      params.push(type);
    }
    params.push(BigInt(limit));
    const rows = this.db
      .prepare(
        `${SELECT} WHERE ${clauses.join(' AND ')}
         ORDER BY title COLLATE NOCASE, type LIMIT ?`,
      )
      .all(...params) as AdHocReferenceRow[];
    return rows.map(toAdHocReferenceDto);
  }
}
