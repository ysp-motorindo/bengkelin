/**
 * The one CSV writer (reports now, catalog export in T15). Output is what
 * spreadsheet programs open safely and unambiguously:
 *
 *  - UTF-8 with a BOM (Excel otherwise guesses a legacy code page), CRLF
 *    record separators, comma field separators;
 *  - RFC 4180 quoting: a field containing `"`, `,`, CR or LF is wrapped in
 *    double quotes and its quotes are doubled;
 *  - formula safety (CSV/formula injection): a TEXT cell that starts with
 *    `=`, `+`, `-`, `@`, TAB or CR gets a leading apostrophe, so a spreadsheet
 *    shows it as text instead of evaluating it. This applies to every text
 *    value, including names, reasons and labels;
 *  - integers (money as Rupiah strings, counts) are declared with
 *    `csvInteger` and written as plain digit strings so they stay numeric.
 *    A NEGATIVE integer would start with `-`, so it is written as guarded
 *    TEXT (`'-250000`): readable, never a formula, but not a live number.
 *
 * Pure and synchronous; callers write the string with `fs.writeFile(path,
 * text, 'utf8')`. Reading CSV (imports) is a separate concern.
 */

const INTEGER = /^(0|-?[1-9]\d*)$/;
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** A cell that holds a whole number (money or a count). */
export class CsvInteger {
  readonly digits: string;
  constructor(value: bigint | number | string) {
    const text =
      typeof value === 'bigint'
        ? value.toString()
        : typeof value === 'number'
          ? Number.isSafeInteger(value)
            ? String(value)
            : ''
          : value;
    if (!INTEGER.test(text)) {
      throw new TypeError(`Not a canonical integer: ${String(value)}`);
    }
    this.digits = text;
  }
}

export function csvInteger(value: bigint | number | string): CsvInteger {
  return new CsvInteger(value);
}

/** Text, an integer, or empty (`null`/`undefined`/`''`). */
export type CsvCell = string | CsvInteger | null | undefined;
export type CsvRow = readonly CsvCell[];

/** Neutralizes a text value a spreadsheet could evaluate as a formula. */
export function guardFormula(text: string): string {
  return FORMULA_TRIGGER.test(text) ? `'${text}` : text;
}

function quote(text: string): string {
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One field as it appears in the file (guarded and quoted). */
export function formatCsvCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof CsvInteger) {
    // Non-negative integers are plain digits; negatives become guarded text.
    return cell.digits.startsWith('-') ? quote(`'${cell.digits}`) : cell.digits;
  }
  return quote(guardFormula(cell));
}

export const CSV_BOM = '﻿';
export const CSV_EOL = '\r\n';

/**
 * The whole file: BOM, then every row terminated by CRLF (an empty row is
 * an empty line, used to separate sections).
 */
export function formatCsv(rows: readonly CsvRow[]): string {
  return (
    CSV_BOM +
    rows.map((row) => row.map(formatCsvCell).join(',') + CSV_EOL).join('')
  );
}
