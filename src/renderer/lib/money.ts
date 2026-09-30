import type { Rupiah } from '@/shared/primitives';

export { formatIdr } from '@/shared/idr';

/**
 * Parses what a cashier types as a whole-rupiah amount: digits with optional
 * `.` thousands separators and an optional `Rp` prefix. Returns a canonical
 * Rupiah string, or null when it is not a non-negative whole amount.
 */
export function parseRupiahInput(text: string): Rupiah | null {
  const compact = text.replace(/^\s*rp\.?\s*/i, '').replace(/\s+/g, '');
  if (!/^\d{1,3}(\.\d{3})+$|^\d+$/.test(compact)) return null;
  const digits = compact.replace(/\./g, '').replace(/^0+(?=\d)/, '');
  if (digits.length > 18) return null; // stays inside signed 64-bit
  return digits;
}

/** Sum of Rupiah strings, via BigInt. */
export function sumRupiah(values: readonly Rupiah[]): Rupiah {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
}
