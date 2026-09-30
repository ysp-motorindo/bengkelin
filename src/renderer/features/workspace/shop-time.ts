import { Temporal } from 'temporal-polyfill';
import { formatLocal } from '@/renderer/features/catalog/local-time';
import type { Instant, LocalDate } from '@/shared/primitives';
import { businessDay, toInstant } from '@/shared/time';

/**
 * Shop-timezone helpers for the workspace (Part A review focus 3): the
 * invoice date is a calendar day in the shop timezone; pricingAt is a UTC
 * instant shown in shop-local time WITH its offset.
 */

export function nowInstant(): Instant {
  return toInstant(Date.now());
}

export function todayInShop(timezone: string): LocalDate {
  return businessDay(nowInstant(), timezone);
}

/** `+07:00` for the instant in the zone. */
export function offsetAt(instant: Instant, timezone: string): string {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).offset;
}

/** `2026-09-30 14:05 (UTC+07:00)`. */
export function formatWithOffset(instant: Instant, timezone: string): string {
  return `${formatLocal(instant, timezone).slice(0, 16)} (UTC${offsetAt(instant, timezone)})`;
}

/** First instant of the shop day (handles DST gaps at midnight). */
export function startOfShopDay(date: LocalDate, timezone: string): Instant {
  const start = Temporal.PlainDate.from(date).toZonedDateTime({
    timeZone: timezone,
  });
  return toInstant(start.epochMilliseconds);
}
