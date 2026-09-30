/**
 * Strict RFC 4180 reader for catalog imports (the counterpart of
 * `features/csv/writer.ts`). Pure: bytes in, records out.
 *
 *  - UTF-8 only, with an optional BOM. Invalid UTF-8 is INVALID_ENCODING,
 *    never a silent replacement character.
 *  - Records end with CRLF or LF. A bare CR outside quotes is malformed.
 *  - Quoted fields may contain commas, doubled quotes and line breaks, which
 *    are kept exactly as written.
 *  - A quote inside an unquoted field, text after a closing quote, or an
 *    unterminated quote is MALFORMED_CSV with the record number.
 *  - Every value stays TEXT: nothing is trimmed or converted here, so SKUs
 *    and barcodes keep their leading zeros.
 *  - Blank lines at the END of the file are ignored. A blank line elsewhere
 *    is a record with one empty field (the width check reports it).
 *
 * Record numbers are 1-based and count records, not physical lines (a quoted
 * line break does not start a new record). The header is record 1.
 */

export type ReadErrorCode = 'INVALID_ENCODING' | 'MALFORMED_CSV';

export type ReadResult =
  | { ok: true; records: string[][] }
  | { ok: false; code: ReadErrorCode; row: number | null };

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function readCsv(bytes: Uint8Array): ReadResult {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { ok: false, code: 'INVALID_ENCODING', row: null };
  }
  if (text.startsWith('﻿')) text = text.slice(1);
  return parseRecords(text);
}

function parseRecords(input: string): ReadResult {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  const malformed = (): ReadResult => ({
    ok: false,
    code: 'MALFORMED_CSV',
    row: records.length + 1,
  });
  const endRecord = () => {
    record.push(field);
    records.push(record);
    record = [];
    field = '';
    afterQuote = false;
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        afterQuote = true;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === ',') {
      record.push(field);
      field = '';
      afterQuote = false;
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (input[i + 1] !== '\n') return malformed();
      endRecord();
      i += 2;
      continue;
    }
    if (ch === '\n') {
      endRecord();
      i += 1;
      continue;
    }
    if (afterQuote) return malformed();
    if (ch === '"') {
      if (field !== '') return malformed();
      quoted = true;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (quoted) return malformed();
  if (field !== '' || record.length > 0 || afterQuote) endRecord();

  // Blank trailing lines (records holding one empty field) are ignored.
  while (records.length > 0) {
    const last = records[records.length - 1]!;
    if (last.length === 1 && last[0] === '') records.pop();
    else break;
  }
  return { ok: true, records };
}

const FORMULA_GUARDED = /^'[=+\-@\t\r]/;

/**
 * Undoes the writer's formula guard: exactly ONE leading apostrophe followed
 * by `=`, `+`, `-`, `@`, TAB or CR is removed, so an exported file imports
 * back to the same values. Any other apostrophe is kept.
 */
export function unescapeFormulaGuard(value: string): string {
  return FORMULA_GUARDED.test(value) ? value.slice(1) : value;
}
