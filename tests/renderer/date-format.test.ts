import { describe, expect, test } from 'vitest';
import {
  formatDisplayDate,
  formatDisplayDateTime,
  toLocalInputValue,
} from '@/renderer/lib/date-format';
import { formatDueDate } from '@/renderer/features/workspace/format-due-date';

describe('date presentation', () => {
  test('preserves calendar days, including leap days, without timezone conversion', () => {
    expect(formatDisplayDate('2024-02-29')).toBe('29/02/2024');
    expect(formatDisplayDate('2026-01-01')).toBe('01/01/2026');
    expect(formatDueDate('2024-02-29', 'en')).toBe('Thu, 29/02/2024');
    expect(formatDueDate('2024-02-29', 'id')).toBe('Kam, 29/02/2024');
  });

  test('uses the shop day at midnight while preserving ISO datetime input values', () => {
    const instant = '2026-09-30T17:30:00.000Z';
    expect(formatDisplayDateTime(instant, 'Asia/Jakarta')).toBe(
      '01/10/2026 00:30:00',
    );
    expect(formatDisplayDateTime(instant, 'UTC')).toBe('30/09/2026 17:30:00');
    expect(toLocalInputValue(instant, 'Asia/Jakarta')).toBe(
      '2026-10-01T00:30:00',
    );
  });
});
