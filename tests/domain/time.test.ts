import { describe, expect, test } from 'vitest';
import {
  businessDay,
  businessDayRange,
  isInstant,
  resolveLocalDateTime,
  toInstant,
} from '@/shared/time';

describe('instants', () => {
  test('canonical form', () => {
    expect(toInstant(new Date('2026-09-30T07:00:00Z'))).toBe(
      '2026-09-30T07:00:00.000Z',
    );
    expect(toInstant(0)).toBe('1970-01-01T00:00:00.000Z');
  });
  test('isInstant', () => {
    expect(isInstant('2026-09-30T07:00:00.000Z')).toBe(true);
    expect(isInstant('2026-09-30T07:00:00Z')).toBe(false);
    expect(isInstant('2026-09-30T14:00:00.000+07:00')).toBe(false);
    expect(isInstant('2026-02-30T07:00:00.000Z')).toBe(false);
    expect(isInstant('nope')).toBe(false);
  });
  test('lexicographic order equals chronological', () => {
    const a = toInstant(Date.UTC(2026, 0, 1, 0, 0, 0, 5));
    const b = toInstant(Date.UTC(2026, 0, 1, 0, 0, 0, 50));
    const c = toInstant(Date.UTC(2026, 0, 1, 0, 0, 1, 0));
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });
  test('rejects invalid dates', () => {
    expect(() => toInstant(NaN)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INSTANT' }),
    );
    expect(() => toInstant(Date.UTC(10000, 0, 1))).toThrowError(
      expect.objectContaining({ code: 'INVALID_INSTANT' }),
    );
  });
});

describe('businessDay', () => {
  test('Jakarta midnight boundary', () => {
    expect(businessDay('2026-09-30T16:59:59.999Z', 'Asia/Jakarta')).toBe(
      '2026-09-30',
    );
    expect(businessDay('2026-09-30T17:00:00.000Z', 'Asia/Jakarta')).toBe(
      '2026-10-01',
    );
  });
  test('other zone', () => {
    expect(businessDay('2026-09-30T03:59:59.999Z', 'America/New_York')).toBe(
      '2026-09-29',
    );
    expect(businessDay('2026-09-30T04:00:00.000Z', 'America/New_York')).toBe(
      '2026-09-30',
    );
  });
});

describe('resolveLocalDateTime', () => {
  test('Jakarta is unambiguous', () => {
    expect(resolveLocalDateTime('2026-09-30T14:00', 'Asia/Jakarta')).toEqual({
      kind: 'ok',
      instant: '2026-09-30T07:00:00.000Z',
    });
    expect(resolveLocalDateTime('2026-09-30T14:00:30', 'Asia/Jakarta')).toEqual(
      {
        kind: 'ok',
        instant: '2026-09-30T07:00:30.000Z',
      },
    );
  });
  test('normal New York time', () => {
    expect(
      resolveLocalDateTime('2026-07-01T12:00', 'America/New_York'),
    ).toEqual({
      kind: 'ok',
      instant: '2026-07-01T16:00:00.000Z',
    });
  });
  test('ambiguous fall-back time', () => {
    expect(
      resolveLocalDateTime('2026-11-01T01:30', 'America/New_York'),
    ).toEqual({
      kind: 'ambiguous',
      candidates: ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'],
    });
  });
  test('explicit offset choice resolves ambiguity', () => {
    expect(
      resolveLocalDateTime('2026-11-01T01:30', 'America/New_York', 'earlier'),
    ).toEqual({
      kind: 'ok',
      instant: '2026-11-01T05:30:00.000Z',
    });
    expect(
      resolveLocalDateTime('2026-11-01T01:30', 'America/New_York', 'later'),
    ).toEqual({
      kind: 'ok',
      instant: '2026-11-01T06:30:00.000Z',
    });
  });
  test('nonexistent spring-forward time', () => {
    expect(
      resolveLocalDateTime('2026-03-08T02:30', 'America/New_York'),
    ).toEqual({
      kind: 'nonexistent',
    });
    expect(
      resolveLocalDateTime('2026-03-08T02:30', 'America/New_York', 'later'),
    ).toEqual({
      kind: 'nonexistent',
    });
  });
  test('rejects malformed input with typed codes', () => {
    const bad = expect.objectContaining({ code: 'INVALID_LOCAL_DATE_TIME' });
    expect(() =>
      resolveLocalDateTime('2026-09-30 14:00', 'Asia/Jakarta'),
    ).toThrowError(bad);
    expect(() =>
      resolveLocalDateTime('2026-02-30T14:00', 'Asia/Jakarta'),
    ).toThrowError(bad);
    expect(() =>
      resolveLocalDateTime('2026-09-30T25:00', 'Asia/Jakarta'),
    ).toThrowError(bad);
  });
  test('rejects invalid timezone', () => {
    const bad = expect.objectContaining({ code: 'INVALID_TIMEZONE' });
    expect(() =>
      resolveLocalDateTime('2026-09-30T14:00', 'Mars/Base'),
    ).toThrowError(bad);
    expect(() =>
      businessDay('2026-09-30T14:00:00.000Z', 'Mars/Base'),
    ).toThrowError(bad);
  });
  test('businessDay rejects invalid instant', () => {
    expect(() => businessDay('garbage', 'Asia/Jakarta')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INSTANT' }),
    );
  });
});

describe('businessDayRange', () => {
  test('WIB day is [17:00Z previous day, 17:00Z)', () => {
    expect(businessDayRange('2026-09-30', 'Asia/Jakarta')).toEqual({
      start: '2026-09-29T17:00:00.000Z',
      end: '2026-09-30T17:00:00.000Z',
    });
  });

  test('is the inverse of businessDay at both edges', () => {
    const { start, end } = businessDayRange('2026-09-30', 'Asia/Makassar');
    expect(businessDay(start, 'Asia/Makassar')).toBe('2026-09-30');
    const last = new Date(Date.parse(end) - 1).toISOString();
    expect(businessDay(last, 'Asia/Makassar')).toBe('2026-09-30');
    expect(businessDay(end, 'Asia/Makassar')).toBe('2026-10-01');
  });

  test('DST days are 23 and 25 hours long', () => {
    const spring = businessDayRange('2026-03-08', 'America/New_York');
    expect(Date.parse(spring.end) - Date.parse(spring.start)).toBe(
      23 * 3600_000,
    );
    const fall = businessDayRange('2026-11-01', 'America/New_York');
    expect(Date.parse(fall.end) - Date.parse(fall.start)).toBe(25 * 3600_000);
  });

  test('rejects impossible dates and zones with typed errors', () => {
    for (const bad of ['2026-02-30', '20260930', '2026-9-30', '']) {
      expect(() => businessDayRange(bad, 'Asia/Jakarta')).toThrow(
        expect.objectContaining({ code: 'INVALID_DATE' }),
      );
    }
    expect(() => businessDayRange('2026-09-30', 'Mars/Base')).toThrow(
      expect.objectContaining({ code: 'INVALID_TIMEZONE' }),
    );
  });
});
