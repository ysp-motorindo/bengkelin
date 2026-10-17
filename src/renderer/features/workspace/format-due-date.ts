import type { LocalDate } from '@/shared/primitives';

export function formatDueDate(date: LocalDate, language: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Intl.DateTimeFormat(language, {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
  return `${weekday}, ${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${year}`;
}
