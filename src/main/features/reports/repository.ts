import type { AppDatabase } from '@/main/database/connection';
import type { InstantRange } from '@/shared/time';

/**
 * SQL for the daily report (spec 33). Each section is ONE range scan on its
 * own instant column, compared as canonical instant text (which sorts like
 * time; never SQLite date functions on local time):
 *
 *  - sales:    invoices.finalized_at   (index invoices_finalized_order)
 *  - voids:    invoices.voided_at      (index invoices_voided_at, migration 010)
 *  - payments: payments.paid_at        (index payments_paid_at)
 *
 * No status predicate is needed: the invoices CHECKs guarantee drafts have
 * no finalized_at and only VOID invoices have a voided_at. Money columns are
 * INTEGER, summed by SQLite and read as bigint (safe integers); nothing here
 * goes through floating point. Unlike history (T11), nothing sums payments
 * over all invoices: payments are joined to their invoice by primary key.
 */

export interface ReportFilters {
  cashierId?: string | undefined;
  channelId?: string | undefined;
}

export interface Query {
  sql: string;
  params: unknown[];
}

/** One (channel, finalizing cashier) group of the day's sales. */
export interface SalesGroupRow {
  channel_id: string;
  channel_label: string;
  cashier_id: string;
  cashier_name: string;
  invoice_count: bigint;
  gross: bigint;
  item_discounts: bigint;
  invoice_discounts: bigint;
  net: bigint;
}

export interface VoidRow {
  id: string;
  invoice_number: string;
  finalized_at: string;
  voided_at: string;
  amount: bigint;
  void_reason: string;
  voided_by_cashier_id: string;
  voided_by_name: string;
  channel_id: string;
  channel_label: string;
}

export interface PaymentMethodRow {
  method: string;
  payment_count: bigint;
  amount: bigint;
  same_day: bigint;
  older: bigint;
  opening: bigint;
}

function filterSql(
  filters: ReportFilters,
  cashierColumn: string,
): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.cashierId) {
    clauses.push(`AND ${cashierColumn} = ?`);
    params.push(filters.cashierId);
  }
  if (filters.channelId) {
    clauses.push('AND i.channel_id = ?');
    params.push(filters.channelId);
  }
  return { sql: clauses.join(' '), params };
}

/** The statements, exposed so tests can check their query plans. */
export const REPORT_QUERIES = {
  /** Sales by finalization time; cashier = the finalizer. */
  sales(range: InstantRange, filters: ReportFilters): Query {
    const f = filterSql(filters, 'i.cashier_id');
    return {
      sql: `SELECT i.channel_id, ch.label AS channel_label,
                 i.cashier_id, ca.display_name AS cashier_name,
                 COUNT(*) AS invoice_count,
                 SUM(i.subtotal) AS gross,
                 SUM(i.item_discount_amount) AS item_discounts,
                 SUM(i.invoice_discount_amount) AS invoice_discounts,
                 SUM(i.amount) AS net
            FROM invoices i
            JOIN channels ch ON ch.id = i.channel_id
            JOIN cashiers ca ON ca.id = i.cashier_id
           WHERE i.finalized_at >= ? AND i.finalized_at < ? ${f.sql}
           GROUP BY i.channel_id, i.cashier_id`,
      params: [range.start, range.end, ...f.params],
    };
  },

  /** Voids by void time, whenever the sale was; cashier = the voider. */
  voids(range: InstantRange, filters: ReportFilters): Query {
    const f = filterSql(filters, 'i.voided_by_cashier_id');
    return {
      sql: `SELECT i.id, i.invoice_number, i.finalized_at, i.voided_at, i.amount,
                 i.void_reason, i.voided_by_cashier_id,
                 COALESCE(i.voided_by_name_snapshot, vc.display_name) AS voided_by_name,
                 i.channel_id, ch.label AS channel_label
            FROM invoices i
            JOIN channels ch ON ch.id = i.channel_id
            JOIN cashiers vc ON vc.id = i.voided_by_cashier_id
           WHERE i.voided_at >= ? AND i.voided_at < ? ${f.sql}
           ORDER BY i.voided_at, i.id`,
      params: [range.start, range.end, ...f.params],
    };
  },

  /**
   * Payments by receipt time; cashier = the receiver. Split by the
   * invoice's finalization: on/after the day start = same-day invoice,
   * before it = older invoice (a payment never precedes its invoice).
   */
  paymentsByMethod(range: InstantRange, filters: ReportFilters): Query {
    const f = filterSql(filters, 'p.received_by_cashier_id');
    const invoiceQuery: Query = {
      sql: `SELECT p.method,
                 COUNT(*) AS payment_count,
                 SUM(p.amount) AS amount,
                 0 AS opening,
                 SUM(CASE WHEN i.finalized_at >= ? THEN p.amount ELSE 0 END) AS same_day,
                 SUM(CASE WHEN i.finalized_at < ? THEN p.amount ELSE 0 END) AS older
            FROM payments p
            JOIN invoices i ON i.id = p.invoice_id
           WHERE p.paid_at >= ? AND p.paid_at < ? ${f.sql}
           GROUP BY p.method`,
      params: [range.start, range.start, range.start, range.end, ...f.params],
    };
    if (filters.channelId) return invoiceQuery;
    return {
      sql: `SELECT method,SUM(payment_count) payment_count,SUM(amount) amount,SUM(same_day) same_day,SUM(older) older,SUM(opening) opening FROM (
        ${invoiceQuery.sql}
        UNION ALL
        SELECT method,COUNT(*) payment_count,SUM(amount) amount,SUM(amount) opening,0 same_day,0 older
        FROM customer_opening_payments
        WHERE paid_at>=? AND paid_at<? ${filters.cashierId ? 'AND received_by_cashier_id=?' : ''}
        GROUP BY method
      ) GROUP BY method`,
      params: [
        ...invoiceQuery.params,
        range.start,
        range.end,
        ...(filters.cashierId ? [filters.cashierId] : []),
      ],
    };
  },
} as const;

export class ReportRepository {
  constructor(private readonly db: AppDatabase) {}

  private all<T>(query: Query): T[] {
    return this.db.prepare(query.sql).all(...query.params) as T[];
  }

  sales(range: InstantRange, filters: ReportFilters): SalesGroupRow[] {
    return this.all(REPORT_QUERIES.sales(range, filters));
  }

  voids(range: InstantRange, filters: ReportFilters): VoidRow[] {
    return this.all(REPORT_QUERIES.voids(range, filters));
  }

  paymentsByMethod(
    range: InstantRange,
    filters: ReportFilters,
  ): PaymentMethodRow[] {
    return this.all(REPORT_QUERIES.paymentsByMethod(range, filters));
  }

  /** Current display name, or null when no such cashier exists. */
  cashierName(id: string): string | null {
    const row = this.db
      .prepare('SELECT display_name FROM cashiers WHERE id = ?')
      .get(id) as { display_name: string } | undefined;
    return row?.display_name ?? null;
  }

  /** Current label, or null when no such channel exists. */
  channelLabel(id: string): string | null {
    const row = this.db
      .prepare('SELECT label FROM channels WHERE id = ?')
      .get(id) as { label: string } | undefined;
    return row?.label ?? null;
  }
}
