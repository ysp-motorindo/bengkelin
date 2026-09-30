import { useEffect, useRef } from 'react';
import { flushAll } from '@/renderer/lib/flush-registry';
import type { MenuAction } from '@/shared/menu';

/**
 * Native menu actions in the renderer (spec 53). Main sends a finite
 * MenuAction on one channel; the preload drops anything else. `App`
 * handles what needs no session (About, Reload); the signed-in shell
 * handles the rest, switching to the right view first and calling
 * existing APIs. Nothing finalizes: Finalize (F8) only opens the review.
 */

/** Subscribes `handler` to menu actions while mounted (latest handler wins). */
export function useMenuActions(handler: (action: MenuAction) => void): void {
  const current = useRef(handler);
  current.current = handler;
  useEffect(() => {
    const bridge = window.bengkelin?.app;
    if (typeof bridge?.onMenuAction !== 'function') return undefined;
    return bridge.onMenuAction((action) => current.current(action));
  }, []);
}

/** Test seam: how the page reloads after the flush. */
export const pageReload = {
  reload: () => window.location.reload(),
};

/**
 * View > Reload (ruling): pending draft input is flushed first, like the
 * close handshake; then the page reloads. The session is bound to the
 * window, so the cashier stays signed in.
 */
export async function reloadAfterFlush(): Promise<void> {
  try {
    await flushAll();
  } finally {
    pageReload.reload();
  }
}
