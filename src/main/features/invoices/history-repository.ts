import type { AppDatabase } from '@/main/database/connection';
import { likePattern, likePrefix } from '@/main/features/customers/repository';
import {
  normalizePhone,
  normalizePlate,
} from '@/main/features/vehicles/normalization';
import type {
  InvoiceSearchFiltersData,
  ReceivableKind,
} from '@/shared/contracts';
import type { Instant, LocalDate } from '@/shared/primitives';

/**
 * SQL for transaction history and receivables (spec 23, 34, 35). Reads only
 * issued invoices (FINALIZED, VOID) and only their frozen snapshots. The paid
 * amount is always SUM(payments), never a stored balance.
 */

export interface InvoiceSummaryRow {
  id: string;
  invoice_number: string;
  invoice_date: LocalDate;
  due_date: LocalDate;
  finalized_at: Instant;
  voided_at: Instant | null;
  customer_name_snapshot: string | null;
  customer_phone_snapshot: string | null;
  plate_number_snapshot: string | null;
  channel_id: string;
  channel_label_snapshot: string;
  cashier_id: string;
  cashier_name_snapshot: string;
  amount: bigint;
  paid: bigint;
  status: 'FINALIZED' | 'VOID';
}

export interface PageWindow {
  limit: number;
  offset: number;
}

// The paid amount of each issued invoice, computed once per query.
const ISSUED = `
  WITH issued AS (
    SELECT i.*,
      (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.invoice_id = i.id) AS paid
    FROM invoices i
    WHERE i.status IN ('FINALIZED', 'VOID')
  )`;

const COLUMNS = `id, invoice_number, invoice_date, due_date, finalized_at, voided_at,
  customer_name_snapshot, customer_phone_snapshot, plate_number_snapshot, channel_id,
  channel_label_snapshot, cashier_id, cashier_name_snapshot, amount, paid, status`;

/** Matches derivePaymentStatus: amount == paid is PAID (incl. zero totals). */
const PAYMENT_STATUS_SQL = {
  PAID: 'paid = amount',
  PARTIALLY_PAID: 'paid > 0 AND paid < amount',
  UNPAID: 'paid = 0 AND amount > 0',
} as const;

interface Where {
  clauses: string[];
  params: unknown[];
}

function searchWhere(filters: InvoiceSearchFiltersData): Where {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const like = (column: string, pattern: string) => {
    clauses.push(`${column} LIKE ? ESCAPE '\\'`);
    params.push(pattern);
  };
  if (filters.invoiceNumber) {
    like('invoice_number', likePrefix(filters.invoiceNumber.toUpperCase()));
  }
  if (filters.dateFrom) {
    clauses.push('invoice_date >= ?');
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    clauses.push('invoice_date <= ?');
    params.push(filters.dateTo);
  }
  if (filters.customerName) {
    like('customer_name_snapshot', likePattern(filters.customerName));
  }
  // Text that normalizes to nothing (e.g. letters in a phone) matches nothing.
  if (filters.phone) {
    const key = normalizePhone(filters.phone);
    if (key === '') clauses.push('0');
    else like('customer_phone_normalized_snapshot', likePattern(key));
  }
  if (filters.plate) {
    const key = normalizePlate(filters.plate);
    if (key === '') clauses.push('0');
    else like('plate_number_normalized_snapshot', likePattern(key));
  }
  if (filters.channelId) {
    clauses.push('channel_id = ?');
    params.push(filters.channelId);
  }
  if (filters.cashierId) {
    clauses.push('cashier_id = ?');
    params.push(filters.cashierId);
  }
  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  if (filters.paymentStatus) {
    clauses.push(PAYMENT_STATUS_SQL[filters.paymentStatus]);
  }
  return { clauses, params };
}

function receivableWhere(kind: ReceivableKind, today: LocalDate): Where {
  const clauses = ["status = 'FINALIZED'", 'amount - paid > 0'];
  const params: unknown[] = [];
  if (kind === 'OVERDUE') {
    // Due today is not overdue.
    clauses.push('due_date < ?');
    params.push(today);
  }
  return { clauses, params };
}

const whereSql = (where: Where) =>
  where.clauses.length > 0 ? `WHERE ${where.clauses.join(' AND ')}` : '';

export class InvoiceHistoryRepository {
  constructor(private readonly db: AppDatabase) {}

  /** Newest finalization first; ties by id, so pages never overlap. */
  search(
    filters: InvoiceSearchFiltersData,
    page: PageWindow,
  ): { rows: InvoiceSummaryRow[]; total: bigint } {
    const where = searchWhere(filters);
    return this.page(where, 'finalized_at DESC, id DESC', page);
  }

  /** Oldest debt first: due date, then finalization, then id. */
  receivables(
    kind: ReceivableKind,
    today: LocalDate,
    page: PageWindow,
  ): { rows: InvoiceSummaryRow[]; total: bigint; totalOutstanding: bigint } {
    const where = receivableWhere(kind, today);
    const result = this.page(
      where,
      'due_date ASC, finalized_at ASC, id ASC',
      page,
    );
    const { outstanding } = this.db
      .prepare(
        `${ISSUED} SELECT COALESCE(SUM(amount - paid), 0) AS outstanding FROM issued ${whereSql(where)}`,
      )
      .get(...where.params) as { outstanding: bigint };
    return { ...result, totalOutstanding: outstanding };
  }

  private page(
    where: Where,
    orderBy: string,
    page: PageWindow,
  ): { rows: InvoiceSummaryRow[]; total: bigint } {
    const filter = whereSql(where);
    const rows = this.db
      .prepare(
        `${ISSUED} SELECT ${COLUMNS} FROM issued ${filter} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      )
      .all(...where.params, page.limit, page.offset) as InvoiceSummaryRow[];
    const { total } = this.db
      .prepare(`${ISSUED} SELECT COUNT(*) AS total FROM issued ${filter}`)
      .get(...where.params) as { total: bigint };
    return { rows, total };
  }
}
