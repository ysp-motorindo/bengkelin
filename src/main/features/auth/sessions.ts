import type {
  Appearance,
  NumberFormat,
  CashierSession,
  Language,
  Role,
  UUID,
} from '@/shared/contracts';

/** An authenticated cashier bound to one renderer window (webContents id). */
export interface Session {
  windowId: number;
  cashierId: UUID;
  username: string;
  displayName: string;
  role: Role;
  language: Language;
  appearance: Appearance;
  numberFormat: NumberFormat;
}

export function toSessionDto(session: Session): CashierSession {
  return {
    cashierId: session.cashierId,
    username: session.username,
    displayName: session.displayName,
    role: session.role,
    language: session.language,
    appearance: session.appearance,
    numberFormat: session.numberFormat,
  };
}

/**
 * In-memory, window-bound sessions. Nothing is persisted or handed to the
 * renderer as a token: the sender's webContents id IS the credential, so a
 * renderer cannot present someone else's session.
 */
export class SessionStore {
  private readonly sessions = new Map<number, Session>();
  private readonly listeners = new Set<(windowId: number) => void>();

  /**
   * Called with the window id after its session started or ended (login,
   * logout, invalidation). The native menu rebuilds from it. Returns an
   * unsubscribe function.
   */
  onChange(listener: (windowId: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(windowId: number): void {
    for (const listener of this.listeners) {
      try {
        listener(windowId);
      } catch {
        // A listener (menu rebuild) must never break authentication.
      }
    }
  }

  /** Starts (replacing any previous) session for the window. */
  start(session: Session): Session {
    this.sessions.set(session.windowId, session);
    this.changed(session.windowId);
    return session;
  }

  get(windowId: number): Session | undefined {
    return this.sessions.get(windowId);
  }

  /** Logout / window closed / renderer gone. Returns the ended session. */
  endWindow(windowId: number): Session | undefined {
    const session = this.sessions.get(windowId);
    this.sessions.delete(windowId);
    if (session) this.changed(windowId);
    return session;
  }

  /** Deactivation, role change, password reset: end every session of a cashier. */
  invalidateCashier(cashierId: UUID): number {
    let ended = 0;
    for (const [windowId, session] of this.sessions) {
      if (session.cashierId === cashierId) {
        this.sessions.delete(windowId);
        this.changed(windowId);
        ended += 1;
      }
    }
    return ended;
  }
}
