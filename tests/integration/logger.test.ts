import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createLogger } from '@/main/platform/logger';
import { CHANNELS } from '@/shared/channels';
import { createHarness, validSetup } from './helpers/harness';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'bengkelin-log-'));
  dirs.push(d);
  return d;
};
const clock = { now: () => '2026-09-30T03:00:00.000Z' };
const allLogText = (dir: string) =>
  readdirSync(dir)
    .map((f) => readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');

test('rotates by size and keeps at most five files', () => {
  const dir = tmp();
  const logger = createLogger({ dir, clock, maxBytes: 2000, maxFiles: 5 });
  for (let i = 0; i < 200; i += 1)
    logger.info('tick', { i, pad: 'x'.repeat(100) });
  const files = readdirSync(dir);
  expect(files.length).toBeLessThanOrEqual(5);
  expect(files.length).toBeGreaterThan(1);
  for (const f of files) {
    expect(readFileSync(path.join(dir, f)).length).toBeLessThanOrEqual(2000);
  }
  // Newest entries survive in the active file.
  expect(readFileSync(path.join(dir, 'bengkelin.log'), 'utf8')).toContain(
    '"i":199',
  );
});

test('strips passwords, hashes and customer PII keys, recursively', () => {
  const dir = tmp();
  const logger = createLogger({ dir, clock });
  logger.error('boom', {
    password: 'hunter2-secret',
    nested: {
      passwordHash: 'scrypt$abc',
      customerName: 'Budi',
      phone: '0812',
      licensePlate: 'D 1234 AB',
      address: 'Jl. X',
      ok: 'visible',
    },
    list: [{ plate: 'B 1 C' }],
    big: 10n,
    err: new Error('failure'),
  });
  const text = allLogText(dir);
  for (const secret of [
    'hunter2-secret',
    'scrypt$abc',
    'Budi',
    '0812',
    'D 1234 AB',
    'Jl. X',
    'B 1 C',
  ]) {
    expect(text).not.toContain(secret);
  }
  expect(text).toContain('visible');
  expect(text).toContain('failure');
});

test('a login attempt plaintext password never appears in the log files', async () => {
  const h = createHarness();
  try {
    await h.call(CHANNELS.settings.completeSetup, validSetup());
    const plain = 'plaintext-Password-9481';
    await h.call(
      CHANNELS.auth.login,
      { username: 'admin', password: plain },
      4,
    );
    await h.call(
      CHANNELS.auth.login,
      { username: 'nobody', password: plain },
      4,
    );
    await h.call(
      CHANNELS.auth.login,
      { username: 'admin', password: plain, extra: 1 },
      4,
    );
    await h.call(CHANNELS.auth.login, { username: 'x', password: 5 }, 4);
    // Force an unexpected failure while the password is in flight.
    h.db
      .exec(`CREATE TRIGGER boom BEFORE INSERT ON audit_log WHEN NEW.action = 'LOGIN_FAILED'
      BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    await h.call(
      CHANNELS.auth.login,
      { username: 'admin', password: plain },
      4,
    );
    const text = allLogText(h.logDir);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('command.failed');
    expect(text).not.toContain(plain);
  } finally {
    h.close();
  }
});
