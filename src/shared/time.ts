import { Temporal } from 'temporal-polyfill';
import { DomainError, type Instant, type LocalDate } from './primitives';

export type Clock = { now(): Instant };

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Canonical instant: UTC ISO with milliseconds and `Z`; text order equals time order. */
export function toInstant(value: Date | number): Instant {
  const date = typeof value === 'number' ? new Date(value) : value;
  const ms = date.getTime();
  if (!Number.isFinite(ms))
    throw new DomainError('INVALID_INSTANT', 'Invalid time value');
  const iso = date.toISOString();
  if (!INSTANT_PATTERN.test(iso))
    throw new DomainError('INVALID_INSTANT', 'Instant year outside 0000-9999');
  return iso;
}

export function isInstant(value: string): value is Instant {
  if (typeof value !== 'string' || !INSTANT_PATTERN.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

export function businessDay(instant: Instant, timezone: string): LocalDate {
  let parsed: Temporal.Instant;
  try {
    parsed = Temporal.Instant.from(instant);
  } catch {
    throw new DomainError('INVALID_INSTANT', 'Invalid instant');
  }
  try {
    return parsed.toZonedDateTimeISO(timezone).toPlainDate().toString();
  } catch {
    throw new DomainError('INVALID_TIMEZONE', 'Invalid time zone');
  }
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
    throw new DomainError(
      'INVALID_LOCAL_DATE_TIME',
      'Local date-time must be YYYY-MM-DDTHH:mm[:ss]',
    );
  let plain: Temporal.PlainDateTime;
  try {
    plain = Temporal.PlainDateTime.from(localDateTime, { overflow: 'reject' });
  } catch {
    throw new DomainError(
      'INVALID_LOCAL_DATE_TIME',
      'Impossible local date-time',
    );
  }
  let earlier: Temporal.ZonedDateTime;
  let later: Temporal.ZonedDateTime;
  try {
    earlier = plain.toZonedDateTime(timezone, { disambiguation: 'earlier' });
    later = plain.toZonedDateTime(timezone, { disambiguation: 'later' });
  } catch {
    throw new DomainError('INVALID_TIMEZONE', 'Invalid time zone');
  }
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

export interface InstantRange {
  /** Inclusive: the first instant of the business day. */
  start: Instant;
  /** Exclusive: the first instant of the next business day. */
  end: Instant;
}

/**
 * The instants of one calendar day in a zone: `[start, end)`, the inverse of
 * `businessDay` (an instant `t` has `businessDay(t, tz) === date` exactly when
 * `start <= t < end`). Uses Temporal's start-of-day, so a day whose midnight
 * is skipped by DST still starts at its first existing instant, and a 23- or
 * 25-hour day is handled. Canonical instants compare correctly as text.
 */
export function businessDayRange(
  date: LocalDate,
  timezone: string,
): InstantRange {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new DomainError('INVALID_DATE', 'Date must be YYYY-MM-DD');
  }
  let day: Temporal.PlainDate;
  try {
    day = Temporal.PlainDate.from(date, { overflow: 'reject' });
  } catch {
    throw new DomainError('INVALID_DATE', 'Invalid date');
  }
  try {
    const start = day.toZonedDateTime({ timeZone: timezone });
    const end = day.add({ days: 1 }).toZonedDateTime({ timeZone: timezone });
    return {
      start: toInstant(start.epochMilliseconds),
      end: toInstant(end.epochMilliseconds),
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('INVALID_TIMEZONE', 'Invalid time zone');
  }
}
