import type { Appearance } from '@/shared/contracts';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** True when the appearance resolves to dark for the given OS preference. */
export function isDark(
  appearance: Appearance,
  systemPrefersDark: boolean,
): boolean {
  return (
    appearance === 'DARK' || (appearance === 'SYSTEM' && systemPrefersDark)
  );
}

/**
 * Applies the appearance as a `dark` class on <html> (Tailwind's dark variant
 * keys off it). SYSTEM follows `prefers-color-scheme` and updates live while
 * subscribed. Returns a cleanup function.
 */
export function applyAppearance(
  appearance: Appearance,
  root: HTMLElement = document.documentElement,
  media: MediaQueryList | undefined = typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_QUERY)
    : undefined,
): () => void {
  const apply = () => {
    const dark = isDark(appearance, media?.matches ?? false);
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
  };
  apply();
  if (appearance !== 'SYSTEM' || !media) return () => undefined;
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}
