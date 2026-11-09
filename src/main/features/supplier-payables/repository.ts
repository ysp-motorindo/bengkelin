import type { AppDatabase } from '@/main/database/connection';
import type {
  SupplierOpeningDetail,
  SupplierOpeningPage,
  SupplierOpeningRow,
  PageData,
  PaymentMethod,
} from '@/shared/contracts';
import { DomainError, formatRupiah } from '@/shared/primitives';
interface Row {
  supplier_id: string;
  external_id: string | null;
  name: string | null;
  as_of_date: string;
  amount: bigint;
  paid: bigint;
}
const SELECT = `SELECT o.*,c.external_id,c.name,COALESCE((SELECT SUM(p.amount) FROM supplier_opening_payments p WHERE p.supplier_id=o.supplier_id),0) paid FROM supplier_opening_balances o JOIN suppliers c ON c.id=o.supplier_id`;
function dto(r: Row): SupplierOpeningRow {
  return {
    supplierId: r.supplier_id,
    externalId: r.external_id,
    supplierName: r.name,
    asOfDate: r.as_of_date,
    originalAmount: formatRupiah(r.amount),
    paidAmount: formatRupiah(r.paid),
    outstandingAmount: formatRupiah(r.amount - r.paid),
    paymentStatus:
      r.amount === r.paid
        ? 'PAID'
        : r.paid === 0n
          ? 'UNPAID'
          : 'PARTIALLY_PAID',
  };
}
export class SupplierPayablesRepository {
  constructor(readonly db: AppDatabase) {}
  list(page: PageData): SupplierOpeningPage {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) n,COALESCE(SUM(amount),0) original FROM supplier_opening_balances`,
      )
      .get() as { n: bigint; original: bigint };
    const { paid } = this.db
      .prepare(
        'SELECT COALESCE(SUM(amount),0) paid FROM supplier_opening_payments',
      )
      .get() as { paid: bigint };
    const items = (
      this.db
        .prepare(
          `${SELECT} ORDER BY o.as_of_date,o.supplier_id LIMIT ? OFFSET ?`,
        )
        .all(page.size, (page.number - 1) * page.size) as Row[]
    ).map(dto);
    return {
      items,
      total: Number(totals.n),
      pageNumber: page.number,
      pageSize: page.size,
      hasMore: page.number * page.size < Number(totals.n),
      totalOriginal: formatRupiah(totals.original),
      totalPaid: formatRupiah(paid),
      totalOutstanding: formatRupiah(totals.original - paid),
    };
  }
  get(supplierId: string): SupplierOpeningDetail {
    const row = this.db
      .prepare(`${SELECT} WHERE o.supplier_id=?`)
      .get(supplierId) as Row | undefined;
    if (!row) throw new DomainError('SUPPLIER_OPENING_NOT_FOUND');
    const payments = this.db
      .prepare(
        'SELECT * FROM supplier_opening_payments WHERE supplier_id=? ORDER BY created_at,id',
      )
      .all(supplierId) as {
      id: string;
      method: PaymentMethod;
      amount: bigint;
      created_at: string;
      reference: string | null;
      note: string | null;
      created_by: string;
      cashier_name_snapshot: string;
    }[];
    return {
      ...dto(row),
      payments: payments.map((p) => ({
        id: p.id,
        method: p.method,
        amount: formatRupiah(p.amount),
        createdAt: p.created_at,
        reference: p.reference,
        note: p.note,
        cashierName: p.cashier_name_snapshot,
      })),
    };
  }
}
