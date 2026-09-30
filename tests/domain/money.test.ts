import { describe, expect, test } from 'vitest';
import { DomainError, formatRupiah, parseRupiah } from '@/shared/primitives';

describe('parseRupiah', () => {
  test('parses integers', () => {
    expect(parseRupiah('0')).toBe(0n);
    expect(parseRupiah('125000')).toBe(125000n);
    expect(parseRupiah('-5')).toBe(-5n);
    expect(parseRupiah('9223372036854775807')).toBe(9223372036854775807n);
    expect(parseRupiah('-9223372036854775808')).toBe(-9223372036854775808n);
  });
  test.each([
    '',
    ' ',
    '1.5',
    '1,5',
    '1e3',
    '+5',
    '--5',
    '-',
    'abc',
    '1 000',
    '0x10',
    '007',
    '-0',
  ])('rejects %j', (v) => {
    expect(() => parseRupiah(v)).toThrow(DomainError);
  });
  test('rejects out of range', () => {
    expect(() => parseRupiah('9223372036854775808')).toThrowError(
      expect.objectContaining({ code: 'MONEY_OVERFLOW' }),
    );
    expect(() => parseRupiah('-9223372036854775809')).toThrowError(
      expect.objectContaining({ code: 'MONEY_OVERFLOW' }),
    );
  });
  test('rejects non-strings', () => {
    expect(() => parseRupiah(5 as unknown as string)).toThrow(DomainError);
  });
});

describe('formatRupiah', () => {
  test('formats bigint', () => {
    expect(formatRupiah(31500n)).toBe('31500');
    expect(formatRupiah(-1n)).toBe('-1');
  });
  test('range checks', () => {
    expect(() => formatRupiah(9223372036854775808n)).toThrowError(
      expect.objectContaining({ code: 'MONEY_OVERFLOW' }),
    );
    expect(formatRupiah(9223372036854775807n)).toBe('9223372036854775807');
  });
});
