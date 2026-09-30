import { expect, test } from 'vitest';
import { hashPassword, verifyPassword } from '@/main/features/auth/passwords';

test('hash is salted, self-describing and verifies', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  expect(a).not.toBe(b);
  expect(a).toMatch(
    /^scrypt\$N=\d+,r=\d+,p=\d+\$[A-Za-z0-9+/=_-]+\$[A-Za-z0-9+/=_-]+$/,
  );
  expect(a).not.toContain('correct horse');
  expect(await verifyPassword('correct horse', a)).toBe(true);
  expect(await verifyPassword('correct horsf', a)).toBe(false);
  expect(await verifyPassword('', a)).toBe(false);
});

test.each([
  '',
  'garbage',
  'scrypt$N=1,r=1,p=1$AA$AA',
  'bcrypt$x$y$z',
  'scrypt$N=16384,r=8,p=1$AAAA',
])(
  'malformed stored hash %j never verifies and never throws',
  async (stored) => {
    expect(await verifyPassword('anything', stored)).toBe(false);
  },
);
