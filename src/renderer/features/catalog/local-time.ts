import type { Instant } from '@/shared/primitives';

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let found = cache.get(timezone);
  if (!found) {
    found = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    cache.set(timezone, found);
  }
  return found;
}

/** `YYYY-MM-DD HH:mm:ss` wall-clock time of an instant in the shop timezone. */
export function formatLocal(instant: Instant, timezone: string): string {
  return formatter(timezone).format(new Date(instant));
}

/** `YYYY-MM-DDTHH:mm:ss`, the value form of a datetime-local input. */
export function toLocalInputValue(instant: Instant, timezone: string): string {
  return formatLocal(instant, timezone).replace(' ', 'T');
}

export { formatIdr } from '@/shared/idr';
