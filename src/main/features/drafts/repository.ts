import { requireActiveStockLocation } from '@/main/features/references/stock-locations';
import { ReferenceRepository } from '@/main/features/references/repository';
import type { AppDatabase } from '@/main/database/connection';
import { flag } from '@/main/database/rows';
import type {
  InvoiceStatus,
  LineItemType,
  PaymentMethod,
  PriceChangeKind,
} from '@/shared/contracts';
import { assertInt64, type Instant, type LocalDate } from '@/shared/primitives';

/**
 * SQL for the draft aggregate (invoices with status DRAFT and their children).
 * Rows keep the connection's bigint integers; `view.ts` maps them to DTOs and
 * `totals.ts` does the arithmetic. Every write here runs inside the caller's
 * write transaction (DraftService).
 */

export interface InvoiceRow {
  stock_location_id: string;
  id: string;
  status: InvoiceStatus;
  reserved_invoice_number: string | null;
  tax_invoice_number: string | null;
  cash_received: bigint | null;
  sales_id: string | null;
  expedition_id: string | null;
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
  last_edited_by_cashier_id: string;
  version: bigint;
  discarded_at: Instant | null;
  created_at: Instant;
  updated_at: Instant;
}

export interface LineRow {
  price_entry_confirmed: bigint;
  id: string;
  invoice_id: string;
  position: bigint;
  catalog_item_id: string | null;
  ad_hoc_item_reference_id: string | null;
  item_type_snapshot: LineItemType;
  title_snapshot: string;
  unit_id: string | null;
  unit_snapshot: string | null;
  mechanic_id: string | null;
  mechanic_name_snapshot: string | null;
  quantity: bigint;
  listed_unit_price: bigint | null;
  unit_price: bigint;
  subtotal: bigint;
  discount_amount: bigint;
  amount: bigint;
  resolved_price_id: string | null;
  price_resolved_at: Instant | null;
  manual_price_override: bigint;
  removed_at: Instant | null;
  created_at: Instant;
  updated_at: Instant;
}

export interface StageRow {
  id: string;
  owner_id: string;
  sequence: bigint;
  percentage_bps: bigint;
  amount: bigint;
}

export interface PriceChangeRow {
  id: string;
  invoice_item_id: string;
  sequence: bigint;
  kind: PriceChangeKind;
  previous_price: bigint | null;
  new_price: bigint;
  changed_by_cashier_id: string;
  changed_by_name: string;
  changed_at: Instant;
  reason: string | null;
}

export interface AllocationRow {
  sequence: bigint;
  method: PaymentMethod;
  amount: bigint;
  reference: string | null;
  note: string | null;
}

export interface DraftSummaryRow {
  reserved_invoice_number: string | null;
  id: string;
  version: bigint;
  channel_id: string;
  channel_label: string;
  invoice_date: LocalDate;
  customer_name: string | null;
  customer_phone: string | null;
  plate_number: string | null;
  amount: bigint;
  line_count: bigint;
  created_by_cashier_id: string;
  created_by_name: string;
  last_edited_by_cashier_id: string;
  last_edited_by_name: string;
  created_at: Instant;
  updated_at: Instant;
}

export interface DraftHeader {
  stockLocationId: string;
  salesId: string | null;
  expeditionId: string | null;
  channelId: string;
  invoiceDate: LocalDate;
  pricingAt: Instant;
  customerId: string | null;
  vehicleId: string | null;
  odometerKm: number | null;
  topDays: number;
  dueDate: LocalDate;
  note: string | null;
}

export interface NewLine {
  id: string;
  invoiceId: string;
  catalogItemId: string | null;
  adHocItemReferenceId: string | null;
  itemType: LineItemType;
  title: string;
  unitId: string | null;
  unitLabel: string | null;
  quantity: number;
  listedUnitPrice: bigint | null;
  unitPrice: bigint;
  resolvedPriceId: string | null;
  priceResolvedAt: Instant | null;
  manualPriceOverride: boolean;
  now: Instant;
}

export interface LinePrice {
  unitPrice: bigint;
  listedUnitPrice: bigint | null;
  resolvedPriceId: string | null;
  priceResolvedAt: Instant | null;
  manualPriceOverride: boolean;
}

export interface Totals {
  subtotal: bigint;
  itemDiscountAmount: bigint;
  invoiceDiscountAmount: bigint;
  discountAmount: bigint;
  amount: bigint;
}

