import { numberSymbols, formatNumericText } from '@/shared/number-format';
import type {
  InvoicePrintModel,
  PrintDiscountStage,
  PrintLine,
} from '@/shared/contracts';
import { formatIdr } from '@/shared/idr';
import { formatBpsAsPercentage } from '@/shared/percentage';
import { html, trusted, type SafeHtml } from '../escape';
import { PRINT_LABELS, type PrintLabels } from './labels';

/**
 * Building blocks shared by the A4 and thermal templates. Templates are pure
 * `(model, options) -> HTML document string`: no scripts, no remote assets,
 * system fonts only. Money is only FORMATTED here (BigInt `formatIdr`), never
 * recomputed. Every printed money value carries `data-money="<field>"` so the
 * formats can be compared field by field.
 */

export interface TemplateOptions {
  /** `data:image/png|jpeg;base64,...` read by main at render time. */
  logoDataUrl: string | null;
  numberLocale?: string;
}

export function labelsFor(
  model: InvoicePrintModel,
  options?: TemplateOptions,
): PrintLabels {
  const locale = options?.numberLocale ?? 'id-ID';
  return {
    ...PRINT_LABELS[model.language],
    locale,
    decimal: numberSymbols(locale).decimal,
  };
}

/** A printed money value: `Rp 31.500`, tagged with its model field. */
export function money(
  field: string,
  value: string,
  locale = 'id-ID',
): SafeHtml {
  return html`<span class="num" data-money="${field}">${formatIdr(value, locale)}</span>`;
}

/** A deduction: the sign is outside the tagged value (none for zero). */
export function deduction(
  field: string,
  value: string,
  locale = 'id-ID',
): SafeHtml {
  const sign = BigInt(value) === 0n ? '' : '-';
  return html`<span class="neg">${sign}${money(field, value, locale)}</span>`;
}

export function percent(bps: number, labels: PrintLabels): string {
  return formatNumericText(formatBpsAsPercentage(bps), labels.locale);
}

/** `YYYY-MM-DD` -> `DD/MM/YYYY` (both languages). */
export function localDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

/** `YYYY-MM-DD HH:mm` -> `DD/MM/YYYY HH:mm`. */
export function localDateTime(value: string): string {
  const [date = '', time = ''] = value.split(' ');
  return `${localDate(date)} ${time}`;
}

export function count(value: number, labels: PrintLabels): string {
  return formatNumericText(String(value), labels.locale);
}

export function quantity(line: PrintLine, labels: PrintLabels): string {
  return line.unitLabel
    ? `${count(line.quantity, labels)} ${line.unitLabel}`
    : count(line.quantity, labels);
}

export function stageLabel(
  stage: PrintDiscountStage,
  labels: PrintLabels,
): string {
  return labels.stage(stage.sequence, percent(stage.percentageBps, labels));
}

export function invoiceStageLabel(
  stage: PrintDiscountStage,
  labels: PrintLabels,
): string {
  return labels.invoiceDiscount(
    stage.sequence,
    percent(stage.percentageBps, labels),
  );
}

/** Header facts every layout prints, in order, as [label, value] pairs. */
export function headerFacts(
  model: InvoicePrintModel,
  labels: PrintLabels,
): [string, string][] {
  const facts: [string, string][] = [
    [labels.invoiceNumber, model.invoiceNumber],
    [labels.invoiceDate, localDate(model.invoiceDate)],
    [labels.finalizedAt, localDateTime(model.finalizedAtLocal)],
    [labels.top, labels.topDays(model.topDays, count(model.topDays, labels))],
    [labels.dueDate, localDate(model.dueDate)],
    [labels.channel, model.channel],
    [labels.cashier, model.cashier],
  ];
  return facts;
}

/** Customer and vehicle facts (empty when the sale is anonymous). */
export function partyFacts(
  model: InvoicePrintModel,
  labels: PrintLabels,
): [string, string][] {
  const facts: [string, string][] = [];
  if (model.customer?.name) facts.push([labels.customer, model.customer.name]);
  if (model.customer?.phoneNumber) {
    facts.push([labels.phone, model.customer.phoneNumber]);
  }
  if (model.vehicle?.plateNumber) {
    facts.push([labels.plate, model.vehicle.plateNumber]);
  }
  if (model.vehicle?.description) {
    facts.push([labels.vehicle, model.vehicle.description]);
  }
  if (model.odometerKm !== null) {
    facts.push([labels.odometer, `${count(model.odometerKm, labels)} km`]);
  }
  return facts;
}

export function logo(options: TemplateOptions): SafeHtml {
  return options.logoDataUrl
    ? html`<img class="logo" src="${options.logoDataUrl}" alt="" />`
    : html``;
}

export function reprintBadge(
  model: InvoicePrintModel,
  labels: PrintLabels,
): SafeHtml {
  return model.isReprint
    ? html`<span class="reprint">${labels.reprint}</span>`
    : html``;
}

