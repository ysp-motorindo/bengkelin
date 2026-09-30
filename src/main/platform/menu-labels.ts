import type { Language } from '@/shared/contracts';
import enShell from '@/renderer/locales/en/shell.json';
import idShell from '@/renderer/locales/id/shell.json';

/**
 * Native menu labels. They live in the renderer's `shell` locale files
 * (one source of truth, covered by the locale-parity test) and are bundled
 * into main as data.
 */
export type MenuLabels = typeof idShell.menu;

const LABELS: Record<Language, MenuLabels> = {
  id: idShell.menu,
  en: enShell.menu,
};

export function menuLabels(language: Language): MenuLabels {
  return LABELS[language] ?? LABELS.id;
}
