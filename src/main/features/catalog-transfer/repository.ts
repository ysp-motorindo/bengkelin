import { createHash, type Hash } from 'node:crypto';
import type { AppDatabase } from '@/main/database/connection';
import { bool, textOrNull, toNumber } from '@/main/database/rows';
import type { CatalogItemType } from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';
import type { RefChannel, RefUnit } from './columns';
import type { BarcodeOwnerRef, ExistingItem, PlannerSource } from './planner';

interface ItemRow {
  id: string;
  sku: string | null;
  type: string;
  title: string;
  description: string | null;
  unit_id: string;
  unit_code: string;
  weight: bigint | null;
  track_inventory: bigint;
  is_active: bigint;
}

const ITEM_SELECT = `SELECT i.id, i.sku, i.type, i.title, i.description, i.unit_id,
    u.code AS unit_code, i.weight, i.track_inventory, i.is_active
  FROM catalog_items i JOIN units u ON u.id = i.unit_id`;

function toExisting(row: ItemRow): ExistingItem {
  return {
    id: row.id,
    sku: row.sku ?? '',
    type: row.type as CatalogItemType,
    title: row.title,
    description: textOrNull(row.description),
    unitId: row.unit_id,
    unitCode: row.unit_code,
    weight: row.weight === null ? null : toNumber(row.weight),
    trackInventory: bool(row.track_inventory),
    isActive: bool(row.is_active),
  };
}

/** One catalog item as the export writes it. */
export interface ExportItem {
  id: string;
  sku: string | null;
  title: string;
  type: CatalogItemType;
  unitCode: string;
  description: string | null;
  trackInventory: boolean;
  isActive: boolean;
}

/**
 * Catalog reads for the import planner, the preview fingerprint and the
 * export. Writes go through the catalog, pricing and ledger modules.
 */
export class CatalogTransferRepository implements PlannerSource {
  constructor(private readonly db: AppDatabase) {}