/** The prominent VOID marking: a watermark plus a banner with the reason. */
export function voidMarking(
  model: InvoicePrintModel,
  labels: PrintLabels,
): { watermark: SafeHtml; banner: SafeHtml } {
  if (!model.void) return { watermark: html``, banner: html`` };
  return {
    watermark: html`<div class="void-watermark" aria-hidden="true">${labels.void}</div>`,
    banner: html`<div class="void-banner">
      <div class="void-title">${labels.voidBanner}</div>
      <div>${labels.voidReason}: ${model.void.reason}</div>
      <div>${labels.voidedBy}: ${model.void.voidedBy} · ${localDateTime(model.void.voidedAtLocal)}</div>
    </div>`,
  };
}

/** Totals every layout prints, as [label, markup, emphasis] rows. */
export function totalRows(
  model: InvoicePrintModel,
  labels: PrintLabels,
): { label: string; value: SafeHtml; strong?: boolean }[] {
  return [
    {
      label: labels.subtotal,
      value: money('subtotal', model.subtotal, labels.locale),
    },
    {
      label: labels.itemDiscounts,
      value: deduction(
        'itemDiscountAmount',
        model.itemDiscountAmount,
        labels.locale,
      ),
    },
    ...model.invoiceDiscounts.map((stage) => ({
      label: invoiceStageLabel(stage, labels),
      value: deduction(
        `invoice-stage-${stage.sequence}`,
        stage.amount,
        labels.locale,
      ),
    })),
    {
      label: labels.invoiceDiscounts,
      value: deduction(
        'invoiceDiscountAmount',
        model.invoiceDiscountAmount,
        labels.locale,
      ),
    },
    {
      label: labels.discountTotal,
      value: deduction('discountAmount', model.discountAmount, labels.locale),
    },
    {
      label: labels.total,
      value: money('amount', model.amount, labels.locale),
      strong: true,
    },
  ];
}

export function settlementRows(
  model: InvoicePrintModel,
  labels: PrintLabels,
): { label: string; value: SafeHtml | string; strong?: boolean }[] {
  return [
    {
      label: labels.paid,
      value: money('paidAmount', model.paidAmount, labels.locale),
    },
    {
      label: labels.outstanding,
      value: money('outstanding', model.outstanding, labels.locale),
      strong: true,
    },
    { label: labels.paymentStatus, value: labels.status[model.paymentStatus] },
  ];
}

/** Font stacks available on Windows, macOS and Linux without downloads. */
export const SYSTEM_FONTS =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "DejaVu Sans", "Helvetica Neue", Arial, sans-serif';

/** CSS common to every layout (static; never contains data). */
export const BASE_CSS = `
.sheet { font-family: ${SYSTEM_FONTS}; color: #000; background: #fff;
  font-variant-numeric: tabular-nums; line-height: 1.3; position: relative;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet *, .sheet *::before, .sheet *::after { box-sizing: border-box; }
.sheet .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.sheet .neg { white-space: nowrap; }
.sheet .reprint { display: inline-block; border: 1.5px solid #000; padding: 0 1.5mm;
  font-weight: 700; letter-spacing: 0.04em; }
.sheet .void-banner { border: 2px solid #b00000; color: #b00000; padding: 1.5mm 2mm;
  margin: 2mm 0; font-weight: 600; overflow-wrap: anywhere; }
.sheet .void-title { font-size: 1.35em; font-weight: 800; letter-spacing: 0.05em; }
.sheet .void-watermark { position: fixed; left: 0; right: 0; top: 38%; text-align: center;
  font-weight: 900; color: rgba(176, 0, 0, 0.16); transform: rotate(-28deg);
  pointer-events: none; z-index: 10; letter-spacing: 0.1em; }
.sheet .logo { display: block; object-fit: contain; }
.sheet .wrap { overflow-wrap: anywhere; word-break: normal; hyphens: auto; }
.sheet h1, .sheet h2, .sheet p { margin: 0; }
`;

/** Wraps a layout into a complete, script-free HTML document. */
export function documentHtml(
  model: InvoicePrintModel,
  css: string,
  body: SafeHtml,
): string {
  const title = `${labelsFor(model).invoice} ${model.invoiceNumber}`;
  return documentShell({ language: model.language, title, css, body });
}

/**
 * The document every print template produces (invoices, reports): doctype,
 * a meta CSP that forbids scripts and remote loads, static CSS, and the
 * escaped body. `css` must be developer-written, never data.
 */
export function documentShell(document: {
  language: string;
  title: string;
  css: string;
  body: SafeHtml;
}): string {
  return html`<!doctype html>
<html lang="${document.language}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'" />
<title>${document.title}</title>
<style>${trusted(BASE_CSS + document.css)}</style>
</head>
<body>
${document.body}
</body>
</html>
`.value;
}
