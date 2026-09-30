/**
 * A strict RFC 4180 reader for assertions on exported files: quoted fields,
 * doubled quotes, CRLF records. A leading UTF-8 BOM is removed. Throws on a
 * bare LF or CR outside quotes (the writer must always emit CRLF) and on
 * characters after a closing quote.
 */
export function parseCsv(text: string): string[][] {
  const input = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let afterQuote = false;
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
      row.push(field);
      field = '';
      afterQuote = false;
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (input[i + 1] !== '\n') throw new Error(`Bare CR at ${i}`);
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      afterQuote = false;
      i += 2;
      continue;
    }
    if (ch === '\n') throw new Error(`Bare LF at ${i}`);
    if (afterQuote) throw new Error(`Text after closing quote at ${i}`);
    if (ch === '"') {
      if (field !== '') throw new Error(`Quote inside unquoted field at ${i}`);
      quoted = true;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (quoted) throw new Error('Unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
