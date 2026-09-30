import { describe, expect, test } from 'vitest';
import {
  businessDay,
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
    expect(() => toInstant(NaN)).toThrow();
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
  test('rejects malformed input', () => {
    expect(() =>
      resolveLocalDateTime('2026-09-30 14:00', 'Asia/Jakarta'),
    ).toThrow();
    expect(() =>
      resolveLocalDateTime('2026-02-30T14:00', 'Asia/Jakarta'),
    ).toThrow();
    expect(() =>
      resolveLocalDateTime('2026-09-30T25:00', 'Asia/Jakarta'),
    ).toThrow();
  });
});
