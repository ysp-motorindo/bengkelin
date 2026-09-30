import type { AppDatabase } from '@/main/database/connection';
import { bool, flag, textOrNull, toNumber } from '@/main/database/rows';
import { likePattern } from '@/main/features/customers/repository';
import type {
  BarcodeDto,
  CatalogItemDto,
  CatalogItemType,
} from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';

interface ItemRow {
  id: string;
  type: string;
  title: string;
  description: string | null;
  sku: string | null;
  unit_id: string;
  unit_code: string;
  unit_label: string;
  weight: bigint | null;
  track_inventory: bigint;
  is_active: bigint;
  created_at: string;
  updated_at: string;
}

interface BarcodeRow {
  id: string;
  catalog_item_id: string;
  barcode: string;
  is_active: bigint;
}

const ITEM_SELECT = `SELECT i.id, i.type, i.title, i.description, i.sku, i.unit_id,
    u.code AS unit_code, u.label AS unit_label, i.weight, i.track_inventory,
    i.is_active, i.created_at, i.updated_at
  FROM catalog_items i JOIN units u ON u.id = i.unit_id`;

function toBarcodeDto(row: BarcodeRow): BarcodeDto {
  return {
    id: row.id,
    barcode: row.barcode,
    isActive: bool(row.is_active),
  };
}

function toItemDto(row: ItemRow, barcodes: BarcodeDto[]): CatalogItemDto {
  return {
    id: row.id,
    type: row.type as CatalogItemType,
    title: row.title,
    description: textOrNull(row.description),
    sku: textOrNull(row.sku),
    unitId: row.unit_id,
    unitCode: row.unit_code,
    unitLabel: row.unit_label,
    weight: row.weight === null ? null : toNumber(row.weight),
    trackInventory: bool(row.track_inventory),
    isActive: bool(row.is_active),
    barcodes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Editable item fields (everything except identity and timestamps). */
export interface CatalogItemFields {
  type: CatalogItemType;
  title: string;
  description: string | null;
  sku: string | null;
  unitId: string;
  weight: number | null;
  trackInventory: boolean;
  isActive: boolean;
}

export interface BarcodeOwner {
  barcodeId: string;
  barcode: string;
  isActive: boolean;
  itemId: string;
  itemTitle: string;
  itemIsActive: boolean;
}

/** Catalog items and their barcodes. Prices live in `price-repository.ts`. */
export class CatalogRepository {
  constructor(private readonly db: AppDatabase) {}

  private barcodesOf(itemIds: string[]): Map<string, BarcodeDto[]> {
    const byItem = new Map<string, BarcodeDto[]>();
    if (itemIds.length === 0) return byItem;
    const placeholders = itemIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT id, catalog_item_id, barcode, is_active FROM catalog_item_barcodes
         WHERE catalog_item_id IN (${placeholders}) ORDER BY rowid`,
      )
      .all(...itemIds) as BarcodeRow[];
    for (const row of rows) {
      const list = byItem.get(row.catalog_item_id) ?? [];
      list.push(toBarcodeDto(row));
      byItem.set(row.catalog_item_id, list);
    }
    return byItem;
  }

  private hydrate(rows: ItemRow[]): CatalogItemDto[] {
    const barcodes = this.barcodesOf(rows.map((row) => row.id));
    return rows.map((row) => toItemDto(row, barcodes.get(row.id) ?? []));
  }

  find(id: string): CatalogItemDto | undefined {
    const row = this.db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as
      | ItemRow
      | undefined;
    return row && this.hydrate([row])[0];
  }

  /** Title, SKU or barcode substring (LIKE wildcards are literal). Capped. */
  search(
    query: string,
    includeInactive: boolean,
    limit: number,
  ): CatalogItemDto[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query !== '') {
      const pattern = likePattern(query);
      clauses.push(
        `(i.title LIKE ? ESCAPE '\\' OR i.sku LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM catalog_item_barcodes b
                     WHERE b.catalog_item_id = i.id AND b.barcode LIKE ? ESCAPE '\\'))`,
      );
      params.push(pattern, pattern, pattern);
    }
    if (!includeInactive) clauses.push('i.is_active = 1');
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `${ITEM_SELECT} ${where}
         ORDER BY i.title COLLATE NOCASE, i.created_at, i.id LIMIT ?`,
      )
      .all(...params, BigInt(limit)) as ItemRow[];
    return this.hydrate(rows);
  }

  /** Another item already using this SKU (case-insensitive). */
  skuOwner(sku: string, excludingId: string): string | undefined {
    const row = this.db
      .prepare('SELECT id FROM catalog_items WHERE sku = ? AND id <> ?')
      .get(sku, excludingId) as { id: string } | undefined;
    return row?.id;
  }

  unit(id: string): { isActive: boolean } | undefined {
    const row = this.db
      .prepare('SELECT is_active FROM units WHERE id = ?')
      .get(id) as { is_active: bigint } | undefined;
    return row && { isActive: bool(row.is_active) };
  }

  insert(id: string, fields: CatalogItemFields, now: Instant): void {
    this.db
      .prepare(
        `INSERT INTO catalog_items
           (id, type, title, description, sku, unit_id, weight, track_inventory,
            is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.type,
        fields.title,
        fields.description,
        fields.sku,
        fields.unitId,
        fields.weight === null ? null : BigInt(fields.weight),
        flag(fields.trackInventory),
        flag(fields.isActive),
        now,
        now,
      );
  }

  update(id: string, fields: CatalogItemFields, now: Instant): void {
    this.db
      .prepare(
        `UPDATE catalog_items SET type = ?, title = ?, description = ?, sku = ?,
           unit_id = ?, weight = ?, track_inventory = ?, is_active = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        fields.type,
        fields.title,
        fields.description,
        fields.sku,
        fields.unitId,
        fields.weight === null ? null : BigInt(fields.weight),
        flag(fields.trackInventory),
        flag(fields.isActive),
        now,
        id,
      );
  }

  /** The barcode row with its owning item, whatever the active flags. */
  findBarcodeOwner(barcode: string): BarcodeOwner | undefined {
    const row = this.db
      .prepare(
        `SELECT b.id AS barcode_id, b.barcode, b.is_active AS barcode_active,
                i.id AS item_id, i.title AS item_title, i.is_active AS item_active
         FROM catalog_item_barcodes b JOIN catalog_items i ON i.id = b.catalog_item_id
         WHERE b.barcode = ?`,
      )
      .get(barcode) as
      | {
          barcode_id: string;
          barcode: string;
          barcode_active: bigint;
          item_id: string;
          item_title: string;
          item_active: bigint;
        }
      | undefined;
    return (
      row && {
        barcodeId: row.barcode_id,
        barcode: row.barcode,
        isActive: bool(row.barcode_active),
        itemId: row.item_id,
        itemTitle: row.item_title,
        itemIsActive: bool(row.item_active),
      }
    );
  }

  insertBarcode(
    id: string,
    itemId: string,
    barcode: string,
    isActive: boolean,
  ): void {
    this.db
      .prepare(
        `INSERT INTO catalog_item_barcodes (id, catalog_item_id, barcode, is_active)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, itemId, barcode, flag(isActive));
  }

  setBarcodeActive(id: string, isActive: boolean): void {
    this.db
      .prepare('UPDATE catalog_item_barcodes SET is_active = ? WHERE id = ?')
      .run(flag(isActive), id);
  }

  touch(id: string, now: Instant): void {
    this.db
      .prepare('UPDATE catalog_items SET updated_at = ? WHERE id = ?')
      .run(now, id);
  }
}
