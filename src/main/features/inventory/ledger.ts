import { requireActiveStockLocation } from '@/main/features/references/stock-locations';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/main/database/connection';
import { DatabaseError } from '@/main/database/errors';
import { toNumber } from '@/main/database/rows';
import type { MovementType } from '@/shared/contracts';
import { DomainError, type Instant } from '@/shared/primitives';

/**
 * Low-level ledger access. Everything here that WRITES must run inside a
 * write transaction owned by the caller (`withWriteTransaction`): finalization
 * (T10) calls `recordSale` and void (T11) calls `recordVoidReversal` inside
 * their own transactions so stock, invoice and receipt commit together.
 * The schema (migration 005) enforces the invariants; the checks here only
 * turn the common violations into typed errors.
 */

/** Anything with the acting cashier's id (a Session qualifies). */
export interface LedgerActor {
  cashierId: string;
}

/** Reference type used for movements caused by an invoice. */
export const INVOICE_REFERENCE = 'INVOICE';

function assertInTransaction(db: AppDatabase): void {
  if (!db.inTransaction) {
    throw new DatabaseError(
      'NOT_IN_TRANSACTION',
      'Ledger writes must run inside withWriteTransaction',
    );
  }
}

function isConstraint(error: unknown, kind: string): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === `SQLITE_CONSTRAINT_${kind}`
  );
}

/** SUM(quantity_delta) for an item (0 when there are no entries). */
export function stockOf(
  db: AppDatabase,
  catalogItemId: string,
  stockLocationId: string,
): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(quantity_delta), 0) AS quantity FROM stock_ledger_entries WHERE catalog_item_id = ? AND stock_location_id = ?',
    )
    .get(catalogItemId, stockLocationId) as { quantity: bigint };
  return toNumber(row.quantity);
}

export function hasLedgerEntries(
  db: AppDatabase,
  catalogItemId: string,
): boolean {
  return (
    db
      .prepare(
        'SELECT 1 AS found FROM stock_ledger_entries WHERE catalog_item_id = ? LIMIT 1',
      )
      .get(catalogItemId) !== undefined
  );
}

/** Throws CATALOG_ITEM_NOT_FOUND / ITEM_NOT_INVENTORY_TRACKED. */
export function requireTrackedItem(
  db: AppDatabase,
  catalogItemId: string,
): void {
  const item = db
    .prepare('SELECT type, track_inventory FROM catalog_items WHERE id = ?')
    .get(catalogItemId) as
    | { type: string; track_inventory: bigint }
    | undefined;
  if (!item) {
    throw new DomainError('CATALOG_ITEM_NOT_FOUND', 'Item not found');
  }
  if (item.type === 'SERVICE' || item.track_inventory !== 1n) {
    throw new DomainError(
      'ITEM_NOT_INVENTORY_TRACKED',
      'Item does not track inventory',
    );
  }
}

export interface NewEntry {
  id?: string;
  catalogItemId: string;
  stockLocationId: string;
  movementType: MovementType;
  /** Signed; the schema checks the sign against the movement type. */
  quantityDelta: number;
  referenceType?: string | null;
  referenceId?: string | null;
  note?: string | null;
  reversesEntryId?: string | null;
  createdByCashierId: string;
  createdAt: Instant;
}