const LINE_COLUMNS = `price_entry_confirmed, id, invoice_id, position, catalog_item_id, ad_hoc_item_reference_id,
  item_type_snapshot, title_snapshot, unit_id, unit_snapshot, mechanic_id, mechanic_name_snapshot,
  quantity, listed_unit_price, unit_price, subtotal, discount_amount, amount, resolved_price_id,
  price_resolved_at, manual_price_override, removed_at, created_at, updated_at`;

const n = (value: number): bigint => BigInt(value);

export class DraftRepository {
  constructor(private readonly db: AppDatabase) {}

  reference(
    entity: 'sales' | 'expedition' | 'stockLocation',
    id: string | null,
  ) {
    return id === null
      ? undefined
      : new ReferenceRepository(this.db).find(entity, id);
  }

  requireActiveStockLocation(id: string) {
    return requireActiveStockLocation(this.db, id);
  }

  saveCashReceived(id: string, amount: bigint | null): void {
    this.db
      .prepare('UPDATE invoices SET cash_received = ? WHERE id = ?')
      .run(amount, id);
  }

  confirmPrice(lineId: string, confirmed: boolean): void {
    this.db
      .prepare(
        'UPDATE invoice_items SET price_entry_confirmed = ? WHERE id = ?',
      )
      .run(confirmed ? 1n : 0n, lineId);
  }

  saveTaxNumber(id: string, number: string | null): void {
    this.db
      .prepare('UPDATE invoices SET tax_invoice_number = ? WHERE id = ?')
      .run(number, id);
  }

  // ---- invoice header ----

  findInvoice(id: string): InvoiceRow | undefined {
    return this.db
      .prepare(
        `SELECT stock_location_id, id, status, reserved_invoice_number, tax_invoice_number, cash_received, sales_id, expedition_id, customer_id, vehicle_id, channel_id, invoice_date, pricing_at, top_days,
           due_date, odometer_km, note, subtotal, item_discount_amount, invoice_discount_amount,
           discount_amount, amount, created_by_cashier_id, last_edited_by_cashier_id, version,
           discarded_at, created_at, updated_at
         FROM invoices WHERE id = ?`,
      )
      .get(id) as InvoiceRow | undefined;
  }

  insertDraft(draft: {
    id: string;
    header: DraftHeader;
    cashierId: string;
    now: Instant;
  }): void {
    const h = draft.header;
    this.db
      .prepare(
        `INSERT INTO invoices (id, stock_location_id, status, customer_id, vehicle_id, channel_id, invoice_date, pricing_at,
           top_days, due_date, odometer_km, note, subtotal, item_discount_amount, invoice_discount_amount,
           discount_amount, amount, created_by_cashier_id, last_edited_by_cashier_id, version,
           created_at, updated_at)
         VALUES (?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, 1, ?, ?)`,
      )
      .run(
        draft.id,
        h.stockLocationId,
        h.customerId,
        h.vehicleId,
        h.channelId,
        h.invoiceDate,
        h.pricingAt,
        n(h.topDays),
        h.dueDate,
        h.odometerKm === null ? null : n(h.odometerKm),
        h.note,
        draft.cashierId,
        draft.cashierId,
        draft.now,
        draft.now,
      );
  }

  saveHeader(id: string, h: DraftHeader): void {
    this.db
      .prepare(
        `UPDATE invoices SET stock_location_id = ?, channel_id = ?, invoice_date = ?, pricing_at = ?, customer_id = ?,
           vehicle_id = ?, odometer_km = ?, top_days = ?, due_date = ?, note = ?, sales_id = ?, expedition_id = ?
         WHERE id = ?`,
      )
      .run(
        h.stockLocationId,
        h.channelId,
        h.invoiceDate,
        h.pricingAt,
        h.customerId,
        h.vehicleId,
        h.odometerKm === null ? null : n(h.odometerKm),
        n(h.topDays),
        h.dueDate,
        h.note,
        h.salesId,
        h.expeditionId,
        id,
      );
  }

  saveTotals(id: string, t: Totals): void {
    this.db
      .prepare(
        `UPDATE invoices SET subtotal = ?, item_discount_amount = ?, invoice_discount_amount = ?,
           discount_amount = ?, amount = ?
         WHERE id = ?`,
      )
      .run(
        t.subtotal,
        t.itemDiscountAmount,
        t.invoiceDiscountAmount,
        t.discountAmount,
        t.amount,
        id,
      );
  }

