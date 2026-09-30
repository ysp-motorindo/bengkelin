/**
 * Session loss (T4 hand-off): any call answering UNAUTHENTICATED (session
 * invalidated behind this window's back) sends the app back to login.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onUnauthenticated(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyUnauthenticated(): void {
  for (const listener of listeners) listener();
}

/** Call with any failed Result error; routes UNAUTHENTICATED to login. */
export function watchSessionError(error: { code: string }): void {
  if (error.code === 'UNAUTHENTICATED') notifyUnauthenticated();
}