/** Appends one entry and returns its id. Caller has validated the business rules. */
export function insertEntry(db: AppDatabase, entry: NewEntry): string {
  assertInTransaction(db);
  if (!Number.isSafeInteger(entry.quantityDelta)) {
    throw new DomainError('INVALID_QUANTITY', 'Quantity must be an integer');
  }
  const id = entry.id ?? randomUUID();
  if (entry.movementType !== 'VOID_REVERSAL')
    requireActiveStockLocation(db, entry.stockLocationId);
  db.prepare(
    `INSERT INTO stock_ledger_entries
       (id, catalog_item_id, stock_location_id, movement_type, quantity_delta, reference_type, reference_id,
        note, reverses_entry_id, created_by_cashier_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    entry.catalogItemId,
    entry.stockLocationId,
    entry.movementType,
    BigInt(entry.quantityDelta),
    entry.referenceType ?? null,
    entry.referenceId ?? null,
    entry.note ?? null,
    entry.reversesEntryId ?? null,
    entry.createdByCashierId,
    entry.createdAt,
  );
  return id;
}

function assertSaleQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new DomainError('INVALID_QUANTITY', 'Quantity must be at least 1');
  }
}

/**
 * Records the stock-out for ONE item of a finalized invoice. `quantity` is the
 * POSITIVE total sold of that item (finalization aggregates lines per item);
 * the ledger stores `-quantity`. Returns the SALE entry id.
 *
 * Errors: INVALID_QUANTITY, CATALOG_ITEM_NOT_FOUND,
 * ITEM_NOT_INVENTORY_TRACKED (callers should skip untracked items), and
 * SALE_ALREADY_RECORDED for a second SALE for the same invoice + item.
 * Stock may go negative (spec 25); this never blocks a sale.
 */
export function recordSale(
  db: AppDatabase,
  input: {
    invoiceId: string;
    stockLocationId: string;
    catalogItemId: string;
    quantity: number;
    actor: LedgerActor;
    at: Instant;
  },
): string {
  assertInTransaction(db);
  assertSaleQuantity(input.quantity);
  requireTrackedItem(db, input.catalogItemId);
  try {
    return insertEntry(db, {
      catalogItemId: input.catalogItemId,
      stockLocationId: input.stockLocationId,
      movementType: 'SALE',
      quantityDelta: -input.quantity,
      referenceType: INVOICE_REFERENCE,
      referenceId: input.invoiceId,
      createdByCashierId: input.actor.cashierId,
      createdAt: input.at,
    });
  } catch (error) {
    if (isConstraint(error, 'UNIQUE')) {
      throw new DomainError(
        'SALE_ALREADY_RECORDED',
        'Stock for this invoice and item was already recorded',
      );
    }
    throw error;
  }
}

interface SaleRow {
  id: string;
  catalog_item_id: string;
  stock_location_id: string;
  quantity_delta: bigint;
  reference_type: string | null;
  reference_id: string | null;
  reversed_by: string | null;
}

/**
 * Reverses one SALE exactly (+quantity, same item and invoice), at most once.
 * Returns the VOID_REVERSAL entry id. Errors: SALE_ENTRY_NOT_FOUND (unknown id
 * or not a SALE) and SALE_ALREADY_REVERSED.
 */
export function recordVoidReversal(
  db: AppDatabase,
  input: { saleEntryId: string; actor: LedgerActor; at: Instant },
): string {
  assertInTransaction(db);
  const sale = db
    .prepare(
      `SELECT s.id, s.catalog_item_id, s.stock_location_id, s.quantity_delta, s.reference_type, s.reference_id,
              (SELECT r.id FROM stock_ledger_entries r WHERE r.reverses_entry_id = s.id) AS reversed_by
       FROM stock_ledger_entries s
       WHERE s.id = ? AND s.movement_type = 'SALE'`,
    )
    .get(input.saleEntryId) as SaleRow | undefined;
  if (!sale) {
    throw new DomainError('SALE_ENTRY_NOT_FOUND', 'Sale entry not found');
  }
  if (sale.reversed_by !== null) {
    throw new DomainError(
      'SALE_ALREADY_REVERSED',
      'This sale was already reversed',
    );
  }
  try {
    return insertEntry(db, {
      catalogItemId: sale.catalog_item_id,
      stockLocationId: sale.stock_location_id,
      movementType: 'VOID_REVERSAL',
      quantityDelta: -toNumber(sale.quantity_delta),
      referenceType: sale.reference_type,
      referenceId: sale.reference_id,
      reversesEntryId: sale.id,
      createdByCashierId: input.actor.cashierId,
      createdAt: input.at,
    });
  } catch (error) {
    if (isConstraint(error, 'UNIQUE')) {
      throw new DomainError(
        'SALE_ALREADY_REVERSED',
        'This sale was already reversed',
      );
    }
    throw error;
  }
}

export interface SaleEntry {
  id: string;
  catalogItemId: string;
  /** Positive quantity that was sold. */
  quantity: number;
  /** The VOID_REVERSAL entry that undid it, or null. */
  reversedByEntryId: string | null;
}

/** The SALE entries recorded for an invoice, with their reversal state. */
export function readSaleEntriesForInvoice(
  db: AppDatabase,
  invoiceId: string,
): SaleEntry[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.catalog_item_id, s.stock_location_id, s.quantity_delta,
              (SELECT r.id FROM stock_ledger_entries r WHERE r.reverses_entry_id = s.id) AS reversed_by
       FROM stock_ledger_entries s
       WHERE s.movement_type = 'SALE' AND s.reference_type = ? AND s.reference_id = ?
       ORDER BY s.rowid`,
    )
    .all(INVOICE_REFERENCE, invoiceId) as SaleRow[];
  return rows.map((row) => ({
    id: row.id,
    catalogItemId: row.catalog_item_id,
    quantity: -toNumber(row.quantity_delta),
    reversedByEntryId: row.reversed_by,
  }));
}
