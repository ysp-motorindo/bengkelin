import { describe, expect, test } from 'vitest';
import { applyAppearance, isDark } from '@/renderer/lib/theme';

/** Minimal MediaQueryList whose preference can be flipped at runtime. */
function fakeMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: initial,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  return {
    media: media as unknown as MediaQueryList,
    set(value: boolean) {
      media.matches = value;
      listeners.forEach((fn) => fn());
    },
    listenerCount: () => listeners.size,
  };
}

describe('theme', () => {
  test('resolution table', () => {
    expect(isDark('DARK', false)).toBe(true);
    expect(isDark('LIGHT', true)).toBe(false);
    expect(isDark('SYSTEM', true)).toBe(true);
    expect(isDark('SYSTEM', false)).toBe(false);
  });

  test('SYSTEM follows prefers-color-scheme live and stops after cleanup', () => {
    const root = document.createElement('html');
    const system = fakeMedia(false);
    const cleanup = applyAppearance('SYSTEM', root, system.media);
    expect(root.classList.contains('dark')).toBe(false);
    system.set(true);
    expect(root.classList.contains('dark')).toBe(true);
    system.set(false);
    expect(root.classList.contains('dark')).toBe(false);
    cleanup();
    expect(system.listenerCount()).toBe(0);
    system.set(true);
    expect(root.classList.contains('dark')).toBe(false);
  });

  test('explicit LIGHT and DARK ignore the system preference', () => {
    const root = document.createElement('html');
    const system = fakeMedia(true);
    applyAppearance('LIGHT', root, system.media);
    expect(root.classList.contains('dark')).toBe(false);
    expect(system.listenerCount()).toBe(0);
    applyAppearance('DARK', root, fakeMedia(false).media);
    expect(root.classList.contains('dark')).toBe(true);
  });
});
