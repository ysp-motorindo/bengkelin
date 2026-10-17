import { formatNumericText } from './number-format';
import type { Rupiah } from './primitives';

/**
 * `Rp 65.000` from a Rupiah decimal string, via BigInt (never Number).
 * Locale grouping is independent of interface language. Shared by the renderer and
 * the print templates so every surface shows money identically.
 */
export function formatIdr(value: Rupiah, locale = 'id-ID'): string {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString();
  const grouped = formatNumericText(digits, locale);
  return negative ? `-Rp ${grouped}` : `Rp ${grouped}`;
}
