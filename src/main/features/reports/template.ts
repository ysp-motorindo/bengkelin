import { html, type SafeHtml } from '@/main/features/printing/escape';
import {
  documentShell,
  localDate,
  localDateTime,
  money as formattedMoney,
} from '@/main/features/printing/templates/shared';
import type { DailyReport, Language, PrintPageInfo } from '@/shared/contracts';
import type { ReportLabels } from './labels';

/**
 * The printed daily report (A4). A pure `(report, options) -> HTML` template
 * built only with the T12 escaped `html` helper: every name, reason and
 * label is escaped, money is only FORMATTED (BigInt `formatIdr` via
 * `money`), never recomputed. Every figure carries `data-money` /
 * `data-count` with its DTO path so tests can prove the printout equals the
 * DTO. The shop timezone is printed in the header.
 */

export const REPORT_A4_PRINTABLE_WIDTH_MM = 186;

export const REPORT_PAGE_INFO: PrintPageInfo = {
  format: 'A4',
  widthMm: 210,
  heightMm: 297,
  printableWidthMm: REPORT_A4_PRINTABLE_WIDTH_MM,
  paginated: true,
};

export interface ReportTemplateOptions {
  language: Language;
  labels: ReportLabels;
  shopName: string;
  numberLocale?: string;
}

function css(labels: ReportLabels): string {
  // Static labels only (never data): the page counter text.
  const before = JSON.stringify(labels.pageOf.before);
  const middle = JSON.stringify(labels.pageOf.middle);
  return `
@page { size: A4; margin: 14mm 12mm 16mm 12mm;
  @bottom-right { content: ${before} counter(page) ${middle} counter(pages);
    font-size: 8pt; color: #444; } }
html, body { margin: 0; padding: 0; background: #fff; }
.sheet.layout-a4 { width: ${REPORT_A4_PRINTABLE_WIDTH_MM}mm; font-size: 9pt; }
.layout-a4 .head { display: flex; justify-content: space-between; gap: 8mm;
  align-items: flex-start; border-bottom: 1.5px solid #000; padding-bottom: 3mm; }
.layout-a4 .shop-name { font-size: 13pt; font-weight: 700; }
.layout-a4 .doc { text-align: right; flex: none; }
.layout-a4 .doc-title { font-size: 15pt; font-weight: 800; letter-spacing: 0.04em; }
.layout-a4 .doc-date { font-size: 11pt; font-weight: 600; margin-top: 1mm; }
.layout-a4 .facts { display: grid; grid-template-columns: 32mm 1fr; gap: 0.6mm 2mm;
  margin: 3mm 0; }
.layout-a4 .facts dt { color: #333; }
.layout-a4 .facts dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
.layout-a4 section { margin-top: 5mm; }
.layout-a4 h2 { font-size: 11pt; font-weight: 700; border-bottom: 1px solid #000;
  padding-bottom: 1mm; margin-bottom: 1.5mm; }
.layout-a4 .basis { font-size: 8pt; color: #333; margin-bottom: 1.5mm; }
.layout-a4 .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; }
.layout-a4 .summary { display: grid; grid-template-columns: 1fr auto; gap: 0.8mm 3mm; margin: 0;
  align-self: start; break-inside: avoid; page-break-inside: avoid; }
.layout-a4 .summary dt, .layout-a4 .summary dd { margin: 0; }
.layout-a4 .summary dd { text-align: right; }
.layout-a4 .summary .strong { font-weight: 800; border-top: 1px solid #000; padding-top: 1mm; }
.layout-a4 table { width: 100%; border-collapse: collapse; }
.layout-a4 thead { display: table-header-group; }
.layout-a4 tr { break-inside: avoid; page-break-inside: avoid; }
.layout-a4 th { text-align: left; font-weight: 700; border-bottom: 1px solid #000;
  padding: 1mm 1.5mm; background: #eee; }
.layout-a4 td { padding: 1mm 1.5mm; border-bottom: 0.5px solid #999; vertical-align: top; }
.layout-a4 .r { text-align: right; }
.layout-a4 .nowrap { white-space: nowrap; }
.layout-a4 .empty { color: #555; font-style: italic; }
.layout-a4 h3 { font-size: 9.5pt; font-weight: 700; margin: 3mm 0 1mm; }
`;
}

function count(field: string, value: number, labels: ReportLabels): SafeHtml {
  const text = new Intl.NumberFormat(labels.locale, {
    numberingSystem: 'latn',
  }).format(value);
  return html`<span class="num" data-count="${field}">${text}</span>`;
}

function summary(
  rows: { label: string; value: SafeHtml; strong?: boolean }[],
): SafeHtml {
  return html`<dl class="summary">${rows.map(
    (row) =>
      html`<dt class="${row.strong ? 'strong' : ''}">${row.label}</dt><dd class="${row.strong ? 'strong' : ''}">${row.value}</dd>`,
  )}</dl>`;
}

function table(
  headers: { label: string; right?: boolean }[],
  body: SafeHtml[],
  labels: ReportLabels,
): SafeHtml {
  return html`<table>
<thead><tr>${headers.map((h) => html`<th class="${h.right ? 'r' : ''}">${h.label}</th>`)}</tr></thead>
<tbody>${
    body.length > 0
      ? body
      : html`<tr><td class="empty" colspan="${headers.length}">${labels.none}</td></tr>`
  }</tbody>
</table>`;
}

