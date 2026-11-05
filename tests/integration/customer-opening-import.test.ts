import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CHANNELS as C } from '@/shared/channels';
import { noFileDialogs } from '@/main/features/printing/driver';
import type {
  OpeningImportPreview,
  CustomerOpeningDetail,
} from '@/shared/contracts';
import {
  createHarness,
  validSetup,
  value,
  failure,
  ADMIN_PASSWORD,
  type Harness,
} from './helpers/harness';
let h: Harness;
let file: string;
let now: number;
let id: string;
const header = 'external_id,customer_name,as_of_date,opening_balance\n';
beforeEach(async () => {
  now = Date.parse('2026-10-01T03:00:00.000Z');
  file = '';
  h = createHarness({
    clock: { now: () => new Date(now).toISOString() },
    dialogs: { ...noFileDialogs, chooseCsvFile: async () => file || null },
  });
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  id = randomUUID();
  h.db
    .prepare(
      'INSERT INTO customers(id,name,external_id,created_at,updated_at) VALUES (?,?,?,?,?)',
    )
    .run(
      id,
      'Alpha',
      'CU-1',
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    );
  file = path.join(h.dir, 'opening.csv');
  writeFileSync(file, header + 'CU-1,Informational,2026-09-30,100000\n');
});
afterEach(() => {
  vi.restoreAllMocks();
  h.close();
});
async function preview() {
  const p = value(
    await h.call<OpeningImportPreview>(C.customerReceivables.previewImport),
  );
  if (p.outcome !== 'READY') throw Error('cancelled');
  return p;
}
const commit = (token: string) =>
  h.call(C.customerReceivables.commitImport, { token });
test('imports once, leaves names unchanged and replays receipt across restart', async () => {
  const p = await preview();
  expect(p.canCommit).toBe(true);
  expect(p.totalAmount).toBe('100000');
  const summary = value(await commit(p.token));
  expect(value(await commit(p.token))).toEqual(summary);
  expect(h.db.prepare('SELECT name FROM customers').get()).toEqual({
    name: 'Alpha',
  });
  h.reopen();
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  expect(value(await commit(p.token))).toEqual(summary);
});
test('identical reimport preserves repayments, changed amount/date blocks', async () => {
  let p = await preview();
  value(await commit(p.token));
  value(
    await h.call(C.customerReceivables.recordPayment, {
      requestId: randomUUID(),
      customerId: id,
      method: 'CASH',
      amount: '30000',
    }),
  );
  p = await preview();
  expect(p.summary.unchanged).toBe(1);
  value(await commit(p.token));
  expect(
    value(
      await h.call<CustomerOpeningDetail>(C.customerReceivables.get, {
        customerId: id,
      }),
    ).outstandingAmount,
  ).toBe('70000');
  for (const row of ['CU-1,A,2026-09-30,70000', 'CU-1,A,2026-10-01,100000']) {
    writeFileSync(file, header + row);
    p = await preview();
    expect(p.canCommit).toBe(false);
    expect(failure(await commit(p.token)).code).toBe('IMPORT_HAS_ERRORS');
  }
});
test.each([
  'CU-X,A,2026-09-30,1',
  'CU-1,A,2026-02-30,1',
  'CU-1,A,2026-09-30,-1',
  'CU-1,A,2026-09-30,1.5',
  'CU-1,A,2026-09-30,9223372036854775808',
  'CU-1,A,2026-09-30,1\nCU-1,B,2026-09-30,1',
])('blocks invalid rows atomically: %s', async (row) => {
  writeFileSync(file, header + row);
  const p = await preview();
  expect(p.canCommit).toBe(false);
  expect(failure(await commit(p.token)).code).toBe('IMPORT_HAS_ERRORS');
  expect(
    h.db.prepare('SELECT COUNT(*) n FROM customer_opening_balances').get(),
  ).toEqual({ n: 0n });
});
test('supports header order, zero, cancellation and malformed CSV', async () => {
  writeFileSync(
    file,
    'opening_balance,as_of_date,customer_name,external_id\n0,2026-09-30,A,CU-1',
  );
  expect((await preview()).canCommit).toBe(true);
  writeFileSync(file, header + '"unclosed');
  expect((await preview()).canCommit).toBe(false);
  file = '';
  expect(value(await h.call(C.customerReceivables.previewImport))).toEqual({
    outcome: 'CANCELLED',
  });
});
test('rejects expired and stale previews', async () => {
  let p = await preview();
  now += 3600000;
  expect(failure(await commit(p.token)).code).toBe('IMPORT_PREVIEW_EXPIRED');
  p = await preview();
  h.db.prepare("UPDATE customers SET name='Changed'").run();
  expect(failure(await commit(p.token)).code).toBe('IMPORT_PREVIEW_STALE');
});
test('backup failure and transaction failure leave no balances', async () => {
  let p = await preview();
  vi.spyOn(h.services.backups, 'createValidatedBackup').mockRejectedValueOnce(
    Error('disk'),
  );
  expect(failure(await commit(p.token)).code).toBe('IMPORT_BACKUP_FAILED');
  h.db.exec(
    "CREATE TRIGGER reject_opening BEFORE INSERT ON customer_opening_balances BEGIN SELECT RAISE(ABORT,'disk'); END",
  );
  p = await preview();
  expect((await commit(p.token)).ok).toBe(false);
  expect(
    h.db.prepare('SELECT COUNT(*) n FROM customer_opening_balances').get(),
  ).toEqual({ n: 0n });
});
test('rechecks session and validity after backup', async () => {
  const p = await preview();
  const original = h.services.backups.createValidatedBackup.bind(
    h.services.backups,
  );
  vi.spyOn(h.services.backups, 'createValidatedBackup').mockImplementationOnce(
    async (input) => {
      const backup = await original(input);
      now += 3600000;
      return backup;
    },
  );
  expect(failure(await commit(p.token)).code).toBe('IMPORT_PREVIEW_EXPIRED');
  expect(
    failure(await h.call(C.customerReceivables.previewImport, undefined, 99))
      .code,
  ).toBe('UNAUTHENTICATED');
});