  units(): RefUnit[] {
    const rows = this.db
      .prepare('SELECT id, code, is_active FROM units ORDER BY rowid')
      .all() as { id: string; code: string; is_active: bigint }[];
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      isActive: bool(r.is_active),
    }));
  }

  /** Every channel, in configuration (creation) order. */
  channels(): RefChannel[] {
    const rows = this.db
      .prepare('SELECT id, code, is_active FROM channels ORDER BY rowid')
      .all() as { id: string; code: string; is_active: bigint }[];
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      isActive: bool(r.is_active),
    }));
  }

  /** SKU lookup with the column's NOCASE collation. */
  itemBySku(sku: string): ExistingItem | undefined {
    const row = this.db.prepare(`${ITEM_SELECT} WHERE i.sku = ?`).get(sku) as
      | ItemRow
      | undefined;
    return row && toExisting(row);
  }

  skuWithLeadingZeros(digits: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT sku FROM catalog_items
          WHERE sku GLOB '0*' AND ltrim(sku, '0') = ?
          ORDER BY sku LIMIT 1`,
      )
      .get(digits) as { sku: string } | undefined;
    return row?.sku;
  }

  itemById(id: string): ExistingItem | undefined {
    const row = this.db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as
      | ItemRow
      | undefined;
    return row && toExisting(row);
  }

  barcodeOwner(barcode: string): BarcodeOwnerRef | undefined {
    const row = this.db
      .prepare(
        `SELECT b.id, b.is_active, i.id AS item_id, i.sku, i.title
         FROM catalog_item_barcodes b JOIN catalog_items i ON i.id = b.catalog_item_id
         WHERE b.barcode = ?`,
      )
      .get(barcode) as
      | {
          id: string;
          is_active: bigint;
          item_id: string;
          sku: string | null;
          title: string;
        }
      | undefined;
    return (
      row && {
        barcodeId: row.id,
        itemId: row.item_id,
        itemSku: row.sku,
        itemTitle: row.title,
        isActive: bool(row.is_active),
      }
    );
  }

  /** The start-only resolution query (Part A), as a bigint. */
  priceAt(itemId: string, channelId: string, at: Instant): bigint | null {
    const row = this.db
      .prepare(
        `SELECT price FROM catalog_item_prices
         WHERE catalog_item_id = ?
           AND channel_id = ?
           AND effective_start_at <= ?
           AND superseded_at IS NULL
         ORDER BY effective_start_at DESC
         LIMIT 1`,
      )
      .get(itemId, channelId, at) as { price: bigint } | undefined;
    return row ? row.price : null;
  }

  /**
   * SHA-256 over the catalog state a preview depends on: every catalog item,
   * barcode and price point, the units and channels, and whether each
   * affected item has stock movements (T7's tracking rule). Ordinary sales
   * of an item that already has movements do not change it.
   */
  fingerprint(affectedItemIds: readonly string[]): string {
    const hash = createHash('sha256');
    const tables: [string, string][] = [
      ['items', 'SELECT * FROM catalog_items ORDER BY id'],
      ['barcodes', 'SELECT * FROM catalog_item_barcodes ORDER BY id'],
      ['prices', 'SELECT * FROM catalog_item_prices ORDER BY id'],
      ['units', 'SELECT * FROM units ORDER BY id'],
      ['channels', 'SELECT * FROM channels ORDER BY id'],
    ];
    for (const [name, sql] of tables) {
      hash.update(`#${name}\n`);
      for (const row of this.db.prepare(sql).iterate()) {
        hashRow(hash, row as Record<string, unknown>);
      }
    }
    hash.update('#ledger\n');
    const hasEntries = this.db.prepare(
      'SELECT 1 AS found FROM stock_ledger_entries WHERE catalog_item_id = ? LIMIT 1',
    );
    for (const id of [...new Set(affectedItemIds)].sort()) {
      hash.update(`${id}|${hasEntries.get(id) ? 1 : 0}\n`);
    }
    return hash.digest('hex');
  }

  /** Every catalog item: SKU order (case-insensitive), SKU-less last. */
  exportItems(): ExportItem[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.sku, i.title, i.type, u.code AS unit_code, i.description,
                i.track_inventory, i.is_active
         FROM catalog_items i JOIN units u ON u.id = i.unit_id
         ORDER BY i.sku IS NULL, i.sku COLLATE NOCASE, i.title COLLATE NOCASE, i.id`,
      )
      .all() as {
      id: string;
      sku: string | null;
      title: string;
      type: string;
      unit_code: string;
      description: string | null;
      track_inventory: bigint;
      is_active: bigint;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sku: textOrNull(r.sku),
      title: r.title,
      type: r.type as CatalogItemType,
      unitCode: r.unit_code,
      description: textOrNull(r.description),
      trackInventory: bool(r.track_inventory),
      isActive: bool(r.is_active),
    }));
  }

  /** Active barcodes per item, in the order they were added. */
  activeBarcodes(): Map<string, string[]> {
    const rows = this.db
      .prepare(
        `SELECT catalog_item_id, barcode FROM catalog_item_barcodes
         WHERE is_active = 1 ORDER BY rowid`,
      )
      .all() as { catalog_item_id: string; barcode: string }[];
    const byItem = new Map<string, string[]>();
    for (const row of rows) {
      const list = byItem.get(row.catalog_item_id) ?? [];
      list.push(row.barcode);
      byItem.set(row.catalog_item_id, list);
    }
    return byItem;
  }

  /** SUM(quantity_delta) per item that has ledger entries. */
  stockLevels(): Map<string, bigint> {
    const rows = this.db
      .prepare(
        `SELECT catalog_item_id, SUM(quantity_delta) AS quantity
         FROM stock_ledger_entries GROUP BY catalog_item_id`,
      )
      .all() as { catalog_item_id: string; quantity: bigint }[];
    return new Map(rows.map((r) => [r.catalog_item_id, r.quantity]));
  }

  shopTimezone(): string {
    const row = this.db
      .prepare('SELECT timezone FROM settings WHERE id = 1')
      .get() as { timezone: string | null } | undefined;
    return textOrNull(row?.timezone) ?? 'Asia/Jakarta';
  }
}

function hashRow(hash: Hash, row: Record<string, unknown>): void {
  const parts = Object.values(row).map((value) =>
    value === null || value === undefined ? '\u0000' : String(value),
  );
  hash.update(parts.join('\u001f'));
  hash.update('\u001e');
}
