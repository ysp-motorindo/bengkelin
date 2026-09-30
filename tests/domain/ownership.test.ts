import { describe, expect, test } from 'vitest';
import { detectOwnerMismatch } from '@/shared/ownership';

describe('detectOwnerMismatch', () => {
  test('warns only when a selected customer differs from a known active owner', () => {
    expect(detectOwnerMismatch('owner', 'other')).toBe(true);
    expect(detectOwnerMismatch('owner', 'owner')).toBe(false);
  });

  test('no warning for anonymous checkout or an unowned vehicle', () => {
    expect(detectOwnerMismatch('owner', null)).toBe(false);
    expect(detectOwnerMismatch(null, 'customer')).toBe(false);
    expect(detectOwnerMismatch(null, null)).toBe(false);
  });
});
