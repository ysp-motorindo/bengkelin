import type { InvoicePrintModel } from '@/shared/contracts';
import { html, type SafeHtml } from '../escape';
import type { PrintLabels } from './labels';
import {
  headerFacts,
  localDateTime,
  logo,
  money,
  partyFacts,
  reprintBadge,
  settlementRows,
  totalRows,
  type TemplateOptions,
} from './shared';

/**
 * Receipt sections shared by the 58 mm and 80 mm layouts (shop header,
 * facts, totals, payments, footer). Each layout sets its own widths, font
 * size and line-item markup; these blocks only use the layout's classes.
 */

export function thermalCss(paperMm: number, printableMm: number): string {
  const side = (paperMm - printableMm) / 2;
  return `
@page { margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.sheet.receipt { width: ${printableMm}mm; margin: 0 ${side}mm; padding: 3mm 0 6mm; }
.receipt .center { text-align: center; }
.receipt .logo { margin: 0 auto 1.5mm; }
.receipt .shop-name { font-weight: 800; }
.receipt .rule { border-top: 1px dashed #000; margin: 1.5mm 0; }
.receipt .rule.solid { border-top-style: solid; }
.receipt .doc-title { text-align: center; font-weight: 800; letter-spacing: 0.06em; margin: 1mm 0; }
.receipt .reprint { display: block; width: fit-content; margin: 0.5mm auto; }
.receipt .r { display: flex; justify-content: space-between; align-items: baseline; gap: 1.5mm; }
.receipt .r > .l { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.receipt .r > .v { flex: none; text-align: right; white-space: nowrap; }
.receipt .strong { font-weight: 800; }
.receipt .big { font-size: 1.25em; }
.receipt .muted { color: #222; }
.receipt .footer { text-align: center; margin-top: 2mm; overflow-wrap: anywhere; }
.receipt .void-watermark { font-size: ${Math.round(printableMm * 0.9)}pt; top: 30%; }
`;
}

export function receiptHeader(
  model: InvoicePrintModel,
  labels: PrintLabels,
  options: TemplateOptions,
): SafeHtml {
  const shop = model.shop;
  return html`<header class="center">
${logo(options)}
<div class="shop-name wrap">${shop.name}</div>
<div class="wrap">${shop.address}</div>
${shop.phoneNumber ? html`<div class="wrap">${shop.phoneNumber}</div>` : ''}
${shop.email ? html`<div class="wrap">${shop.email}</div>` : ''}
</header>
<div class="rule solid"></div>
<div class="doc-title">${labels.invoice}</div>
${reprintBadge(model, labels)}`;
}

/** Label/value rows; `stacked` puts the value under the label (58 mm). */
export function factRows(
  model: InvoicePrintModel,
  labels: PrintLabels,
  layout: 'stacked' | 'columns',
): SafeHtml {
  const rows = [...headerFacts(model, labels), ...partyFacts(model, labels)];
  return html`<div class="facts facts-${layout}">${rows.map(
    ([label, value]) =>
      html`<div class="fact"><span class="fl">${label}</span><span class="fv">${value}</span></div>`,
  )}</div>`;
}

export function receiptTotals(
  model: InvoicePrintModel,
  labels: PrintLabels,
): SafeHtml {
  return html`<div class="totals">${totalRows(model, labels).map(
    (row) =>
      html`<div class="r${row.strong ? ' strong big' : ''}"><span class="l">${row.label}</span><span class="v">${row.value}</span></div>`,
  )}</div>`;
}

export function receiptPayments(
  model: InvoicePrintModel,
  labels: PrintLabels,
): SafeHtml {
  const list =
    model.payments.length === 0
      ? html`<div class="muted">${labels.noPayments}</div>`
      : model.payments.map(
          (payment, i) => html`<div class="payment">
<div class="r"><span class="l">${labels.paymentMethod[payment.method]}</span><span class="v">${money(`payment-${i + 1}`, payment.amount, labels.locale)}</span></div>
<div class="muted sub">${localDateTime(payment.paidAtLocal)} · ${payment.receivedBy}${
            payment.reference
              ? html` · ${labels.reference} ${payment.reference}`
              : ''
          }</div>
</div>`,
        );
  return html`<div class="payments">
<div class="strong">${labels.payments}</div>
${list}
</div>
<div class="rule"></div>
<div class="settlement">${settlementRows(model, labels).map(
    (row) =>
      html`<div class="r${row.strong ? ' strong' : ''}"><span class="l">${row.label}</span><span class="v">${row.value}</span></div>`,
  )}</div>`;
}

export function receiptFooter(
  model: InvoicePrintModel,
  labels: PrintLabels,
): SafeHtml {
  return html`${
    model.note
      ? html`<div class="rule"></div><div class="wrap">${labels.note}: ${model.note}</div>`
      : ''
  }
${
  model.shop.invoiceFooter
    ? html`<div class="rule"></div><div class="footer">${model.shop.invoiceFooter}</div>`
    : ''
}`;
}