  /**
   * Records an accepted command: the next version, the editor and the time.
   * Guarded by the expected version so a lost race can never overwrite.
   */
  bumpVersion(
    id: string,
    expectedVersion: bigint,
    cashierId: string,
    now: Instant,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE invoices SET version = version + 1, last_edited_by_cashier_id = ?, updated_at = ?
           WHERE id = ? AND version = ? AND status = 'DRAFT' AND discarded_at IS NULL`,
        )
        .run(cashierId, now, id, expectedVersion).changes === 1
    );
  }

  /** Discards and bumps the version in ONE update (a discarded row is frozen). */
  discard(
    id: string,
    expectedVersion: bigint,
    cashierId: string,
    now: Instant,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE invoices SET discarded_at = ?, discarded_by_cashier_id = ?, version = version + 1,
             last_edited_by_cashier_id = ?, updated_at = ?
           WHERE id = ? AND version = ? AND status = 'DRAFT' AND discarded_at IS NULL`,
        )
        .run(now, cashierId, cashierId, now, id, expectedVersion).changes === 1
    );
  }

  listOpenDrafts(): DraftSummaryRow[] {
    return this.db
      .prepare(
        `SELECT i.reserved_invoice_number, i.id, i.version, i.channel_id, ch.label AS channel_label, i.invoice_date,
           c.name AS customer_name, c.phone_number AS customer_phone, v.plate_number, i.amount,
           (SELECT COUNT(*) FROM invoice_items l WHERE l.invoice_id = i.id AND l.removed_at IS NULL) AS line_count,
           i.created_by_cashier_id, cb.display_name AS created_by_name,
           i.last_edited_by_cashier_id, eb.display_name AS last_edited_by_name,
           i.created_at, i.updated_at
         FROM invoices i
         JOIN channels ch ON ch.id = i.channel_id
         JOIN cashiers cb ON cb.id = i.created_by_cashier_id
         JOIN cashiers eb ON eb.id = i.last_edited_by_cashier_id
         LEFT JOIN customers c ON c.id = i.customer_id
         LEFT JOIN vehicles v ON v.id = i.vehicle_id
         WHERE i.status = 'DRAFT' AND i.discarded_at IS NULL
         ORDER BY i.updated_at DESC, i.created_at DESC, i.id`,
      )
      .all() as DraftSummaryRow[];
  }

  // ---- lines ----

  /** Live (not removed) lines in display order. */
  liveLines(invoiceId: string): LineRow[] {
    return this.db
      .prepare(
        `SELECT ${LINE_COLUMNS} FROM invoice_items
         WHERE invoice_id = ? AND removed_at IS NULL ORDER BY position`,
      )
      .all(invoiceId) as LineRow[];
  }

  findLiveLine(invoiceId: string, lineId: string): LineRow | undefined {
    return this.db
      .prepare(
        `SELECT ${LINE_COLUMNS} FROM invoice_items
         WHERE id = ? AND invoice_id = ? AND removed_at IS NULL`,
      )
      .get(lineId, invoiceId) as LineRow | undefined;
  }

  insertLine(line: NewLine): void {
    const position = (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM invoice_items WHERE invoice_id = ?',
        )
        .get(line.invoiceId) as { next: bigint }
    ).next;
    const subtotal = assertInt64(line.unitPrice * n(line.quantity));
    this.db
      .prepare(
        `INSERT INTO invoice_items (id, invoice_id, position, catalog_item_id, ad_hoc_item_reference_id,
           item_type_snapshot, title_snapshot, unit_id, unit_snapshot, quantity, listed_unit_price,
           unit_price, subtotal, discount_amount, amount, resolved_price_id, price_resolved_at,
           manual_price_override, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        line.id,
        line.invoiceId,
        position,
        line.catalogItemId,
        line.adHocItemReferenceId,
        line.itemType,
        line.title,
        line.unitId,
        line.unitLabel,
        n(line.quantity),
        line.listedUnitPrice,
        line.unitPrice,
        subtotal,
        subtotal,
        line.resolvedPriceId,
        line.priceResolvedAt,
        flag(line.manualPriceOverride),
        line.now,
        line.now,
      );
  }

  /**
   * Quantity change. Amounts are reset to the undiscounted subtotal (checked
   * against the int64 range here) and finalised by the totals pass.
   */
  setQuantity(
    lineId: string,
    quantity: number,
    unitPrice: bigint,
    now: Instant,
  ): void {
    const subtotal = assertInt64(unitPrice * n(quantity));
    this.db
      .prepare(
        `UPDATE invoice_items SET quantity = ?, subtotal = ?, discount_amount = 0, amount = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(n(quantity), subtotal, subtotal, now, lineId);
  }

  setPrice(
    lineId: string,
    quantity: bigint,
    price: LinePrice,
    now: Instant,
  ): void {
    const subtotal = assertInt64(price.unitPrice * quantity);
    this.db
      .prepare(
        `UPDATE invoice_items SET unit_price = ?, listed_unit_price = ?, resolved_price_id = ?,
           price_resolved_at = ?, manual_price_override = ?, subtotal = ?, discount_amount = 0,
           amount = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        price.unitPrice,
        price.listedUnitPrice,
        price.resolvedPriceId,
        price.priceResolvedAt,
        flag(price.manualPriceOverride),
        subtotal,
        subtotal,
        now,
        lineId,
      );
  }

  setMechanic(
    lineId: string,
    mechanic: { id: string; name: string } | null,
    now: Instant,
  ): void {
    this.db
      .prepare(
        'UPDATE invoice_items SET mechanic_id = ?, mechanic_name_snapshot = ?, updated_at = ? WHERE id = ?',
      )
      .run(mechanic?.id ?? null, mechanic?.name ?? null, now, lineId);
  }

  setTitle(lineId: string, title: string, now: Instant): void {
    this.db
      .prepare(
        'UPDATE invoice_items SET title_snapshot = ?, updated_at = ? WHERE id = ?',
      )
      .run(title, now, lineId);
  }

  tombstone(lineId: string, cashierId: string, now: Instant): void {
    this.db
      .prepare(
        `UPDATE invoice_items SET removed_at = ?, removed_by_cashier_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, cashierId, now, lineId);
  }

  /** Authoritative amounts from the calculation; `updated_at` is not touched. */
  setLineAmounts(
    lineId: string,
    amounts: { subtotal: bigint; discountAmount: bigint; amount: bigint },
  ): void {
    this.db
      .prepare(
        'UPDATE invoice_items SET subtotal = ?, discount_amount = ?, amount = ? WHERE id = ?',
      )
      .run(amounts.subtotal, amounts.discountAmount, amounts.amount, lineId);
  }

  // ---- discounts ----

  /** Stages of the live lines of an invoice, ordered by line and sequence. */
  lineStages(invoiceId: string): StageRow[] {
    return this.db
      .prepare(
        `SELECT d.id, d.invoice_item_id AS owner_id, d.sequence, d.percentage_bps, d.amount
         FROM invoice_item_discounts d JOIN invoice_items l ON l.id = d.invoice_item_id
         WHERE l.invoice_id = ? AND l.removed_at IS NULL
         ORDER BY d.invoice_item_id, d.sequence`,
      )
      .all(invoiceId) as StageRow[];
  }

  countLineStages(lineId: string): number {
    return Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) AS n FROM invoice_item_discounts WHERE invoice_item_id = ?',
          )
          .get(lineId) as { n: bigint }
      ).n,
    );
  }

  invoiceStages(invoiceId: string): StageRow[] {
    return this.db
      .prepare(
        `SELECT id, invoice_id AS owner_id, sequence, percentage_bps, amount
         FROM invoice_discounts WHERE invoice_id = ? ORDER BY sequence`,
      )
      .all(invoiceId) as StageRow[];
  }

  /** Replaces a line's stages; amounts are filled in by the totals pass. */
  replaceLineStages(
    lineId: string,
    stages: number[],
    newId: () => string,
  ): void {
    this.db
      .prepare('DELETE FROM invoice_item_discounts WHERE invoice_item_id = ?')
      .run(lineId);
    const insert = this.db.prepare(
      `INSERT INTO invoice_item_discounts (id, invoice_item_id, sequence, percentage_bps, amount)
       VALUES (?, ?, ?, ?, 0)`,
    );
    stages.forEach((bps, index) =>
      insert.run(newId(), lineId, n(index + 1), n(bps)),
    );
  }

  replaceInvoiceStages(
    invoiceId: string,
    stages: number[],
    newId: () => string,
  ): void {
    this.db
      .prepare('DELETE FROM invoice_discounts WHERE invoice_id = ?')
      .run(invoiceId);
    const insert = this.db.prepare(
      `INSERT INTO invoice_discounts (id, invoice_id, sequence, percentage_bps, amount)
       VALUES (?, ?, ?, ?, 0)`,
    );
    stages.forEach((bps, index) =>
      insert.run(newId(), invoiceId, n(index + 1), n(bps)),
    );
  }

  setLineStageAmount(stageId: string, amount: bigint): void {
    this.db
      .prepare('UPDATE invoice_item_discounts SET amount = ? WHERE id = ?')
      .run(amount, stageId);
  }

  setInvoiceStageAmount(stageId: string, amount: bigint): void {
    this.db
      .prepare('UPDATE invoice_discounts SET amount = ? WHERE id = ?')
      .run(amount, stageId);
  }

  // ---- price history ----

  appendPriceChange(change: {
    id: string;
    lineId: string;
    kind: PriceChangeKind;
    previousPrice: bigint | null;
    newPrice: bigint;
    cashierId: string;
    at: Instant;
    reason: string | null;
  }): void {
    const sequence = (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM invoice_item_price_changes WHERE invoice_item_id = ?',
        )
        .get(change.lineId) as { next: bigint }
    ).next;
    this.db
      .prepare(
        `INSERT INTO invoice_item_price_changes (id, invoice_item_id, sequence, kind, previous_price,
           new_price, changed_by_cashier_id, changed_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        change.id,
        change.lineId,
        sequence,
        change.kind,
        change.previousPrice,
        change.newPrice,
        change.cashierId,
        change.at,
        change.reason,
      );
  }

  /** History of the live lines of an invoice, oldest first per line. */
  priceChanges(invoiceId: string): PriceChangeRow[] {
    return this.db
      .prepare(
        `SELECT p.id, p.invoice_item_id, p.sequence, p.kind, p.previous_price, p.new_price,
           p.changed_by_cashier_id, c.display_name AS changed_by_name, p.changed_at, p.reason
         FROM invoice_item_price_changes p
         JOIN invoice_items l ON l.id = p.invoice_item_id
         JOIN cashiers c ON c.id = p.changed_by_cashier_id
         WHERE l.invoice_id = ? AND l.removed_at IS NULL
         ORDER BY p.invoice_item_id, p.sequence`,
      )
      .all(invoiceId) as PriceChangeRow[];
  }

  // ---- checkout allocations ----

  allocations(invoiceId: string): AllocationRow[] {
    return this.db
      .prepare(
        `SELECT sequence, method, amount, reference, note FROM draft_checkout_allocations
         WHERE invoice_id = ? ORDER BY sequence`,
      )
      .all(invoiceId) as AllocationRow[];
  }

  replaceAllocations(
    invoiceId: string,
    allocations: {
      method: PaymentMethod;
      amount: bigint;
      reference: string | null;
      note: string | null;
    }[],
    newId: () => string,
  ): void {
    this.db
      .prepare('DELETE FROM draft_checkout_allocations WHERE invoice_id = ?')
      .run(invoiceId);
    const insert = this.db.prepare(
      `INSERT INTO draft_checkout_allocations (id, invoice_id, sequence, method, amount, reference, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    allocations.forEach((a, index) =>
      insert.run(
        newId(),
        invoiceId,
        n(index + 1),
        a.method,
        a.amount,
        a.reference,
        a.note,
      ),
    );
  }

  // ---- lookups ----

  channel(id: string): { label: string; isActive: boolean } | undefined {
    const row = this.db
      .prepare('SELECT label, is_active FROM channels WHERE id = ?')
      .get(id) as { label: string; is_active: bigint } | undefined;
    return row && { label: row.label, isActive: row.is_active === 1n };
  }

  unitLabel(id: string): { label: string; isActive: boolean } | undefined {
    const row = this.db
      .prepare('SELECT label, is_active FROM units WHERE id = ?')
      .get(id) as { label: string; is_active: bigint } | undefined;
    return row && { label: row.label, isActive: row.is_active === 1n };
  }

  mechanic(id: string): { name: string; isActive: boolean } | undefined {
    const row = this.db
      .prepare('SELECT name, is_active FROM mechanics WHERE id = ?')
      .get(id) as { name: string; is_active: bigint } | undefined;
    return row && { name: row.name, isActive: row.is_active === 1n };
  }

  cashierName(id: string): string {
    const row = this.db
      .prepare('SELECT display_name FROM cashiers WHERE id = ?')
      .get(id) as { display_name: string } | undefined;
    return row?.display_name ?? '';
  }
}
