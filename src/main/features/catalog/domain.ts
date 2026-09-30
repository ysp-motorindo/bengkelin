import type { Instant } from '@/shared/primitives';

export type PricePoint = {
  id: string;
  effectiveStartAt: Instant;
  supersededAt: Instant | null;
  price: bigint;
};

/** Latest non-superseded point starting at or before `pricingAt`; start-only, so the last never expires. */
export function selectEffectivePrice(
  points: PricePoint[],
  pricingAt: Instant,
): PricePoint | null {
  let best: PricePoint | null = null;
  for (const point of points) {
    if (point.supersededAt !== null || point.effectiveStartAt > pricingAt)
      continue;
    if (best === null || point.effectiveStartAt > best.effectiveStartAt)
      best = point;
  }
  return best;
}

export type ScannedLineState = {
  isCatalogLine: boolean;
  manualPriceOverride: boolean;
  discountCount: number;
};

export function canMergeScannedLine(line: ScannedLineState): boolean {
  return (
    line.isCatalogLine && !line.manualPriceOverride && line.discountCount === 0
  );
}
