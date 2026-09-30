import type { PrintFormat } from '@/shared/contracts';

/**
 * Page sizes for Electron's two printing APIs, which use DIFFERENT units:
 * `webContents.print({ pageSize: { width, height } })` takes MICRONS, while
 * `webContents.printToPDF({ pageSize: { width, height } })` takes INCHES.
 * Thermal paper is a continuous roll: the width is the paper, the height is
 * measured from the rendered content. Pure (no Electron import).
 */

export const THERMAL_PAGE_MICRONS = {
  THERMAL_58: 58_000,
  THERMAL_80: 80_000,
} as const;

const MICRONS_PER_INCH = 25_400;
/** Chromium refuses tiny pages; a receipt is never shorter than 10 mm. */
const MIN_HEIGHT_MICRONS = 10_000;

type ThermalFormat = keyof typeof THERMAL_PAGE_MICRONS;

function thermalHeight(heightMicrons: number): number {
  return Math.max(MIN_HEIGHT_MICRONS, Math.ceil(heightMicrons));
}

export interface PrintPageOptions {
  pageSize: 'A4' | { width: number; height: number };
  margins: { marginType: 'default' | 'none' };
  printBackground: boolean;
}

export function printOptionsFor(
  format: PrintFormat,
  heightMicrons: number,
): PrintPageOptions {
  if (format === 'A4') {
    // The template's @page rule sets the margins and the page numbers.
    return {
      pageSize: 'A4',
      margins: { marginType: 'default' },
      printBackground: true,
    };
  }
  return {
    pageSize: {
      width: THERMAL_PAGE_MICRONS[format as ThermalFormat],
      height: thermalHeight(heightMicrons),
    },
    margins: { marginType: 'none' },
    printBackground: true,
  };
}

export interface PdfPageOptions {
  pageSize: 'A4' | { width: number; height: number };
  preferCSSPageSize: boolean;
  printBackground: boolean;
  margins: { top: number; bottom: number; left: number; right: number };
}

export function pdfOptionsFor(
  format: PrintFormat,
  heightMicrons: number,
): PdfPageOptions {
  const none = { top: 0, bottom: 0, left: 0, right: 0 };
  if (format === 'A4') {
    return {
      pageSize: 'A4',
      preferCSSPageSize: true,
      printBackground: true,
      margins: none,
    };
  }
  return {
    pageSize: {
      width: THERMAL_PAGE_MICRONS[format as ThermalFormat] / MICRONS_PER_INCH,
      height: thermalHeight(heightMicrons) / MICRONS_PER_INCH,
    },
    preferCSSPageSize: false,
    printBackground: true,
    margins: none,
  };
}
