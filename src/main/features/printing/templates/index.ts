import type {
  InvoicePrintModel,
  PrintFormat,
  PrintPageInfo,
} from '@/shared/contracts';
import { A4_PRINTABLE_WIDTH_MM, renderA4 } from './a4';
import type { TemplateOptions } from './shared';
import { renderThermal58, THERMAL_58_PRINTABLE_MM } from './thermal-58';
import { renderThermal80, THERMAL_80_PRINTABLE_MM } from './thermal-80';

export type { TemplateOptions } from './shared';

type Template = (model: InvoicePrintModel, options: TemplateOptions) => string;

const TEMPLATES: Record<PrintFormat, Template> = {
  A4: renderA4,
  THERMAL_58: renderThermal58,
  THERMAL_80: renderThermal80,
};

const PAGES: Record<PrintFormat, PrintPageInfo> = {
  A4: {
    format: 'A4',
    widthMm: 210,
    heightMm: 297,
    printableWidthMm: A4_PRINTABLE_WIDTH_MM,
    paginated: true,
  },
  THERMAL_58: {
    format: 'THERMAL_58',
    widthMm: 58,
    heightMm: null,
    printableWidthMm: THERMAL_58_PRINTABLE_MM,
    paginated: false,
  },
  THERMAL_80: {
    format: 'THERMAL_80',
    widthMm: 80,
    heightMm: null,
    printableWidthMm: THERMAL_80_PRINTABLE_MM,
    paginated: false,
  },
};

/** One HTML document per (model, format): preview, print and PDF share it. */
export function renderInvoiceHtml(
  model: InvoicePrintModel,
  format: PrintFormat,
  options: TemplateOptions,
): string {
  return TEMPLATES[format](model, options);
}

export function pageInfoFor(format: PrintFormat): PrintPageInfo {
  return { ...PAGES[format] };
}
