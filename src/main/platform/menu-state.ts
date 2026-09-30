import type { Session } from '@/main/features/auth/sessions';
import type { MenuContextInput } from '@/shared/contracts';

export interface MenuContext {
  printable: boolean;
}

const EMPTY: MenuContext = Object.freeze({ printable: false });

/**
 * Renderer-reported state the native menu depends on, per window
 * (Electron-free; `menu.ts` listens and rebuilds). Only a signed-in window
 * can report anything: before login nothing is printable.
 */
export class MenuState {
  private readonly contexts = new Map<number, MenuContext>();
  private readonly listeners = new Set<(windowId: number) => void>();

  get(windowId: number): MenuContext {
    return this.contexts.get(windowId) ?? EMPTY;
  }

  /** From `app.setMenuContext`; ignored without a session. */
  report(
    session: Session | undefined,
    windowId: number,
    input: MenuContextInput,
  ): void {
    if (!session) return;
    const current = this.get(windowId);
    if (current.printable === input.printable) return;
    this.contexts.set(windowId, { printable: input.printable });
    this.emit(windowId);
  }

  /** The window's session ended (or the window is gone): forget it. */
  clear(windowId: number): void {
    if (this.contexts.delete(windowId)) this.emit(windowId);
  }

  onChange(listener: (windowId: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(windowId: number): void {
    for (const listener of this.listeners) {
      try {
        listener(windowId);
      } catch {
        // A menu rebuild failure must not fail the command.
      }
    }
  }
}
