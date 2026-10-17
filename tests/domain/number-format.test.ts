import { describe, expect, test } from 'vitest';
import {
  formatNumericText,
  parseNumericText,
  resolveNumberLocale,
} from '@/shared/number-format';

describe('number formatting', () => {
  test('resolves the preference independently of interface language', () => {
    expect(resolveNumberLocale('ID', 'en-US')).toBe('id-ID');
    expect(resolveNumberLocale('US', 'id-ID')).toBe('en-US');
    expect(resolveNumberLocale('SYSTEM', 'de-DE')).toBe('de-DE');
    expect(resolveNumberLocale('SYSTEM', 'invalid_locale')).toBe('id-ID');
  });
  test.each([
    ['id-ID', '1.234.567,50'],
    ['en-US', '1,234,567.50'],
    ['hi-IN', '12,34,567.50'],
    ['fr-FR', '1\u202f234\u202f567,50'],
  ])('formats exact strings with %s', (locale, expected) => {
    expect(formatNumericText('1234567.50', locale)).toBe(expected);
  });
  test('preserves large amounts and temporary editing values', () => {
    expect(formatNumericText('9223372036854775807', 'id-ID')).toBe(
      '9.223.372.036.854.775.807',
    );
    expect(formatNumericText('-1234.', 'id-ID')).toBe('-1.234,');
    expect(formatNumericText('', 'id-ID')).toBe('');
    expect(formatNumericText('-', 'id-ID')).toBe('-');
    expect(formatNumericText('0.00', 'id-ID')).toBe('0,00');
    expect(formatNumericText('1234', 'es-ES')).toBe('1234');
  });
  test('parses the chosen locale without losing precision', () => {
    expect(parseNumericText('1.234,50', 'id-ID', { decimal: true }, true)).toBe(
      '1234.50',
    );
    expect(parseNumericText('1,234.50', 'en-US', { decimal: true }, true)).toBe(
      '1234.50',
    );
    expect(parseNumericText('-1.234', 'id-ID', { negative: true }, true)).toBe(
      '-1234',
    );
    expect(
      parseNumericText('9,223,372,036,854,775,807', 'en-US', {}, true),
    ).toBe('9223372036854775807');
  });
  test.each(['1e5', '1E5', 'abc', '+5', '--1', '0x10', '12,34', '1.2'])(
    'rejects invalid whole-number paste %s',
    (text) => {
      expect(parseNumericText(text, 'en-US', {}, true)).toBeNull();
    },
  );
  test('permits editing existing grouping and decimal partials', () => {
    expect(parseNumericText('1,2345', 'en-US')).toBe('12345');
    expect(parseNumericText('12,', 'id-ID', { decimal: true })).toBe('12.');
    expect(parseNumericText('1,2,3', 'id-ID', { decimal: true })).toBeNull();
  });
});
