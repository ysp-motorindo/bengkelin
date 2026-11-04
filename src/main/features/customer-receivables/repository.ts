import type { AppDatabase } from '@/main/database/connection';
import type {
  CustomerOpeningDetail,
  CustomerOpeningPage,
  CustomerOpeningRow,
  PageData,
  PaymentMethod,
} from '@/shared/contracts';
import { DomainError, formatRupiah } from '@/shared/primitives';
interface Row {
  customer_id: string;
  external_id: string | null;
  name: string | null;
  as_of_date: string;
  amount: bigint;
  paid: bigint;
}
const SELECT = `SELECT o.*,c.external_id,c.name,COALESCE((SELECT SUM(p.amount) FROM customer_opening_payments p WHERE p.customer_id=o.customer_id),0) paid FROM customer_opening_balances o JOIN customers c ON c.id=o.customer_id`;
function dto(r: Row): CustomerOpeningRow {
  return {
    customerId: r.customer_id,
    externalId: r.external_id,
    customerName: r.name,
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
export class CustomerReceivablesRepository {
  constructor(readonly db: AppDatabase) {}
  list(page: PageData): CustomerOpeningPage {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) n,COALESCE(SUM(amount),0) original FROM customer_opening_balances`,
      )
      .get() as { n: bigint; original: bigint };
    const { paid } = this.db
      .prepare(
        'SELECT COALESCE(SUM(amount),0) paid FROM customer_opening_payments',
      )
      .get() as { paid: bigint };
    const items = (
      this.db
        .prepare(
          `${SELECT} ORDER BY o.as_of_date,o.customer_id LIMIT ? OFFSET ?`,
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
  get(customerId: string): CustomerOpeningDetail {
    const row = this.db
      .prepare(`${SELECT} WHERE o.customer_id=?`)
      .get(customerId) as Row | undefined;
    if (!row) throw new DomainError('CUSTOMER_OPENING_NOT_FOUND');
    const payments = this.db
      .prepare(
        'SELECT * FROM customer_opening_payments WHERE customer_id=? ORDER BY paid_at,id',
      )
      .all(customerId) as {
      id: string;
      method: PaymentMethod;
      amount: bigint;
      paid_at: string;
      reference: string | null;
      note: string | null;
      received_by_cashier_id: string;
      received_by_name_snapshot: string;
    }[];
    return {
      ...dto(row),
      payments: payments.map((p) => ({
        id: p.id,
        method: p.method,
        amount: formatRupiah(p.amount),
        paidAt: p.paid_at,
        reference: p.reference,
        note: p.note,
        receivedBy: {
          id: p.received_by_cashier_id,
          displayName: p.received_by_name_snapshot,
        },
      })),
    };
  }
}
