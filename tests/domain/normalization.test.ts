import { describe, expect, test } from 'vitest';
import {
  normalizePhone,
  normalizePlate,
} from '@/main/features/vehicles/normalization';

describe('normalizePlate', () => {
  test('variants collapse', () => {
    for (const v of [
      'B 1234 XYZ',
      'B1234XYZ',
      'B-1234-XYZ',
      'b-1234-xyz',
      ' b.1234 xyz ',
    ]) {
      expect(normalizePlate(v)).toBe('B1234XYZ');
    }
  });
  test('empty', () => {
    expect(normalizePlate('  - ')).toBe('');
  });
});

describe('normalizePhone', () => {
  test('Indonesian forms converge', () => {
    expect(normalizePhone('0812-3456-7890')).toBe('6281234567890');
    expect(normalizePhone('6281234567890')).toBe('6281234567890');
    expect(normalizePhone('+62 812 3456 7890')).toBe('6281234567890');
    expect(normalizePhone('(0812) 3456.7890')).toBe('6281234567890');
  });
  test('other forms are digits only', () => {
    expect(normalizePhone('+1 (555) 010-9999')).toBe('15550109999');
    expect(normalizePhone('812345')).toBe('812345');
    expect(normalizePhone('021-555')).toBe('6221555');
  });
  test('empty', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(' - ')).toBe('');
    expect(normalizePhone('+')).toBe('');
  });
  test('plus only counts when leading', () => {
    expect(normalizePhone('0812+3456')).toBe('628123456');
  });
});
