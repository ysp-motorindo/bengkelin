import type { InvoicePrintModel, PrintLine } from '@/shared/contracts';
import { html, type SafeHtml } from '../escape';
import type { PrintLabels } from './labels';
import {
  deduction,
  documentHtml,
  headerFacts,
  labelsFor,
  localDateTime,
  logo,
  money,
  partyFacts,
  quantity,
  reprintBadge,
  settlementRows,
  stageLabel,
  totalRows,
  voidMarking,
  type TemplateOptions,
} from './shared';

/**
 * A4 invoice: a paginated line table whose header rows repeat on every page
 * (`thead` as table-header-group), rows that never split across pages, long
 * names that wrap, and "Hal. x/y" / "Page x of y" page numbers from CSS page
 * margin boxes. 12 mm side margins leave 186 mm of printable width.
 */

export const A4_PRINTABLE_WIDTH_MM = 186;

function css(labels: PrintLabels): string {
  // Static labels only (never data): the page counter text.
  const before = JSON.stringify(labels.pageOf.before);
  const middle = JSON.stringify(labels.pageOf.middle);
  return `
@page { size: A4; margin: 14mm 12mm 16mm 12mm;
  @bottom-right { content: ${before} counter(page) ${middle} counter(pages);
    font-size: 8pt; color: #444; } }
html, body { margin: 0; padding: 0; background: #fff; }
.sheet.layout-a4 { width: ${A4_PRINTABLE_WIDTH_MM}mm; font-size: 9pt; }
.layout-a4 .head { display: flex; justify-content: space-between; gap: 8mm;
  align-items: flex-start; border-bottom: 1.5px solid #000; padding-bottom: 3mm; }
.layout-a4 .shop { display: flex; gap: 4mm; align-items: flex-start; min-width: 0; }
.layout-a4 .logo { max-width: 30mm; max-height: 20mm; }
.layout-a4 .shop-name { font-size: 14pt; font-weight: 700; }
.layout-a4 .doc { text-align: right; flex: none; }
.layout-a4 .doc-title { font-size: 16pt; font-weight: 800; letter-spacing: 0.06em; }
.layout-a4 .doc-number { font-size: 11pt; font-weight: 600; margin-top: 1mm; }
.layout-a4 .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 0 8mm;
  margin: 3mm 0; }
.layout-a4 .facts dl { display: grid; grid-template-columns: 28mm 1fr; gap: 0.6mm 2mm; margin: 0; }
.layout-a4 .facts dt { color: #333; }
.layout-a4 .facts dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
.layout-a4 table.lines { width: 100%; border-collapse: collapse; }
.layout-a4 table.lines thead { display: table-header-group; }
.layout-a4 table.lines tr { break-inside: avoid; page-break-inside: avoid; }
.layout-a4 table.lines th { text-align: left; font-weight: 700; border-bottom: 1px solid #000;
  padding: 1.2mm 1.5mm; background: #eee; }
.layout-a4 table.lines th.running { background: #fff; border-bottom: none; font-weight: 600;
  font-size: 8pt; color: #333; padding-bottom: 0.5mm; }
.layout-a4 table.lines td { padding: 1.2mm 1.5mm; border-bottom: 0.5px solid #999;
  vertical-align: top; }
.layout-a4 .c-no { width: 8mm; }
.layout-a4 .c-qty { width: 20mm; text-align: right; }
.layout-a4 .c-price { width: 26mm; text-align: right; }
.layout-a4 .c-disc { width: 46mm; }
.layout-a4 .c-amount { width: 28mm; text-align: right; }
.layout-a4 table.lines th.c-qty, .layout-a4 table.lines th.c-price,
.layout-a4 table.lines th.c-amount { text-align: right; }
.layout-a4 .sub { font-size: 8pt; color: #333; }
.layout-a4 .stage { display: flex; justify-content: space-between; gap: 2mm; font-size: 8pt; }
.layout-a4 .bottom { display: grid; grid-template-columns: 1fr 68mm; gap: 8mm; margin-top: 4mm;
  break-inside: avoid; page-break-inside: avoid; }
.layout-a4 .totals { display: grid; grid-template-columns: 1fr auto; gap: 0.8mm 3mm; margin: 0; }
.layout-a4 .totals dt, .layout-a4 .totals dd { margin: 0; }
.layout-a4 .totals dd { text-align: right; }
.layout-a4 .totals .strong { font-weight: 800; font-size: 11pt; border-top: 1px solid #000;
  padding-top: 1mm; }
.layout-a4 .section-title { font-weight: 700; margin-bottom: 1mm; }
.layout-a4 table.payments { width: 100%; border-collapse: collapse; font-size: 8pt; }
.layout-a4 table.payments th { text-align: left; border-bottom: 1px solid #000; padding: 0.8mm 1mm; }
.layout-a4 table.payments td { padding: 0.8mm 1mm; border-bottom: 0.5px solid #bbb; vertical-align: top; }
.layout-a4 table.payments .r { text-align: right; }
.layout-a4 .nowrap { white-space: nowrap; }
.layout-a4 .invoice-contacts { display: flex; gap: 4mm; align-items: center; margin-top: 3mm;
  break-inside: avoid; page-break-inside: avoid; }
.layout-a4 .social-qr { width: 40mm; height: 40mm; flex: none; image-rendering: pixelated; }
.layout-a4 .contact-copy { min-width: 0; overflow-wrap: anywhere; }
.layout-a4 .contact-copy strong { white-space: pre-line; }
.layout-a4 .note { margin-top: 3mm; overflow-wrap: anywhere; }
.layout-a4 footer { margin-top: 6mm; border-top: 0.5px solid #999; padding-top: 2mm;
  font-size: 8pt; text-align: center; overflow-wrap: anywhere; }
.layout-a4 .reprint { margin-top: 1mm; font-size: 9pt; }
.layout-a4 .void-watermark { font-size: 120pt; }
`;
}

