import { describe, expect, test } from 'vitest';
import {
  formatIdr,
  formatLocal,
  toLocalInputValue,
} from '@/renderer/features/catalog/local-time';

describe('catalog local time helpers', () => {
  test('shows an instant as shop-local wall-clock time', () => {
    expect(formatLocal('2026-03-10T07:00:00.000Z', 'Asia/Jakarta')).toBe(
      '2026-03-10 14:00:00',
    );
    expect(toLocalInputValue('2026-03-10T16:59:59.000Z', 'Asia/Jakarta')).toBe(
      '2026-03-10T23:59:59',
    );
    expect(formatLocal('2026-03-10T07:00:00.000Z', 'Asia/Jayapura')).toBe(
      '2026-03-10 16:00:00',
    );
  });

  test('formats rupiah from the decimal string without Number precision loss', () => {
    expect(formatIdr('65000')).toBe('Rp 65.000');
    expect(formatIdr('0')).toBe('Rp 0');
    expect(formatIdr('9007199254740993')).toBe('Rp 9.007.199.254.740.993');
  });
});
