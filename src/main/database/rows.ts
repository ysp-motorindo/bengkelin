/**
 * Row-mapping helpers. The connection uses `defaultSafeIntegers(true)`, so
 * EVERY INTEGER column (ids, flags, counters, money) is read as `bigint`.
 *
 * Convention for repositories:
 *  1. Declare a `FooRow` interface mirroring the SELECT, integers typed `bigint`.
 *  2. Write one `toFooDto(row: FooRow): FooDto` that converts explicitly:
 *     flags with `bool`, small counters with `toNumber`, money with
 *     `formatRupiah`, TEXT columns as-is.
 *  3. Only DTOs leave the repository. DTOs must survive `JSON.stringify` and
 *     structured clone (no bigint, no undefined-as-value surprises).
 *  4. Bind flags with `flag(true)` (JS booleans cannot be bound) and money as
 *     bigint.
 */

/** INTEGER 0/1 column -> boolean. Rejects anything else. */
export function bool(value: unknown): boolean {
  if (value === 1n || value === 1) return true;
  if (value === 0n || value === 0) return false;
  throw new TypeError(`Expected a 0/1 flag, got ${String(value)}`);
}

/** boolean -> bindable INTEGER. */
export function flag(value: boolean): bigint {
  return value ? 1n : 0n;
}

/** Small non-money INTEGER -> number; throws outside the safe integer range. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (
    typeof value === 'bigint' &&
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  throw new TypeError(`Expected a safe integer, got ${String(value)}`);
}

/** Nullable TEXT column -> string | null. */
export function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new TypeError(`Expected text, got ${typeof value}`);
}
