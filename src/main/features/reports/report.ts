import { localDateTime } from '@/main/features/printing/model';
import {
  PAYMENT_METHODS,
  type CashierRefDto,
  type ChannelRefDto,
  type DailyReport,
  type DailyReportCashierRow,
  type DailyReportChannelRow,
  type PaymentMethod,
} from '@/shared/contracts';
import {
  formatRupiah,
  type Instant,
  type LocalDate,
} from '@/shared/primitives';
import { businessDay, type InstantRange } from '@/shared/time';
import { toNumber } from '@/main/database/rows';
import type { PaymentMethodRow, SalesGroupRow, VoidRow } from './repository';

/**
 * Rows -> the one DailyReport DTO. Pure: no database, clock or I/O. All
 * arithmetic is bigint over the integers SQLite summed; results cross IPC as
 * canonical integer strings.
 */

export interface ReportContext {
  date: LocalDate;
  timezone: string;
  range: InstantRange;
  generatedAt: Instant;
  filters: DailyReport['filters'];
}

export interface ReportRows {
  sales: SalesGroupRow[];
  voids: VoidRow[];
  payments: PaymentMethodRow[];
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, 'id', { sensitivity: 'base' }) ||
  (a < b ? -1 : a > b ? 1 : 0);

interface Group<K> {
  key: K;
  invoiceCount: bigint;
  net: bigint;
}

function groupSales<K extends { id: string }>(
  rows: SalesGroupRow[],
  keyOf: (row: SalesGroupRow) => K,
): Group<K>[] {
  const groups = new Map<string, Group<K>>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key.id) ?? { key, invoiceCount: 0n, net: 0n };
    group.invoiceCount += row.invoice_count;
    group.net += row.net;
    groups.set(key.id, group);
  }
  return [...groups.values()];
}

export function toDailyReport(
  context: ReportContext,
  rows: ReportRows,
): DailyReport {
  const { timezone } = context;

  // ---- sales (by finalization) ----
  let invoiceCount = 0n;
  let gross = 0n;
  let itemDiscounts = 0n;
  let invoiceDiscounts = 0n;
  let net = 0n;
  for (const row of rows.sales) {
    invoiceCount += row.invoice_count;
    gross += row.gross;
    itemDiscounts += row.item_discounts;
    invoiceDiscounts += row.invoice_discounts;
    net += row.net;
  }
  const byChannel: DailyReportChannelRow[] = groupSales<ChannelRefDto>(
    rows.sales,
    (r) => ({ id: r.channel_id, label: r.channel_label }),
  )
    .sort(
      (a, b) => byName(a.key.label, b.key.label) || byName(a.key.id, b.key.id),
    )
    .map((g) => ({
      channel: g.key,
      invoiceCount: toNumber(g.invoiceCount),
      netBeforeVoids: formatRupiah(g.net),
    }));
  const byCashier: DailyReportCashierRow[] = groupSales<CashierRefDto>(
    rows.sales,
    (r) => ({ id: r.cashier_id, displayName: r.cashier_name }),
  )
    .sort(
      (a, b) =>
        byName(a.key.displayName, b.key.displayName) ||
        byName(a.key.id, b.key.id),
    )
    .map((g) => ({
      cashier: g.key,
      invoiceCount: toNumber(g.invoiceCount),
      netBeforeVoids: formatRupiah(g.net),
    }));

  // ---- voids (by void time) ----
  let deduction = 0n;
  const voided = rows.voids.map((row) => {
    deduction += row.amount;
    return {
      invoiceId: row.id,
      invoiceNumber: row.invoice_number,
      finalizedAt: row.finalized_at,
      finalizedDate: businessDay(row.finalized_at, timezone),
      voidedAt: row.voided_at,
      voidedAtLocal: localDateTime(row.voided_at, timezone),
      amount: formatRupiah(row.amount),
      reason: row.void_reason,
      voidedBy: {
        id: row.voided_by_cashier_id,
        displayName: row.voided_by_name,
      },
      channel: { id: row.channel_id, label: row.channel_label },
    };
  });

  // ---- payments (by receipt time) ----
  const methods = new Map(rows.payments.map((r) => [r.method, r]));
  let received = 0n;
  let paymentCount = 0n;
  let sameDay = 0n;
  let older = 0n;
  const byMethod = PAYMENT_METHODS.map((method: PaymentMethod) => {
    const row = methods.get(method);
    received += row?.amount ?? 0n;
    paymentCount += row?.payment_count ?? 0n;
    sameDay += row?.same_day ?? 0n;
    older += row?.older ?? 0n;
    return {
      method,
      count: toNumber(row?.payment_count ?? 0n),
      amount: formatRupiah(row?.amount ?? 0n),
    };
  });

  return {
    date: context.date,
    timezone,
    range: { start: context.range.start, end: context.range.end },
    generatedAt: context.generatedAt,
    generatedAtLocal: localDateTime(context.generatedAt, timezone),
    filters: context.filters,
    sales: {
      invoiceCount: toNumber(invoiceCount),
      grossSubtotal: formatRupiah(gross),
      itemDiscounts: formatRupiah(itemDiscounts),
      invoiceDiscounts: formatRupiah(invoiceDiscounts),
      netBeforeVoids: formatRupiah(net),
      byChannel,
      byCashier,
    },
    voids: {
      count: voided.length,
      deduction: formatRupiah(deduction),
      invoices: voided,
    },
    // May be negative: the one signed money field.
    netAfterVoids: formatRupiah(net - deduction),
    payments: {
      received: formatRupiah(received),
      count: toNumber(paymentCount),
      byMethod,
      sameDayInvoices: formatRupiah(sameDay),
      olderInvoices: formatRupiah(older),
    },
  };
}
