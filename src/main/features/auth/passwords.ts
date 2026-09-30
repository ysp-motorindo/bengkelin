import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Salted, asynchronous scrypt. The encoded form is self-describing so cost can
 * be raised later without breaking existing hashes:
 *
 *   scrypt$N=16384,r=8,p=1$<salt base64>$<hash base64>
 */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// Reject absurd stored parameters instead of exhausting memory.
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;

function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      keyLength,
      { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, N, R, P, KEY_LENGTH);
  return `scrypt$N=${N},r=${R},p=${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const ENCODED =
  /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

/** Constant-time verification. Malformed stored hashes never verify or throw. */
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const match = ENCODED.exec(encoded);
  if (!match) return false;
  const n = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  const salt = Buffer.from(match[4] as string, 'base64');
  const expected = Buffer.from(match[5] as string, 'base64');
  const powerOfTwo = n > 1 && (n & (n - 1)) === 0;
  if (
    !powerOfTwo ||
    n < 1024 ||
    n > MAX_N ||
    r < 1 ||
    r > MAX_R ||
    p < 1 ||
    p > MAX_P ||
    salt.length < 8 ||
    expected.length < 16
  ) {
    return false;
  }
  try {
    const actual = await derive(password, salt, n, r, p, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same scrypt cost as a real check when the username is unknown, so
 * response time does not reveal which usernames exist.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
}
