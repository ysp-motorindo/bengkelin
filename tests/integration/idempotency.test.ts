import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openDatabase, withWriteTransaction } from '@/main/database/connection';
import type { AppDatabase } from '@/main/database/connection';
import { runIdempotent } from '@/main/database/idempotency';
import { migrateDatabase } from '@/main/database/migrate';
import { toInstant } from '@/shared/time';
import { createHash } from 'node:crypto';
import { DomainError } from '@/shared/primitives';

/** SHA-256 (hex) of the canonical JSON text. */
const hashOf = (canonicalJson: string) =>
  createHash('sha256').update(canonicalJson).digest('hex');

let dir: string;
let db: AppDatabase;
const clock = { now: () => toInstant(Date.UTC(2026, 8, 30, 3, 0, 0)) };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bengkelin-idem-'));
  db = openDatabase(path.join(dir, 'db.sqlite'));
  migrateDatabase(db);
  db.exec('CREATE TABLE effects (n INTEGER)');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (
  requestId: string,
  command: string,
  work: () => unknown,
  payload: unknown = {},
) =>
  withWriteTransaction(db, () =>
    runIdempotent(db, { requestId, command, payload, clock }, work),
  );

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

test('a retry returns the stored result without re-running work', () => {
  let calls = 0;
  const work = () => {
    calls += 1;
    db.prepare('INSERT INTO effects VALUES (?)').run(calls);
    return { invoiceId: 'inv-1', total: '1000' };
  };
  const first = run('req-1', 'finalizeInvoice', work);
  const second = run('req-1', 'finalizeInvoice', work);
  expect(second).toEqual(first);
  expect(calls).toBe(1);
  expect(db.prepare('SELECT count(*) AS n FROM effects').get()).toEqual({
    n: 1n,
  });
  expect(db.prepare('SELECT * FROM command_receipts').all()).toEqual([
    {
      request_id: 'req-1',
      command: 'finalizeInvoice',
      result: '{"invoiceId":"inv-1","total":"1000"}',
      created_at: '2026-09-30T03:00:00.000Z',
      actor_cashier_id: null,
      payload_hash: hashOf('{}'),
    },
  ]);
});

test('reusing a request id for a different command is rejected', () => {
  run('req-2', 'a', () => 1);
  expect(codeOf(() => run('req-2', 'b', () => 2))).toBe(
    'IDEMPOTENCY_KEY_REUSED',
  );
});

test('reusing a request id with a different payload is rejected, as a client-facing DomainError', () => {
  let calls = 0;
  run('req-p', 'a', () => (calls += 1), { qty: 1, id: 'x' });
  let thrown: unknown;
  try {
    run('req-p', 'a', () => (calls += 1), { qty: 2, id: 'x' });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DomainError);
  expect((thrown as DomainError).code).toBe('IDEMPOTENCY_KEY_REUSED');
  expect(calls).toBe(1);
});

test('the payload hash ignores key order, so an equal payload replays', () => {
  let calls = 0;
  const work = () => (calls += 1);
  const first = run('req-o', 'a', work, {
    b: [1, { d: 4n, c: 3 }],
    a: 'x',
    skip: undefined,
  });
  const again = run('req-o', 'a', work, { a: 'x', b: [1, { c: 3, d: 4n }] });
  expect(again).toBe(first);
  expect(calls).toBe(1);
  // bigint is hashed as its decimal string; array order still matters.
  expect(db.prepare('SELECT payload_hash FROM command_receipts').get()).toEqual(
    {
      payload_hash: hashOf('{"a":"x","b":[1,{"c":3,"d":"4"}]}'),
    },
  );
});

test('first run and replay return identically shaped JSON-safe values', () => {
  const work = () => ({
    when: new Date(Date.UTC(2026, 0, 1)),
    skipped: undefined,
    nested: [1, { ok: true }],
  });
  const first = run('req-s', 'a', work);
  const replay = run('req-s', 'a', work);
  expect(first).toEqual({
    when: '2026-01-01T00:00:00.000Z',
    nested: [1, { ok: true }],
  });
  expect(replay).toEqual(first);
  expect('skipped' in (first as object)).toBe(false);
});

test('a bigint in a result raises NON_SERIALIZABLE_RESULT, records nothing and rolls back', () => {
  expect(
    codeOf(() =>
      run('req-b', 'a', () => {
        db.prepare('INSERT INTO effects VALUES (1)').run();
        return { total: 5n };
      }),
    ),
  ).toBe('NON_SERIALIZABLE_RESULT');
  expect(
    db.prepare('SELECT count(*) AS n FROM command_receipts').get(),
  ).toEqual({ n: 0n });
  expect(db.prepare('SELECT count(*) AS n FROM effects').get()).toEqual({
    n: 0n,
  });
});

test('a payload that cannot be canonicalised is a typed error too', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(codeOf(() => run('req-c', 'a', () => 1, cyclic))).toBe(
    'NON_SERIALIZABLE_PAYLOAD',
  );
});

test('legacy receipts without a payload hash replay for the same command and are never matched to a different command', () => {
  db.prepare(
    `INSERT INTO command_receipts (request_id, command, result, created_at, actor_cashier_id, payload_hash)
     VALUES ('old-1', 'a', '{"n":1}', '2026-09-30T03:00:00.000Z', NULL, NULL)`,
  ).run();
  let calls = 0;
  const replay = run('old-1', 'a', () => (calls += 1), { anything: true });
  expect(replay).toEqual({ n: 1 });
  expect(calls).toBe(0);
  expect(codeOf(() => run('old-1', 'b', () => 1))).toBe(
    'IDEMPOTENCY_KEY_REUSED',
  );
  // The payload cannot be verified, so the hash is NOT back-filled from the retry.
  expect(
    db
      .prepare(
        "SELECT payload_hash FROM command_receipts WHERE request_id = 'old-1'",
      )
      .get(),
  ).toEqual({ payload_hash: null });
});

test('a failure inside work records no receipt and lets a retry run', () => {
  expect(() =>
    run('req-3', 'a', () => {
      db.prepare('INSERT INTO effects VALUES (1)').run();
      throw new Error('nope');
    }),
  ).toThrow('nope');
  expect(
    db.prepare('SELECT count(*) AS n FROM command_receipts').get(),
  ).toEqual({ n: 0n });
  expect(db.prepare('SELECT count(*) AS n FROM effects').get()).toEqual({
    n: 0n,
  });
  expect(run('req-3', 'a', () => 'ok')).toBe('ok');
});

test('requires an open write transaction', () => {
  expect(() =>
    runIdempotent(
      db,
      { requestId: 'r', command: 'c', payload: {}, clock },
      () => 1,
    ),
  ).toThrow(/transaction/i);
});

test('void results are stored as null', () => {
  expect(run('req-4', 'a', () => undefined)).toBeNull();
  expect(run('req-4', 'a', () => 'x')).toBeNull();
});
