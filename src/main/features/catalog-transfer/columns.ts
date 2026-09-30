import { issueError, issueWarning, type Issue } from './issues';

/**
 * The CSV column contract (header row -> column positions).
 *
 *   sku (required), title, type, unit, barcode, barcode_2, barcode_3, ...,
 *   price_<lowercased channel code> (one per channel), opening_stock,
 *   is_active, description; current_stock (export only, ignored on import).
 *
 * Header names are trimmed and matched case-insensitively. A name must not
 * repeat. Anything else is UNKNOWN_COLUMN; a `price_*` column for a channel
 * that does not exist is UNKNOWN_CHANNEL (channels are never created by an
 * import). A price column for an INACTIVE channel is only a warning: the
 * price still applies, so the item is priced if the channel is re-activated.
 *
 * Spreadsheet damage: a header that is ONE cell containing `;` is
 * WRONG_DELIMITER (the file was saved with a regional list separator, not
 * as comma-separated CSV); `looksLikeSpreadsheetNumber` finds barcode/SKU
 * cells that a spreadsheet turned into scientific notation.
 */

export interface RefUnit {
  id: string;
  code: string;
  isActive: boolean;
}

export interface RefChannel {
  id: string;
  code: string;
  isActive: boolean;
}

export interface PriceColumn {
  index: number;
  column: string;
  channel: RefChannel;
}

export interface BarcodeColumn {
  index: number;
  column: string;
}

export interface ColumnMap {
  width: number;
  sku: number | null;
  title: number | null;
  type: number | null;
  unit: number | null;
  openingStock: number | null;
  isActive: number | null;
  description: number | null;
  currentStock: number | null;
  /** In order: barcode, barcode_2, ... */
  barcodes: BarcodeColumn[];
  /** In header order. */
  prices: PriceColumn[];
}

const FIXED = {
  sku: 'sku',
  title: 'title',
  type: 'type',
  unit: 'unit',
  opening_stock: 'openingStock',
  is_active: 'isActive',
  description: 'description',
  current_stock: 'currentStock',
} as const;

const BARCODE = /^barcode(?:_([1-9][0-9]*))?$/;
/** e.g. `8.99123E+12`: a long number reformatted by a spreadsheet. */
const SPREADSHEET_NUMBER = /^\d+(\.\d+)?e\+?\d+$/i;

/** True for a barcode/SKU cell a spreadsheet turned into scientific notation. */
export function looksLikeSpreadsheetNumber(value: string): boolean {
  return SPREADSHEET_NUMBER.test(value);
}
const PRICE = /^price_(.+)$/;

/** ASCII-only lower case, matching SQLite's NOCASE collation. */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** The price column name for a channel code. */
export function priceColumnName(channelCode: string): string {
  return `price_${asciiLower(channelCode)}`;
}

/** The n-th barcode column name (1-based): barcode, barcode_2, ... */
export function barcodeColumnName(n: number): string {
  return n === 1 ? 'barcode' : `barcode_${n}`;
}

export function mapHeader(
  header: string[],
  channels: RefChannel[],
): { columns: ColumnMap; issues: Issue[] } {
  const issues: Issue[] = [];
  const columns: ColumnMap = {
    width: header.length,
    sku: null,
    title: null,
    type: null,
    unit: null,
    openingStock: null,
    isActive: null,
    description: null,
    currentStock: null,
    barcodes: [],
    prices: [],
  };
  const byPriceColumn = new Map(
    channels.map((channel) => [priceColumnName(channel.code), channel]),
  );
  const seen = new Set<string>();
  const barcodeNumbers = new Map<number, BarcodeColumn>();

  // `sku;title;...` read as one column: a semicolon-separated file.
  if (header.length === 1 && header[0]!.includes(';')) {
    issues.push(issueError('WRONG_DELIMITER', { row: 1, column: null }));
    return { columns, issues };
  }

  header.forEach((raw, index) => {
    const name = asciiLower(raw.trim());
    const at = { row: 1, column: name };
    if (seen.has(name)) {
      issues.push(issueError('DUPLICATE_COLUMN', at, { column: name }));
      return;
    }
    seen.add(name);

    if (Object.hasOwn(FIXED, name)) {
      const key = FIXED[name as keyof typeof FIXED];
      columns[key] = index;
      if (key === 'currentStock') {
        issues.push(issueWarning('CURRENT_STOCK_IGNORED', at));
      }
      return;
    }
    const barcode = BARCODE.exec(name);
    if (barcode && barcode[1] !== '1') {
      const n = barcode[1] === undefined ? 1 : Number(barcode[1]);
      barcodeNumbers.set(n, { index, column: name });
      return;
    }
    if (PRICE.test(name)) {
      const channel = byPriceColumn.get(name);
      if (!channel) {
        issues.push(issueError('UNKNOWN_CHANNEL', at, { column: name }));
        return;
      }
      if (!channel.isActive) {
        issues.push(
          issueWarning('INACTIVE_CHANNEL', at, { channel: channel.code }),
        );
      }
      columns.prices.push({ index, column: name, channel });
      return;
    }
    issues.push(issueError('UNKNOWN_COLUMN', at, { column: name }));
  });

  // barcode, barcode_2, barcode_3, ... must be contiguous.
  for (const n of [...barcodeNumbers.keys()].sort((a, b) => a - b)) {
    const entry = barcodeNumbers.get(n)!;
    const expected = columns.barcodes.length + 1;
    if (n !== expected) {
      issues.push(
        issueError(
          'BARCODE_COLUMN_GAP',
          { row: 1, column: entry.column },
          { column: entry.column, missing: barcodeColumnName(expected) },
        ),
      );
      continue;
    }
    columns.barcodes.push(entry);
  }

  if (columns.sku === null) {
    issues.push(
      issueError(
        'MISSING_COLUMN',
        { row: 1, column: 'sku' },
        { column: 'sku' },
      ),
    );
  }
  return { columns, issues };
}