export function renderDailyReportHtml(
  report: DailyReport,
  options: ReportTemplateOptions,
): string {
  const labels = { ...options.labels, locale: options.numberLocale ?? 'id-ID' };
  const money = (field: string, value: string) =>
    formattedMoney(field, value, labels.locale);
  const { sales, voids, payments } = report;
  const body = html`<div class="sheet layout-a4">
<header class="head">
  <div><h1 class="shop-name wrap">${options.shopName}</h1></div>
  <div class="doc">
    <div class="doc-title">${labels.title}</div>
    <div class="doc-date">${localDate(report.date)}</div>
  </div>
</header>
<dl class="facts">
  <dt>${labels.date}</dt><dd>${localDate(report.date)}</dd>
  <dt>${labels.timezone}</dt><dd>${report.timezone}</dd>
  <dt>${labels.generatedAt}</dt><dd>${localDateTime(report.generatedAtLocal)}</dd>
  <dt>${labels.cashierFilter}</dt><dd>${report.filters.cashier?.displayName ?? labels.all}</dd>
  <dt>${labels.channelFilter}</dt><dd>${report.filters.channel?.label ?? labels.all}</dd>
</dl>

<section>
  <h2>${labels.salesSummary}</h2>
  <p class="basis">${labels.salesBasis}</p>
  <div class="columns">
    ${summary([
      {
        label: labels.invoiceCount,
        value: count('sales.invoiceCount', sales.invoiceCount, labels),
      },
      {
        label: labels.grossSubtotal,
        value: money('sales.grossSubtotal', sales.grossSubtotal),
      },
      {
        label: labels.itemDiscounts,
        value: money('sales.itemDiscounts', sales.itemDiscounts),
      },
      {
        label: labels.invoiceDiscounts,
        value: money('sales.invoiceDiscounts', sales.invoiceDiscounts),
      },
      {
        label: labels.netBeforeVoids,
        value: money('sales.netBeforeVoids', sales.netBeforeVoids),
        strong: true,
      },
    ])}
    ${summary([
      {
        label: labels.voidCount,
        value: count('voids.count', voids.count, labels),
      },
      {
        label: labels.voidDeduction,
        value: money('voids.deduction', voids.deduction),
      },
      {
        label: labels.netAfterVoids,
        value: money('netAfterVoids', report.netAfterVoids),
        strong: true,
      },
    ])}
  </div>
  <div class="columns">
    <div>
      <h3>${labels.byChannel}</h3>
      ${table(
        [
          { label: labels.channel },
          { label: labels.invoiceCount, right: true },
          { label: labels.netSales, right: true },
        ],
        sales.byChannel.map(
          (row, i) => html`<tr><td class="wrap">${row.channel.label}</td>
<td class="r">${count(`sales.byChannel.${i}.invoiceCount`, row.invoiceCount, labels)}</td>
<td class="r">${money(`sales.byChannel.${i}.netBeforeVoids`, row.netBeforeVoids)}</td></tr>`,
        ),
        labels,
      )}
    </div>
    <div>
      <h3>${labels.byCashier}</h3>
      ${table(
        [
          { label: labels.cashier },
          { label: labels.invoiceCount, right: true },
          { label: labels.netSales, right: true },
        ],
        sales.byCashier.map(
          (row, i) => html`<tr><td class="wrap">${row.cashier.displayName}</td>
<td class="r">${count(`sales.byCashier.${i}.invoiceCount`, row.invoiceCount, labels)}</td>
<td class="r">${money(`sales.byCashier.${i}.netBeforeVoids`, row.netBeforeVoids)}</td></tr>`,
        ),
        labels,
      )}
    </div>
  </div>
</section>

<section>
  <h2>${labels.voids}</h2>
  ${table(
    [
      { label: labels.invoiceNumber },
      { label: labels.finalizedDate },
      { label: labels.voidedAt },
      { label: labels.voidedBy },
      { label: labels.channel },
      { label: labels.reason },
      { label: labels.amount, right: true },
    ],
    voids.invoices.map(
      (v, i) => html`<tr><td class="nowrap">${v.invoiceNumber}</td>
<td class="nowrap">${localDate(v.finalizedDate)}</td>
<td class="nowrap">${localDateTime(v.voidedAtLocal)}</td>
<td class="wrap">${v.voidedBy.displayName}</td>
<td class="wrap">${v.channel.label}</td>
<td class="wrap">${v.reason}</td>
<td class="r">${money(`voids.invoices.${i}.amount`, v.amount)}</td></tr>`,
    ),
    labels,
  )}
</section>

<section>
  <h2>${labels.paymentSplit}</h2>
  <p class="basis">${labels.paymentsBasis}</p>
  <div class="columns">
    ${summary([
      {
        label: labels.paymentCount,
        value: count('payments.count', payments.count, labels),
      },
      {
        label: labels.sameDayInvoices,
        value: money('payments.sameDayInvoices', payments.sameDayInvoices),
      },
      {
        label: labels.olderInvoices,
        value: money('payments.olderInvoices', payments.olderInvoices),
      },
      {
        label: labels.received,
        value: money('payments.received', payments.received),
        strong: true,
      },
    ])}
    <div>
      <h3>${labels.paymentsByMethod}</h3>
      ${table(
        [
          { label: labels.method },
          { label: labels.count, right: true },
          { label: labels.amount, right: true },
        ],
        payments.byMethod.map(
          (m) => html`<tr><td>${labels.paymentMethod[m.method]}</td>
<td class="r">${count(`payments.byMethod.${m.method}.count`, m.count, labels)}</td>
<td class="r">${money(`payments.byMethod.${m.method}.amount`, m.amount)}</td></tr>`,
        ),
        labels,
      )}
    </div>
  </div>
</section>
</div>`;
  return documentShell({
    language: options.language,
    title: `${labels.title} ${report.date}`,
    css: css(labels),
    body,
  });
}
