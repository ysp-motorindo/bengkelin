import { Temporal } from 'temporal-polyfill';
import type { Instant, LocalDate } from './primitives';

export type Clock = { now(): Instant };

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Canonical instant: UTC ISO with milliseconds and `Z`; text order equals time order. */
export function toInstant(value: Date | number): Instant {
  const date = typeof value === 'number' ? new Date(value) : value;
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('Invalid time value');
  const iso = date.toISOString();
  if (!INSTANT_PATTERN.test(iso))
    throw new RangeError('Instant year outside 0000-9999');
  return iso;
}

export function isInstant(value: string): value is Instant {
  if (typeof value !== 'string' || !INSTANT_PATTERN.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

export function businessDay(instant: Instant, timezone: string): LocalDate {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toString();
}

export type OffsetChoice = 'earlier' | 'later';

export type LocalDateTimeResolution =
  | { kind: 'ok'; instant: Instant }
  | { kind: 'ambiguous'; candidates: Instant[] }
  | { kind: 'nonexistent' };

const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/;

/**
 * Resolves a wall-clock time in a zone. DST overlaps are reported as ambiguous unless the
 * caller picks the earlier or later offset; DST gaps are always nonexistent.
 */
export function resolveLocalDateTime(
  localDateTime: string,
  timezone: string,
  offsetChoice?: OffsetChoice,
): LocalDateTimeResolution {
  const match = LOCAL_DATE_TIME.exec(localDateTime);
  if (!match)
    throw new RangeError('Local date-time must be YYYY-MM-DDTHH:mm[:ss]');
  const plain = Temporal.PlainDateTime.from(localDateTime, {
    overflow: 'reject',
  });
  const earlier = plain.toZonedDateTime(timezone, {
    disambiguation: 'earlier',
  });
  const later = plain.toZonedDateTime(timezone, { disambiguation: 'later' });
  if (earlier.epochMilliseconds === later.epochMilliseconds) {
    return { kind: 'ok', instant: toInstant(earlier.epochMilliseconds) };
  }
  if (Temporal.PlainDateTime.compare(earlier.toPlainDateTime(), plain) !== 0) {
    return { kind: 'nonexistent' };
  }
  if (offsetChoice === 'earlier')
    return { kind: 'ok', instant: toInstant(earlier.epochMilliseconds) };
  if (offsetChoice === 'later')
    return { kind: 'ok', instant: toInstant(later.epochMilliseconds) };
  return {
    kind: 'ambiguous',
    candidates: [
      toInstant(earlier.epochMilliseconds),
      toInstant(later.epochMilliseconds),
    ],
  };
}
