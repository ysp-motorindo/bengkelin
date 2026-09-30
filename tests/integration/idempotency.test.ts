import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openDatabase, withWriteTransaction } from '@/main/database/connection';
import type { AppDatabase } from '@/main/database/connection';
import { runIdempotent } from '@/main/database/idempotency';
import { migrateDatabase } from '@/main/database/migrate';
import { toInstant } from '@/shared/time';

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

const run = (requestId: string, command: string, work: () => unknown) =>
  withWriteTransaction(db, () =>
    runIdempotent(db, { requestId, command, clock }, work),
  );

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
    },
  ]);
});

test('reusing a request id for a different command is rejected', () => {
  run('req-2', 'a', () => 1);
  let code: string | undefined;
  try {
    run('req-2', 'b', () => 2);
  } catch (error) {
    code = (error as { code?: string }).code;
  }
  expect(code).toBe('IDEMPOTENCY_KEY_REUSED');
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
    runIdempotent(db, { requestId: 'r', command: 'c', clock }, () => 1),
  ).toThrow(/transaction/i);
});

test('void results are stored as null', () => {
  expect(run('req-4', 'a', () => undefined)).toBeNull();
  expect(run('req-4', 'a', () => 'x')).toBeNull();
});
