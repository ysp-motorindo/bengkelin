import { MAX_DISCOUNT_STAGE_COUNT } from '@/shared/contracts';
import {
  formatBpsAsPercentage,
  parsePercentageToBps,
} from '@/shared/percentage';
import { DomainError, type PercentageBps } from '@/shared/primitives';

export type DiscountTexts = string[];

/** Four input strings from persisted stages (blank for unused stages). */
export function stagesToTexts(
  stages: readonly { percentageBps: PercentageBps }[],
  separator: '.' | ',',
): DiscountTexts {
  return Array.from({ length: MAX_DISCOUNT_STAGE_COUNT }, (_, index) => {
    const stage = stages[index];
    return stage ? formatBpsAsPercentage(stage.percentageBps, separator) : '';
  });
}

export type ParsedStages =
  | { ok: true; stages: PercentageBps[] }
  | { ok: false; index: number; reason: 'invalid' | 'gap' };

/**
 * Stage 1..4 texts -> bps. Blank trailing stages are dropped; a blank stage
 * followed by a filled one is a gap (stages are sequential).
 */
export function parseStageTexts(texts: DiscountTexts): ParsedStages {
  const stages: PercentageBps[] = [];
  let blankAt = -1;
  for (let index = 0; index < texts.length; index += 1) {
    const text = (texts[index] ?? '').trim();
    if (!text) {
      if (blankAt < 0) blankAt = index;
      continue;
    }
    if (blankAt >= 0) return { ok: false, index, reason: 'gap' };
    try {
      stages.push(parsePercentageToBps(text));
    } catch (error) {
      if (error instanceof DomainError) {
        return { ok: false, index, reason: 'invalid' };
      }
      throw error;
    }
  }
  return { ok: true, stages };
}

export function sameStages(
  a: readonly PercentageBps[],
  b: readonly { percentageBps: PercentageBps }[],
): boolean {
  return (
    a.length === b.length &&
    a.every((bps, index) => bps === b[index]!.percentageBps)
  );
}
