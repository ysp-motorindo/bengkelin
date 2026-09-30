import { csvInteger, formatCsv, type CsvRow } from '@/main/features/csv/writer';
import type { DailyReport } from '@/shared/contracts';
import type { ReportLabels } from './labels';

/**
 * The daily report as a sectioned CSV (one file, blank line between
 * sections): header facts, sales summary, sales by channel, sales by
 * cashier, voids, payments by method, payment breakdown. Every figure is
 * copied from the DailyReport DTO; nothing is recomputed. Money and counts
 * are integer cells (plain digits); the signed `netAfterVoids` becomes
 * guarded text when negative (see csv/writer.ts). Names, reasons and labels
 * are formula-guarded text.
 */
export function dailyReportCsvRows(
  report: DailyReport,
  labels: ReportLabels,
): CsvRow[] {
  const n = csvInteger;
  const rows: CsvRow[] = [
    [labels.title],
    [labels.date, report.date],
    [labels.timezone, report.timezone],
    [labels.generatedAt, report.generatedAtLocal],
    [labels.cashierFilter, report.filters.cashier?.displayName ?? labels.all],
    [labels.channelFilter, report.filters.channel?.label ?? labels.all],
    [],
    [labels.salesSummary],
    [labels.metric, labels.value],
    [labels.invoiceCount, n(report.sales.invoiceCount)],
    [labels.grossSubtotal, n(report.sales.grossSubtotal)],
    [labels.itemDiscounts, n(report.sales.itemDiscounts)],
    [labels.invoiceDiscounts, n(report.sales.invoiceDiscounts)],
    [labels.netBeforeVoids, n(report.sales.netBeforeVoids)],
    [labels.voidCount, n(report.voids.count)],
    [labels.voidDeduction, n(report.voids.deduction)],
    [labels.netAfterVoids, n(report.netAfterVoids)],
    [],
    [labels.byChannel],
    [labels.channel, labels.invoiceCount, labels.netSales],
    ...report.sales.byChannel.map((r) => [
      r.channel.label,
      n(r.invoiceCount),
      n(r.netBeforeVoids),
    ]),
    [],
    [labels.byCashier],
    [labels.cashier, labels.invoiceCount, labels.netSales],
    ...report.sales.byCashier.map((r) => [
      r.cashier.displayName,
      n(r.invoiceCount),
      n(r.netBeforeVoids),
    ]),
    [],
    [labels.voids],
    [
      labels.invoiceNumber,
      labels.finalizedDate,
      labels.voidedAt,
      labels.voidedBy,
      labels.channel,
      labels.reason,
      labels.amount,
    ],
    ...report.voids.invoices.map((v) => [
      v.invoiceNumber,
      v.finalizedDate,
      v.voidedAtLocal,
      v.voidedBy.displayName,
      v.channel.label,
      v.reason,
      n(v.amount),
    ]),
    [],
    [labels.paymentsByMethod],
    [labels.method, labels.count, labels.amount],
    ...report.payments.byMethod.map((m) => [
      labels.paymentMethod[m.method],
      n(m.count),
      n(m.amount),
    ]),
    [],
    [labels.paymentSplit],
    [labels.metric, labels.value],
    [labels.received, n(report.payments.received)],
    [labels.sameDayInvoices, n(report.payments.sameDayInvoices)],
    [labels.olderInvoices, n(report.payments.olderInvoices)],
    [labels.paymentCount, n(report.payments.count)],
  ];
  return rows;
}

export function dailyReportCsv(
  report: DailyReport,
  labels: ReportLabels,
): string {
  return formatCsv(dailyReportCsvRows(report, labels));
}
