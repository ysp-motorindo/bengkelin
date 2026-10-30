import type { AppDatabase } from '@/main/database/connection';
import type { InvoiceStatus } from '@/shared/contracts';
import type { Instant, LocalDate } from '@/shared/primitives';

/**
 * SQL for issued invoices and for the finalization-specific writes on the
 * invoice header. Draft lines, stages and allocations are read through
 * `DraftRepository`. Every write runs inside the caller's write transaction.
 */

/** The full invoices row, including finalization, snapshot and void columns. */
export interface FullInvoiceRow {
  id: string;
  status: InvoiceStatus;
  sales_id: string | null;
  expedition_id: string | null;
  sales_name_snapshot: string | null;
  expedition_name_snapshot: string | null;
  customer_id: string | null;
  vehicle_id: string | null;
  channel_id: string;
  invoice_date: LocalDate;
  pricing_at: Instant;
  top_days: bigint;
  due_date: LocalDate;
  odometer_km: bigint | null;
  note: string | null;
  subtotal: bigint;
  item_discount_amount: bigint;
  invoice_discount_amount: bigint;
  discount_amount: bigint;
  amount: bigint;
  created_by_cashier_id: string;
  created_by_name: string;
  version: bigint;
  invoice_number: string | null;
  tax_invoice_number: string | null;
  cashier_id: string | null;
  finalized_at: Instant | null;
  customer_name_snapshot: string | null;
  customer_phone_snapshot: string | null;
  plate_number_snapshot: string | null;
  vehicle_description_snapshot: string | null;
  channel_label_snapshot: string | null;
  cashier_name_snapshot: string | null;
  shop_identity_snapshot: string | null;
  voided_at: Instant | null;
  voided_by_cashier_id: string | null;
  voided_by_name_snapshot: string | null;
  void_reason: string | null;
}

export interface HeaderSnapshots {
  salesName: string | null;
  expeditionName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  /** normalizePhone(customerPhone): the history search key (008). */
  customerPhoneNormalized: string | null;
  plateNumber: string | null;
  /** normalizePlate(plateNumber): the history search key (008). */
  plateNumberNormalized: string | null;
  vehicleDescription: string | null;
  channelLabel: string;
  cashierName: string;
  /** JSON text of the printable shop identity. */
  shopIdentity: string;
}

/** Tracked demand of one catalog item over the draft's live lines. */
export interface TrackedDemandRow {
  catalog_item_id: string;
  title: string;
  demand: bigint;
}

export class InvoiceRepository {
  constructor(private readonly db: AppDatabase) {}

  findFull(id: string): FullInvoiceRow | undefined {
    return this.db
      .prepare(
        `SELECT i.tax_invoice_number, i.sales_id, i.expedition_id, i.sales_name_snapshot, i.expedition_name_snapshot, i.id, i.status, i.customer_id, i.vehicle_id, i.channel_id, i.invoice_date,
           i.pricing_at, i.top_days, i.due_date, i.odometer_km, i.note, i.subtotal,
           i.item_discount_amount, i.invoice_discount_amount, i.discount_amount, i.amount,
           i.created_by_cashier_id, cb.display_name AS created_by_name, i.version,
           i.invoice_number, i.cashier_id, i.finalized_at, i.customer_name_snapshot,
           i.customer_phone_snapshot, i.plate_number_snapshot, i.vehicle_description_snapshot,
           i.channel_label_snapshot, i.cashier_name_snapshot, i.shop_identity_snapshot,
           i.voided_at, i.voided_by_cashier_id, i.voided_by_name_snapshot, i.void_reason
         FROM invoices i
         JOIN cashiers cb ON cb.id = i.created_by_cashier_id
         WHERE i.id = ?`,
      )
      .get(id) as FullInvoiceRow | undefined;
  }

  /**
   * Quantity per inventory-tracked catalog item (STOCK_ITEM with
   * track_inventory) over the live lines, in first-line order. SERVICE items,
   * custom lines and untracked items never appear.
   */
  trackedDemand(invoiceId: string): TrackedDemandRow[] {
    return this.db
      .prepare(
        `SELECT l.catalog_item_id,
           (SELECT f.title_snapshot FROM invoice_items f
             WHERE f.invoice_id = l.invoice_id AND f.catalog_item_id = l.catalog_item_id
               AND f.removed_at IS NULL
             ORDER BY f.position LIMIT 1) AS title,
           SUM(l.quantity) AS demand
         FROM invoice_items l
         JOIN catalog_items c ON c.id = l.catalog_item_id
         WHERE l.invoice_id = ? AND l.removed_at IS NULL
           AND c.type = 'STOCK_ITEM' AND c.track_inventory = 1
         GROUP BY l.catalog_item_id
         ORDER BY MIN(l.position)`,
      )
      .all(invoiceId) as TrackedDemandRow[];
  }

