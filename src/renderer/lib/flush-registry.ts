/**
 * Pending-work flushers (draft command queues). Callers that end the current
 * context (logout, normal exit, switching drafts) call `flushAll()` first so
 * debounced input is sent and acknowledged before leaving.
 */
type Flusher = () => Promise<boolean>;

const flushers = new Set<Flusher>();

export function registerFlusher(flusher: Flusher): () => void {
  flushers.add(flusher);
  return () => {
    flushers.delete(flusher);
  };
}

/** Resolves true when every registered flusher reported all work acknowledged. */
export async function flushAll(): Promise<boolean> {
  const results = await Promise.all(
    [...flushers].map((flush) => flush().catch(() => false)),
  );
  return results.every(Boolean);
}
