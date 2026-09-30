import { DomainError, type PercentageBps } from './primitives';

/**
 * Percentages typed by a cashier, parsed without floating point.
 * Accepts `0`..`100` with at most two decimals; `.` or `,` as the decimal
 * separator (Indonesian keyboards use a comma). `"2.75"` -> 275 bps.
 */
const PERCENTAGE_PATTERN = /^(\d{1,3})(?:[.,](\d{1,2}))?$/;

export function parsePercentageToBps(text: string): PercentageBps {
  const match =
    typeof text === 'string' ? PERCENTAGE_PATTERN.exec(text.trim()) : null;
  if (!match) throw invalid();
  const whole = Number.parseInt(match[1]!, 10);
  const fraction = Number.parseInt((match[2] ?? '').padEnd(2, '0'), 10);
  const bps = whole * 100 + fraction;
  if (bps > 10000) throw invalid();
  return bps;
}

/** 275 -> "2.75" (or "2,75"); trailing zeros are dropped: 1250 -> "12.5". */
export function formatBpsAsPercentage(
  bps: PercentageBps,
  decimalSeparator: '.' | ',' = '.',
): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw invalid();
  const whole = Math.trunc(bps / 100);
  const fraction = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}${decimalSeparator}${fraction}` : String(whole);
}

function invalid(): DomainError {
  return new DomainError(
    'INVALID_PERCENTAGE',
    'Percentage must be 0-100 with at most two decimals',
  );
}
