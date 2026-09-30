import { describe, expect, test } from 'vitest';
import {
  canMergeScannedLine,
  selectEffectivePrice,
} from '@/main/features/catalog/domain';

const p = (
  id: string,
  start: string,
  price: bigint,
  sup: string | null = null,
) => ({
  id,
  effectiveStartAt: start,
  supersededAt: sup,
  price,
});

describe('selectEffectivePrice', () => {
  const points = [
    p('a', '2026-01-01T00:00:00.000Z', 100n),
    p('b', '2026-06-01T00:00:00.000Z', 200n),
    p('c', '2026-09-01T00:00:00.000Z', 300n),
  ];
  test('before first is null', () => {
    expect(selectEffectivePrice(points, '2025-12-31T23:59:59.999Z')).toBeNull();
    expect(selectEffectivePrice([], '2026-01-01T00:00:00.000Z')).toBeNull();
  });
  test('effective exactly at start', () => {
    expect(selectEffectivePrice(points, '2026-06-01T00:00:00.000Z')?.id).toBe(
      'b',
    );
    expect(selectEffectivePrice(points, '2026-05-31T23:59:59.999Z')?.id).toBe(
      'a',
    );
  });
  test('last point never expires', () => {
    expect(selectEffectivePrice(points, '2099-01-01T00:00:00.000Z')?.id).toBe(
      'c',
    );
  });
  test('ignores superseded and is order-independent', () => {
    const pts = [
      p('c', '2026-09-01T00:00:00.000Z', 300n),
      p('b', '2026-06-01T00:00:00.000Z', 200n, '2026-07-01T00:00:00.000Z'),
      p('a', '2026-01-01T00:00:00.000Z', 100n),
    ];
    expect(selectEffectivePrice(pts, '2026-06-15T00:00:00.000Z')?.id).toBe('a');
  });
});

describe('canMergeScannedLine', () => {
  test('only plain catalog lines merge', () => {
    expect(
      canMergeScannedLine({
        isCatalogLine: true,
        manualPriceOverride: false,
        discountCount: 0,
      }),
    ).toBe(true);
    expect(
      canMergeScannedLine({
        isCatalogLine: false,
        manualPriceOverride: false,
        discountCount: 0,
      }),
    ).toBe(false);
    expect(
      canMergeScannedLine({
        isCatalogLine: true,
        manualPriceOverride: true,
        discountCount: 0,
      }),
    ).toBe(false);
    expect(
      canMergeScannedLine({
        isCatalogLine: true,
        manualPriceOverride: false,
        discountCount: 1,
      }),
    ).toBe(false);
  });
});
