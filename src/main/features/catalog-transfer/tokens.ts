/**
 * In-memory preview tokens (never persisted: a restart simply needs a new
 * preview). Each entry expires `ttlMs` after it was issued; an expired entry
 * is dropped when it is looked up or when a new one is stored.
 */
export class PreviewTokenStore<T> {
  private readonly entries = new Map<
    string,
    { value: T; expiresAtMs: number }
  >();

  constructor(private readonly ttlMs: number) {}

  /** Stores the value and returns its expiry (epoch ms). */
  put(token: string, value: T, nowMs: number): number {
    this.purge(nowMs);
    const expiresAtMs = nowMs + this.ttlMs;
    this.entries.set(token, { value, expiresAtMs });
    return expiresAtMs;
  }

  get(token: string, nowMs: number): T | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (nowMs > entry.expiresAtMs) {
      this.entries.delete(token);
      return undefined;
    }
    return entry.value;
  }

  delete(token: string): void {
    this.entries.delete(token);
  }

  private purge(nowMs: number): void {
    for (const [token, entry] of this.entries) {
      if (nowMs > entry.expiresAtMs) this.entries.delete(token);
    }
  }
}