  /** Inactive catalog items on live lines (any type), in first-line order. */
  inactiveCatalogItems(
    invoiceId: string,
  ): { catalog_item_id: string; title: string }[] {
    return this.db
      .prepare(
        `SELECT l.catalog_item_id, MIN(l.position) AS first_position,
           (SELECT f.title_snapshot FROM invoice_items f
             WHERE f.invoice_id = l.invoice_id AND f.catalog_item_id = l.catalog_item_id
               AND f.removed_at IS NULL
             ORDER BY f.position LIMIT 1) AS title
         FROM invoice_items l
         JOIN catalog_items c ON c.id = l.catalog_item_id
         WHERE l.invoice_id = ? AND l.removed_at IS NULL AND c.is_active = 0
         GROUP BY l.catalog_item_id
         ORDER BY first_position`,
      )
      .all(invoiceId) as { catalog_item_id: string; title: string }[];
  }

  /** Highest odometer on this vehicle's issued (FINALIZED or VOID) invoices. */
  previousOdometer(vehicleId: string, excludeInvoiceId: string): bigint | null {
    const row = this.db
      .prepare(
        `SELECT MAX(odometer_km) AS previous FROM invoices
         WHERE vehicle_id = ? AND id <> ? AND status IN ('FINALIZED', 'VOID')
           AND odometer_km IS NOT NULL`,
      )
      .get(vehicleId, excludeInvoiceId) as { previous: bigint | null };
    return row.previous;
  }

  /** Header snapshots, written while the invoice is still a DRAFT. */
  writeHeaderSnapshots(invoiceId: string, s: HeaderSnapshots): void {
    const changes = this.db
      .prepare(
        `UPDATE invoices SET customer_name_snapshot = ?, customer_phone_snapshot = ?,
           customer_phone_normalized_snapshot = ?, plate_number_snapshot = ?,
           plate_number_normalized_snapshot = ?, vehicle_description_snapshot = ?,
           channel_label_snapshot = ?, cashier_name_snapshot = ?, shop_identity_snapshot = ?, sales_name_snapshot = ?, expedition_name_snapshot = ?
         WHERE id = ? AND status = 'DRAFT' AND discarded_at IS NULL`,
      )
      .run(
        s.customerName,
        s.customerPhone,
        s.customerPhoneNormalized,
        s.plateNumber,
        s.plateNumberNormalized,
        s.vehicleDescription,
        s.channelLabel,
        s.cashierName,
        s.shopIdentity,
        s.salesName,
        s.expeditionName,
        invoiceId,
      ).changes;
    if (changes !== 1) throw new Error('snapshot write matched no open draft');
  }

  /**
   * Line snapshots that may still be missing (a unit label). Titles, types
   * and mechanic names are captured when the line is written.
   */
  fillLineSnapshots(invoiceId: string): void {
    this.db
      .prepare(
        `UPDATE invoice_items
         SET unit_snapshot = (SELECT u.label FROM units u WHERE u.id = invoice_items.unit_id)
         WHERE invoice_id = ? AND removed_at IS NULL
           AND unit_id IS NOT NULL AND unit_snapshot IS NULL`,
      )
      .run(invoiceId);
  }

  /** Allocations are draft-only; finalization consumes them. */
  clearAllocations(invoiceId: string): void {
    this.db
      .prepare('DELETE FROM draft_checkout_allocations WHERE invoice_id = ?')
      .run(invoiceId);
  }

  /**
   * DRAFT -> FINALIZED in one guarded update. Returns false when the row was
   * not the expected open draft version.
   */
  markFinalized(input: {
    invoiceId: string;
    expectedVersion: bigint;
    invoiceNumber: string;
    cashierId: string;
    now: Instant;
  }): boolean {
    return (
      this.db
        .prepare(
          `UPDATE invoices SET status = 'FINALIZED', invoice_number = ?, cashier_id = ?,
             finalized_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND status = 'DRAFT' AND discarded_at IS NULL AND version = ?`,
        )
        .run(
          input.invoiceNumber,
          input.cashierId,
          input.now,
          input.now,
          input.invoiceId,
          input.expectedVersion,
        ).changes === 1
    );
  }

  /**
   * FINALIZED -> VOID in one guarded update (the 006 transition and 008
   * void-name triggers allow exactly these columns). Returns false when the
   * row was not FINALIZED.
   */
  markVoided(input: {
    invoiceId: string;
    cashierId: string;
    cashierName: string;
    reason: string;
    now: Instant;
  }): boolean {
    return (
      this.db
        .prepare(
          `UPDATE invoices SET status = 'VOID', voided_at = ?, voided_by_cashier_id = ?,
             voided_by_name_snapshot = ?, void_reason = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND status = 'FINALIZED'`,
        )
        .run(
          input.now,
          input.cashierId,
          input.cashierName,
          input.reason,
          input.now,
          input.invoiceId,
        ).changes === 1
    );
  }
}
