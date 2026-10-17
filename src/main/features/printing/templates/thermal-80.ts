import type { InvoicePrintModel, PrintLine } from '@/shared/contracts';
import { html, type SafeHtml } from '../escape';
import type { PrintLabels } from './labels';
import {
  deduction,
  documentHtml,
  labelsFor,
  money,
  quantity,
  stageLabel,
  voidMarking,
  type TemplateOptions,
} from './shared';
import {
  factRows,
  receiptFooter,
  receiptHeader,
  receiptPayments,
  receiptTotals,
  thermalCss,
} from './thermal-common';

/**
 * 80 mm receipt (about 72 mm printable, ~42 characters a row). Facts sit in
 * label/value columns and items use a column table (qty, price, amount)
 * under a header row, with discount stages indented under the item.
 */

export const THERMAL_80_PRINTABLE_MM = 72;

const CSS = `${thermalCss(80, THERMAL_80_PRINTABLE_MM)}
.sheet.layout-80 { font-size: 9pt; }
.layout-80 .logo { max-width: 44mm; max-height: 20mm; }
.layout-80 .shop-name { font-size: 12pt; }
.layout-80 .doc-title { font-size: 12pt; }
.layout-80 .fact { display: grid; grid-template-columns: 22mm 1fr; gap: 1.5mm; }
.layout-80 .fact .fv { font-weight: 600; overflow-wrap: anywhere; }
.layout-80 table.items { width: 100%; border-collapse: collapse; }
.layout-80 table.items th { font-size: 8pt; text-align: right; border-bottom: 1px solid #000;
  padding: 0 0 0.6mm; }
.layout-80 table.items th:first-child { text-align: left; }
.layout-80 table.items td { vertical-align: top; padding: 0.3mm 0; }
.layout-80 td.t { font-weight: 600; overflow-wrap: anywhere; padding-top: 1.2mm; }
.layout-80 td.q { text-align: right; white-space: nowrap; width: 16mm; }
.layout-80 table.items td.p { text-align: right; width: 25mm; padding-left: 2mm; }
.layout-80 table.items td.a { text-align: right; width: 24mm; padding-left: 2mm; }
.layout-80 table.items td.s { padding-left: 3mm; font-size: 8pt; }
.layout-80 .sub { font-weight: 400; font-size: 8pt; }
`;

function item(line: PrintLine, labels: PrintLabels): SafeHtml {
  const n = line.position;
  const hasStages = line.discounts.length > 0;
  const amount = money(`line-${n}-amount`, line.amount, labels.locale);
  return html`<tr><td class="t" colspan="4">${n}. ${line.title}${
    line.mechanicName
      ? html`<div class="sub">${labels.mechanic}: ${line.mechanicName}</div>`
      : ''
  }</td></tr>
<tr><td></td><td class="q">${quantity(line, labels)}</td><td class="p">${money(`line-${n}-unitPrice`, line.unitPrice, labels.locale)}</td><td class="a">${hasStages ? '' : amount}</td></tr>
${line.discounts.map(
  (stage) =>
    html`<tr><td class="s" colspan="3">${stageLabel(stage, labels)}</td><td class="a">${deduction(`line-${n}-stage-${stage.sequence}`, stage.amount, labels.locale)}</td></tr>`,
)}
${hasStages ? html`<tr><td class="s" colspan="3">${labels.amount}</td><td class="a strong">${amount}</td></tr>` : ''}`;
}

export function renderThermal80(
  model: InvoicePrintModel,
  options: TemplateOptions,
): string {
  const labels = labelsFor(model, options);
  const marking = voidMarking(model, labels);
  const body = html`<div class="sheet receipt layout-80">
${marking.watermark}
${receiptHeader(model, labels, options)}
${marking.banner}
<div class="rule"></div>
${factRows(model, labels, 'columns')}
<div class="rule"></div>
<table class="items">
<thead><tr><th>${labels.item}</th><th>${labels.quantity}</th><th>${labels.unitPrice}</th><th>${labels.amount}</th></tr></thead>
<tbody>
${model.lines.map((line) => item(line, labels))}
</tbody>
</table>
<div class="rule"></div>
${receiptTotals(model, labels)}
<div class="rule"></div>
${receiptPayments(model, labels)}
${receiptFooter(model, labels)}
</div>`;
  return documentHtml(model, CSS, body);
}
