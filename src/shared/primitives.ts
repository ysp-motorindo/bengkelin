/** Transport types shared by main, preload and renderer. */
export type UUID = string;
/** YYYY-MM-DD */
export type LocalDate = string;
/** Canonical UTC ISO timestamp: YYYY-MM-DDTHH:mm:ss.SSSZ */
export type Instant = string;
/** Integer decimal string across IPC. */
export type Rupiah = string;
/** Integer 0-10000; 275 means 2.75%. */
export type PercentageBps = number;

export type Result<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: string;
        messageKey: string;
        fieldErrors?: Record<string, string>;
      };
    };

/** Typed domain failure with a stable machine-readable code. */
export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'DomainError';
    this.code = code;
  }
}

export const INT64_MIN = -9223372036854775808n;
export const INT64_MAX = 9223372036854775807n;

/** Throws MONEY_OVERFLOW unless the value fits SQLite's signed 64-bit INTEGER. */
export function assertInt64(value: bigint): bigint {
  if (typeof value !== 'bigint')
    throw new DomainError('INVALID_MONEY', 'Money must be a bigint');
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new DomainError(
      'MONEY_OVERFLOW',
      'Amount exceeds signed 64-bit range',
    );
  }
  return value;
}

const INTEGER_PATTERN = /^(0|-?[1-9][0-9]*)$/;

/** Strict parse of an integer decimal string. No whitespace, `+`, decimals, exponents or leading zeros. */
export function parseRupiah(value: string): bigint {
  if (typeof value !== 'string' || !INTEGER_PATTERN.test(value)) {
    throw new DomainError(
      'INVALID_MONEY',
      'Rupiah must be an integer decimal string',
    );
  }
  return assertInt64(BigInt(value));
}

export function formatRupiah(value: bigint): Rupiah {
  return assertInt64(value).toString();
}
