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
 * 58 mm receipt (about 48 mm printable, ~30 characters a row). Everything
 * is stacked: facts put the value under the label, each item starts with
 * its wrapped title, then "qty × price" with the amount right-aligned, and
 * one row per discount stage.
 */

export const THERMAL_58_PRINTABLE_MM = 48;

const CSS = `${thermalCss(58, THERMAL_58_PRINTABLE_MM)}
.sheet.layout-58 { font-size: 8pt; }
.layout-58 .logo { max-width: 32mm; max-height: 16mm; }
.layout-58 .shop-name { font-size: 10pt; }
.layout-58 .doc-title { font-size: 10pt; }
.layout-58 .fact { display: flex; flex-wrap: wrap; column-gap: 1.5mm; }
.layout-58 .fact .fl { flex: none; color: #222; }
.layout-58 .fact .fv { flex: 1 1 auto; min-width: 0; margin-left: auto; text-align: right;
  font-weight: 600; overflow-wrap: anywhere; }
.layout-58 .item { margin-bottom: 1.2mm; }
.layout-58 .item-title { font-weight: 600; overflow-wrap: anywhere; }
.layout-58 .sub { font-size: 7pt; }
.layout-58 .stage { font-size: 7pt; padding-left: 2mm; }
`;

function item(line: PrintLine, labels: PrintLabels): SafeHtml {
  const n = line.position;
  const hasStages = line.discounts.length > 0;
  const amount = money(`line-${n}-amount`, line.amount);
  return html`<div class="item">
<div class="item-title">${n}. ${line.title}</div>
${line.mechanicName ? html`<div class="sub">${labels.mechanic}: ${line.mechanicName}</div>` : ''}
<div class="r"><span class="l">${quantity(line, labels)} × ${money(`line-${n}-unitPrice`, line.unitPrice)}</span>${
    hasStages ? '' : html`<span class="v">${amount}</span>`
  }</div>
${line.discounts.map(
  (stage) =>
    html`<div class="r stage"><span class="l">${stageLabel(stage, labels)}</span><span class="v">${deduction(`line-${n}-stage-${stage.sequence}`, stage.amount)}</span></div>`,
)}
${hasStages ? html`<div class="r"><span class="l"></span><span class="v strong">${amount}</span></div>` : ''}
</div>`;
}

export function renderThermal58(
  model: InvoicePrintModel,
  options: TemplateOptions,
): string {
  const labels = labelsFor(model);
  const marking = voidMarking(model, labels);
  const body = html`<div class="sheet receipt layout-58">
${marking.watermark}
${receiptHeader(model, labels, options)}
${marking.banner}
<div class="rule"></div>
${factRows(model, labels, 'stacked')}
<div class="rule"></div>
${model.lines.map((line) => item(line, labels))}
<div class="rule"></div>
${receiptTotals(model, labels)}
<div class="rule"></div>
${receiptPayments(model, labels)}
${receiptFooter(model, labels)}
</div>`;
  return documentHtml(model, CSS, body);
}
