import type { AppDatabase } from '@/main/database/connection';
import { bool, textOrNull, toNumber } from '@/main/database/rows';
import { likePattern } from '@/main/features/customers/repository';
import type {
  LedgerEntryDto,
  MovementType,
  StockListItemDto,
} from '@/shared/contracts';

interface StockListRow {
  id: string;
  title: string;
  sku: string | null;
  unit_label: string;
  is_active: bigint;
  quantity: bigint;
}

interface LedgerRow {
  id: string;
  movement_type: string;
  quantity_delta: bigint;
  reference_type: string | null;
  reference_id: string | null;
  note: string | null;
  reverses_entry_id: string | null;
  created_by_cashier_id: string;
  cashier_name: string | null;
  created_at: string;
}

function toStockListItem(row: StockListRow): StockListItemDto {
  const quantity = toNumber(row.quantity);
  return {
    catalogItemId: row.id,
    title: row.title,
    sku: textOrNull(row.sku),
    unitLabel: row.unit_label,
    isActive: bool(row.is_active),
    quantity,
    isNegative: quantity < 0,
  };
}

function toLedgerEntry(row: LedgerRow): LedgerEntryDto {
  return {
    id: row.id,
    movementType: row.movement_type as MovementType,
    quantityDelta: toNumber(row.quantity_delta),
    referenceType: textOrNull(row.reference_type),
    referenceId: textOrNull(row.reference_id),
    note: textOrNull(row.note),
    reversesEntryId: textOrNull(row.reverses_entry_id),
    createdByCashierId: row.created_by_cashier_id,
    cashierName: row.cashier_name ?? '',
    createdAt: row.created_at as LedgerEntryDto['createdAt'],
  };
}

/** Read models over the ledger. Writes live in `ledger.ts`. */
export class InventoryRepository {
  constructor(private readonly db: AppDatabase) {}

  /**
   * Inventory-tracked items with their stock. Negative stock sorts first so it
   * is always seen (spec 25); `negativeOnly` shows nothing else.
   */
  listStock(
    query: string,
    negativeOnly: boolean,
    limit: number,
  ): StockListItemDto[] {
    const clauses = ['i.track_inventory = 1'];
    const params: unknown[] = [];
    if (query !== '') {
      const pattern = likePattern(query);
      clauses.push("(i.title LIKE ? ESCAPE '\\' OR i.sku LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }
    if (negativeOnly) clauses.push('COALESCE(s.quantity, 0) < 0');
    const rows = this.db
      .prepare(
        `SELECT i.id, i.title, i.sku, u.label AS unit_label, i.is_active,
                COALESCE(s.quantity, 0) AS quantity
         FROM catalog_items i
         JOIN units u ON u.id = i.unit_id
         LEFT JOIN (
           SELECT catalog_item_id, SUM(quantity_delta) AS quantity
           FROM stock_ledger_entries GROUP BY catalog_item_id
         ) s ON s.catalog_item_id = i.id
         WHERE ${clauses.join(' AND ')}
         ORDER BY (COALESCE(s.quantity, 0) < 0) DESC, i.title COLLATE NOCASE, i.id
         LIMIT ?`,
      )
      .all(...params, BigInt(limit)) as StockListRow[];
    return rows.map(toStockListItem);
  }

  /** Newest first. Ties (same millisecond) resolve by insertion order. */
  history(catalogItemId: string, limit: number): LedgerEntryDto[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.movement_type, e.quantity_delta, e.reference_type, e.reference_id,
                e.note, e.reverses_entry_id, e.created_by_cashier_id,
                c.display_name AS cashier_name, e.created_at
         FROM stock_ledger_entries e
         LEFT JOIN cashiers c ON c.id = e.created_by_cashier_id
         WHERE e.catalog_item_id = ?
         ORDER BY e.created_at DESC, e.rowid DESC
         LIMIT ?`,
      )
      .all(catalogItemId, BigInt(limit)) as LedgerRow[];
    return rows.map(toLedgerEntry);
  }

  shopTimezone(): string {
    const row = this.db
      .prepare('SELECT timezone FROM settings WHERE id = 1')
      .get() as { timezone: string | null } | undefined;
    return textOrNull(row?.timezone) ?? 'Asia/Jakarta';
  }
}
