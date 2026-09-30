import {
  CATALOG_ITEM_TYPES,
  MAX_STOCK_QUANTITY,
  type CatalogItemType,
} from '@/shared/contracts';
import { DomainError, parseRupiah } from '@/shared/primitives';
import {
  asciiLower,
  looksLikeSpreadsheetNumber,
  type ColumnMap,
  type RefChannel,
  type RefUnit,
} from './columns';
import { issueError, type Issue } from './issues';
import { unescapeFormulaGuard } from './reader';

/**
 * Row-level checks that need no catalog state: row width, required SKU,
 * formats (type, unit code, boolean, price, opening stock), lengths, and
 * duplicate SKUs/barcodes WITHIN the file. Every problem is reported with
 * its row and column; nothing stops at the first error.
 *
 * Cell values are un-guarded (one formula apostrophe removed) and trimmed.
 * An empty cell is `null`: "no change" for an existing SKU.
 */

/** Same limits as the item editor (`saveCatalogItemInputSchema`). */
export const LIMITS = { sku: 64, title: 200, description: 1000, barcode: 100 };

export interface CandidateRow {
  row: number;
  sku: string;
  title: string | null;
  description: string | null;
  type: CatalogItemType | null;
  unit: RefUnit | null;
  barcodes: { column: string; value: string }[];
  prices: { column: string; channel: RefChannel; price: bigint }[];
  openingStock: number | null;
  isActive: boolean | null;
}

/** What the preview shows for a row that failed these checks. */
export interface RowOutline {
  row: number;
  sku: string;
  title: string;
}

export interface ValidatedRows {
  /** Rows that passed every check here, in file order. */
  candidates: CandidateRow[];
  /** Every data row, in file order (for the preview list). */
  outlines: RowOutline[];
  /** Rows with at least one error. */
  invalidRows: Set<number>;
  issues: Issue[];
}

const OPENING_STOCK = /^[0-9]+$/;

export function validateRows(
  records: string[][],
  columns: ColumnMap,
  units: RefUnit[],
): ValidatedRows {
  const unitsByCode = new Map(units.map((u) => [asciiLower(u.code), u]));
  const firstRowBySku = new Map<string, number>();
  const firstRowByBarcode = new Map<string, number>();
  const result: ValidatedRows = {
    candidates: [],
    outlines: [],
    invalidRows: new Set(),
    issues: [],
  };

  records.forEach((record, offset) => {
    const row = offset + 2; // the header is row 1
    const cell = (index: number | null): string | null => {
      if (index === null || index >= record.length) return null;
      const value = unescapeFormulaGuard(record[index]!).trim();
      return value === '' ? null : value;
    };
    const sku = cell(columns.sku) ?? '';
    const title = cell(columns.title);
    result.outlines.push({ row, sku, title: title ?? '' });

    const errors: Issue[] = [];
    const fail = (
      code: string,
      column: string | null,
      params?: Record<string, string>,
    ) =>
      errors.push(
        issueError(code, { row, column, sku: sku === '' ? null : sku }, params),
      );

    if (record.length !== columns.width) {
      fail('ROW_WIDTH_MISMATCH', null, {
        expected: String(columns.width),
        actual: String(record.length),
      });
      result.issues.push(...errors);
      result.invalidRows.add(row);
      return;
    }

    const tooLong = (column: string, value: string | null, max: number) => {
      if (value !== null && value.length > max) {
        fail('VALUE_TOO_LONG', column, { max: String(max) });
      }
    };

    // sku
    if (sku === '') {
      fail('SKU_REQUIRED', 'sku');
    } else {
      tooLong('sku', sku, LIMITS.sku);
      if (looksLikeSpreadsheetNumber(sku)) {
        fail('SPREADSHEET_NUMBER_FORMAT', 'sku', { value: sku });
      }
      const key = asciiLower(sku);
      const first = firstRowBySku.get(key);
      if (first !== undefined) {
        fail('DUPLICATE_SKU_IN_FILE', 'sku', { firstRow: String(first) });
      } else {
        firstRowBySku.set(key, row);
      }
    }

    // title, type, unit
    tooLong('title', title, LIMITS.title);
    const typeText = cell(columns.type);
    let type: CatalogItemType | null = null;
    if (typeText !== null) {
      const upper = typeText.toUpperCase();
      if ((CATALOG_ITEM_TYPES as readonly string[]).includes(upper)) {
        type = upper as CatalogItemType;
      } else {
        fail('INVALID_TYPE', 'type', { value: typeText });
      }
    }
    const unitText = cell(columns.unit);
    let unit: RefUnit | null = null;
    if (unitText !== null) {
      unit = unitsByCode.get(asciiLower(unitText)) ?? null;
      if (!unit) fail('UNKNOWN_UNIT', 'unit', { value: unitText });
    }

    // barcodes (also unique across the whole file)
    const barcodes: CandidateRow['barcodes'] = [];
    for (const { index, column } of columns.barcodes) {
      const value = cell(index);
      if (value === null) continue;
      tooLong(column, value, LIMITS.barcode);
      if (looksLikeSpreadsheetNumber(value)) {
        fail('SPREADSHEET_NUMBER_FORMAT', column, { value });
        continue;
      }
      const first = firstRowByBarcode.get(value);
      if (first !== undefined) {
        fail('DUPLICATE_BARCODE_IN_FILE', column, {
          barcode: value,
          firstRow: String(first),
        });
        continue;
      }
      firstRowByBarcode.set(value, row);
      barcodes.push({ column, value });
    }

    // prices: whole rupiah >= 0; empty = no change
    const prices: CandidateRow['prices'] = [];
    for (const { index, column, channel } of columns.prices) {
      const value = cell(index);
      if (value === null) continue;
      const price = parsePrice(value);
      if (price === null) {
        fail('INVALID_PRICE', column, { value });
        continue;
      }
      prices.push({ column, channel, price });
    }

    // opening stock: integer >= 0; empty = none
    const stockText = cell(columns.openingStock);
    let openingStock: number | null = null;
    if (stockText !== null) {
      const parsed = OPENING_STOCK.test(stockText) ? Number(stockText) : NaN;
      if (!Number.isSafeInteger(parsed) || parsed > MAX_STOCK_QUANTITY) {
        fail('INVALID_OPENING_STOCK', 'opening_stock', { value: stockText });
      } else {
        openingStock = parsed;
      }
    }

    // is_active: true | false; empty = no change (new items: true)
    const activeText = cell(columns.isActive);
    let isActive: boolean | null = null;
    if (activeText !== null) {
      const lower = activeText.toLowerCase();
      if (lower === 'true') isActive = true;
      else if (lower === 'false') isActive = false;
      else fail('INVALID_BOOLEAN', 'is_active', { value: activeText });
    }

    const description = cell(columns.description);
    tooLong('description', description, LIMITS.description);

    if (errors.length > 0) {
      result.issues.push(...errors);
      result.invalidRows.add(row);
      return;
    }
    result.candidates.push({
      row,
      sku,
      title,
      description,
      type,
      unit,
      barcodes,
      prices,
      openingStock,
      isActive,
    });
  });
  return result;
}

function parsePrice(text: string): bigint | null {
  try {
    const price = parseRupiah(text);
    return price >= 0n ? price : null;
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}
