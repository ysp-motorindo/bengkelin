/** Search key for a plate: uppercase alphanumerics only. */
export function normalizePlate(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Digits-only phone search key; Indonesian `0…` and `+62…` converge on `62…`. */
export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits === '') return '';
  if (trimmed.startsWith('+')) return digits;
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  return digits;
}