function lineRow(line: PrintLine, labels: PrintLabels): SafeHtml {
  const n = line.position;
  return html`<tr>
<td class="c-no">${n}</td>
<td class="wrap">${line.title}${
    line.mechanicName
      ? html`<div class="sub">${labels.mechanic}: ${line.mechanicName}</div>`
      : ''
  }</td>
<td class="c-qty">${quantity(line, labels)}</td>
<td class="c-price">${money(`line-${n}-unitPrice`, line.unitPrice, labels.locale)}</td>
<td class="c-disc">${line.discounts.map(
    (stage) =>
      html`<div class="stage"><span>${stageLabel(stage, labels)}</span>${deduction(`line-${n}-stage-${stage.sequence}`, stage.amount, labels.locale)}</div>`,
  )}</td>
<td class="c-amount">${money(`line-${n}-amount`, line.amount, labels.locale)}</td>
</tr>`;
}

function facts(rows: [string, string][]): SafeHtml {
  return html`<dl>${rows.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>`;
}

function payments(model: InvoicePrintModel, labels: PrintLabels): SafeHtml {
  if (model.payments.length === 0) {
    return html`<div class="section-title">${labels.payments}</div><div>${labels.noPayments}</div>`;
  }
  return html`<div class="section-title">${labels.payments}</div>
<table class="payments">
<thead><tr><th>${labels.invoiceDate}</th><th>${labels.method}</th><th>${labels.reference}</th><th>${labels.receivedBy}</th><th class="r">${labels.amount}</th></tr></thead>
<tbody>${model.payments.map(
    (payment, i) => html`<tr>
<td class="nowrap">${localDateTime(payment.paidAtLocal)}</td>
<td>${labels.paymentMethod[payment.method]}</td>
<td class="wrap">${payment.reference ?? ''}</td>
<td>${payment.receivedBy}</td>
<td class="r">${money(`payment-${i + 1}`, payment.amount, labels.locale)}</td>
</tr>`,
  )}</tbody>
</table>`;
}

export function renderA4(
  model: InvoicePrintModel,
  options: TemplateOptions,
): string {
  const labels = labelsFor(model, options);
  const marking = voidMarking(model, labels);
  const shop = model.shop;
  const contact = [shop.phoneNumber, shop.email].filter(Boolean).join(' · ');
  const body = html`<div class="sheet layout-a4">
${marking.watermark}
<header class="head">
  <div class="shop">${logo(options)}<div>
    <h1 class="shop-name wrap">${shop.name}</h1>
    <p class="wrap">${shop.address}</p>
    ${contact ? html`<p class="wrap">${contact}</p>` : ''}
  </div></div>
  <div class="doc">
    <div class="doc-title">${labels.invoice}</div>
    <div class="doc-number">${model.invoiceNumber}</div>
    ${reprintBadge(model, labels)}
  </div>
</header>
${marking.banner}
<section class="facts">
  ${facts(headerFacts(model, labels).slice(1))}
  ${facts(partyFacts(model, labels))}
</section>
<table class="lines">
<thead>
<tr><th class="running" colspan="6">${labels.invoiceNumber} ${model.invoiceNumber}</th></tr>
<tr><th class="c-no">#</th><th>${labels.item}</th><th class="c-qty">${labels.quantity}</th><th class="c-price">${labels.unitPrice}</th><th class="c-disc">${labels.discount}</th><th class="c-amount">${labels.amount}</th></tr>
</thead>
<tbody>
${model.lines.map((line) => lineRow(line, labels))}
</tbody>
</table>
<section class="bottom">
  <div>
    ${payments(model, labels)}
    ${
      options.complaintPhoneNumber || options.socialMediaQrDataUrl
        ? html`<section class="invoice-contacts">
      ${options.socialMediaQrDataUrl ? html`<img class="social-qr" src="${options.socialMediaQrDataUrl}" alt="${labels.socialMedia}" />` : ''}
      <div class="contact-copy">
        ${options.complaintPhoneNumber ? html`<div><strong>${labels.complaintContact}</strong><br />${options.complaintPhoneNumber}</div>` : ''}
      </div>
    </section>`
        : ''
    }
    ${model.note ? html`<div class="note"><strong>${labels.note}:</strong> ${model.note}</div>` : ''}
  </div>
  <dl class="totals">
    ${totalRows(model, labels).map(
      (row) =>
        html`<dt class="${row.strong ? 'strong' : ''}">${row.label}</dt><dd class="${row.strong ? 'strong' : ''}">${row.value}</dd>`,
    )}
    ${settlementRows(model, labels).map(
      (row) =>
        html`<dt class="${row.strong ? 'strong' : ''}">${row.label}</dt><dd class="${row.strong ? 'strong' : ''}">${row.value}</dd>`,
    )}
  </dl>
</section>
${shop.invoiceFooter ? html`<footer>${shop.invoiceFooter}</footer>` : ''}
</div>`;
  return documentHtml(model, css(labels), body);
}
