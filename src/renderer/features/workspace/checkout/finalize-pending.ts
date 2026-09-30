/**
 * Whether a finalize request is in flight (I3). The shell ignores New
 * Transaction (Ctrl+N) meanwhile, so a cashier cannot leave the draft
 * while main may still be committing it.
 */
let pending = 0;

/** Marks `request` as an in-flight finalize until it settles. */
export function trackFinalize<T>(request: Promise<T>): Promise<T> {
  pending += 1;
  return request.finally(() => {
    pending -= 1;
  });
}

export function isFinalizePending(): boolean {
  return pending > 0;
}
