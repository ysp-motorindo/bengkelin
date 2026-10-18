import { formatDisplayDate } from '@/renderer/lib/date-format';
import type { LocalDate } from '@/shared/primitives';

export function formatDueDate(date: LocalDate, language: string): string {
  const weekday = new Intl.DateTimeFormat(language, {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
  return `${weekday}, ${formatDisplayDate(date)}`;
}
