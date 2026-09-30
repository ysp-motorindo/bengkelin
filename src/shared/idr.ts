import type { Rupiah } from './primitives';

/**
 * `Rp 65.000` from a Rupiah decimal string, via BigInt (never Number).
 * IDR grouping (`.`) is used in both languages. Shared by the renderer and
 * the print templates so every surface shows money identically.
 */
export function formatIdr(value: Rupiah): string {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return negative ? `-Rp ${grouped}` : `Rp ${grouped}`;
}
