import { describe, expect, test } from 'vitest';
import { DomainError } from '@/shared/primitives';
import {
  formatBpsAsPercentage,
  parsePercentageToBps,
} from '@/shared/percentage';

describe('parsePercentageToBps (string-based, no floats)', () => {
  test.each([
    ['2.75', 275],
    ['2,75', 275],
    ['0', 0],
    ['0.01', 1],
    ['10', 1000],
    ['12.5', 1250],
    ['33.33', 3333],
    ['99.99', 9999],
    ['100', 10000],
    ['100.00', 10000],
    [' 7.5 ', 750],
    ['007', 700],
    ['0.1', 10],
  ])('%s -> %i bps', (input, bps) => {
    expect(parsePercentageToBps(input)).toBe(bps);
  });

  test('values a float parser would get wrong are exact', () => {
    // 0.1 + 0.2 style drift: 1.15 * 100 = 114.99999999999999 in floats.
    expect(parsePercentageToBps('1.15')).toBe(115);
    expect(parsePercentageToBps('4.35')).toBe(435);
    expect(parsePercentageToBps('0.29')).toBe(29);
  });

  test.each([
    '',
    ' ',
    '-1',
    '+5',
    '100.01',
    '101',
    '2.755',
    '.5',
    '5.',
    '1e2',
    'abc',
    '1,000.5',
    '1.2.3',
    'NaN',
    'Infinity',
    '5%',
  ])('rejects %j with INVALID_PERCENTAGE', (input) => {
    expect(() => parsePercentageToBps(input)).toThrow(DomainError);
    try {
      parsePercentageToBps(input);
    } catch (error) {
      expect((error as DomainError).code).toBe('INVALID_PERCENTAGE');
    }
  });
});

describe('formatBpsAsPercentage', () => {
  test.each([
    [275, '.', '2.75'],
    [275, ',', '2,75'],
    [1250, ',', '12,5'],
    [1000, '.', '10'],
    [1, '.', '0.01'],
    [10, ',', '0,1'],
    [0, '.', '0'],
    [10000, '.', '100'],
  ] as const)('%i bps with %j -> %s', (bps, separator, text) => {
    expect(formatBpsAsPercentage(bps, separator)).toBe(text);
  });

  test('round-trips every stage value', () => {
    for (let bps = 0; bps <= 10000; bps += 7) {
      expect(parsePercentageToBps(formatBpsAsPercentage(bps, ','))).toBe(bps);
    }
  });

  test('rejects out-of-range or fractional bps', () => {
    expect(() => formatBpsAsPercentage(-1)).toThrow(DomainError);
    expect(() => formatBpsAsPercentage(10001)).toThrow(DomainError);
    expect(() => formatBpsAsPercentage(1.5)).toThrow(DomainError);
  });
});
