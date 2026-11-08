import type { AppDatabase } from '@/main/database/connection';
import type {
  PurchaseAllocation,
  PurchaseDraftView,
  PurchaseLineDto,
  PurchaseTotals,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import { calculateInvoice } from '@/main/features/invoices/domain';
import { SupplierService } from '@/main/features/suppliers/service';
import type { Session } from '@/main/features/auth/sessions';
import type { Clock } from '@/shared/time';
export interface PurchaseRow {
  id: string;
  status: 'DRAFT' | 'FINALIZED' | 'VOID';
  version: bigint;
  supplier_id: string | null;
  supplier_bill_reference: string | null;
  bill_date: string;
  top_days: bigint;
  due_date: string;
  note: string | null;
  vat_rate_bps: bigint;
  subtotal: bigint | null;
  discount_amount: bigint | null;
  amount: bigint | null;
  tax_subtotal: bigint | null;
  vat_amount: bigint | null;
  created_at: string;
  updated_at: string;
  discarded_at: string | null;
  document_number: string | null;
  supplier_snapshot: string | null;
  shop_snapshot: string | null;
  finalized_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  void_amount: bigint | null;
}
export interface PurchaseItemRow {
  id: string;
  purchase_id: string;
  position: bigint;
  catalog_item_id: string | null;
  type: PurchaseLineDto['type'];
  title: string;
  item_code: string | null;
  unit_label: string;
  track_inventory: bigint;
  quantity: bigint;
  unit_price: bigint | null;
  amount: bigint | null;
  tax_subtotal: bigint | null;
  vat_amount: bigint | null;
  removed_at: string | null;
}
export class PurchaseRepository {
  constructor(readonly db: AppDatabase) {}
  find(id: string): PurchaseRow {
    const r = this.db.prepare('SELECT * FROM purchases WHERE id=?').get(id) as
      | PurchaseRow
      | undefined;
    if (!r) throw new DomainError('PURCHASE_NOT_FOUND');
    return r;
  }
  open(id: string) {
    const r = this.find(id);
    if (r.discarded_at) throw new DomainError('DRAFT_DISCARDED');
    if (r.status !== 'DRAFT') throw new DomainError('PURCHASE_NOT_DRAFT');
    return r;
  }
  lines(id: string): PurchaseItemRow[] {
    return this.db
      .prepare(
        'SELECT * FROM purchase_items WHERE purchase_id=? AND removed_at IS NULL ORDER BY position,id',
      )
      .all(id) as PurchaseItemRow[];
  }
  line(purchaseId: string, id: string) {
    const r = this.lines(purchaseId).find((l) => l.id === id);
    if (!r) throw new DomainError('PURCHASE_LINE_NOT_FOUND');
    return r;
  }
  stages(purchaseId: string, lineId: string | null): number[] {
    return (
      this.db
        .prepare(
          'SELECT percentage_bps FROM purchase_discounts WHERE purchase_id=? AND purchase_item_id IS ? ORDER BY sequence',
        )
        .all(purchaseId, lineId) as { percentage_bps: bigint }[]
    ).map((r) => Number(r.percentage_bps));
  }
  allocations(id: string): PurchaseAllocation[] {
    return (
      this.db
        .prepare(
          'SELECT method,amount,reference,note FROM purchase_checkout_allocations WHERE purchase_id=? ORDER BY rowid',
        )
        .all(id) as (Omit<PurchaseAllocation, 'amount'> & { amount: bigint })[]
    ).map((r) => ({ ...r, amount: r.amount.toString() }));
  }
  recalculate(id: string) {
    const row = this.find(id);
    const lines = this.lines(id);
    if (lines.some((l) => l.unit_price === null)) {
      this.db
        .prepare(
          'UPDATE purchase_items SET amount=NULL,tax_subtotal=NULL,vat_amount=NULL WHERE purchase_id=? AND removed_at IS NULL',
        )
        .run(id);
      this.db
        .prepare(
          'UPDATE purchases SET subtotal=NULL,discount_amount=NULL,amount=NULL,tax_subtotal=NULL,vat_amount=NULL WHERE id=?',
        )
        .run(id);
      return;
    }
    const c = calculateInvoice({
      vatRateBps: Number(row.vat_rate_bps),
      lines: lines.map((l) => ({
        quantity: Number(l.quantity),
        unitPrice: l.unit_price!,
        discountStages: this.stages(id, l.id),
      })),
      discountStages: this.stages(id, null),
    });
    c.lines.forEach((v, i) =>
      this.db
        .prepare(
          'UPDATE purchase_items SET amount=?,tax_subtotal=?,vat_amount=? WHERE id=?',
        )
        .run(v.finalAmount, v.taxSubtotal, v.vatAmount, lines[i]!.id),
    );
    this.db
      .prepare(
        'UPDATE purchases SET subtotal=?,discount_amount=?,amount=?,tax_subtotal=?,vat_amount=? WHERE id=?',
      )
      .run(
        c.subtotal,
        c.discountAmount,
        c.amount,
        c.taxSubtotal,
        c.vatAmount,
        id,
      );
  }
  totals(r: PurchaseRow): PurchaseTotals | null {
    return r.amount === null
      ? null
      : {
          subtotal: r.subtotal!.toString(),
          discountAmount: r.discount_amount!.toString(),
          amount: r.amount.toString(),
          taxSubtotal: r.tax_subtotal!.toString(),
          vatAmount: r.vat_amount!.toString(),
        };
  }
  draftView(actor: Session, id: string, clock: Clock): PurchaseDraftView {
    const r = this.find(id);
    return {
      id: r.id,
      version: Number(r.version),
      status: r.status,
      supplier: r.supplier_id
        ? new SupplierService({ db: this.db, clock }).get(actor, {
            id: r.supplier_id,
          })
        : null,
      supplierBillReference: r.supplier_bill_reference,
      billDate: r.bill_date,
      topDays: Number(r.top_days),
      dueDate: r.due_date,
      note: r.note,
      vatRateBps: Number(r.vat_rate_bps),
      discountStages: this.stages(id, null),
      lines: this.lines(id).map((l) => ({
        id: l.id,
        catalogItemId: l.catalog_item_id,
        type: l.type,
        title: l.title,
        itemCode: l.item_code,
        unitLabel: l.unit_label,
        trackInventory: l.track_inventory === 1n,
        quantity: Number(l.quantity),
        unitPrice: l.unit_price?.toString() ?? null,
        discountStages: this.stages(id, l.id),
        amount: l.amount?.toString() ?? null,
        taxSubtotal: l.tax_subtotal?.toString() ?? null,
        vatAmount: l.vat_amount?.toString() ?? null,
        receivedQuantity: 0,
        creditedQuantity: 0,
        remainingQuantity: Number(l.quantity),
      })),
      payments: this.allocations(id),
      totals: this.totals(r),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      discardedAt: r.discarded_at,
    };
  }
}
