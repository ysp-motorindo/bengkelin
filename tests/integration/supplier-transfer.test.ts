import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createHarness,
  validSetup,
  value,
  ADMIN_PASSWORD,
  type Harness,
} from './helpers/harness';
import { noFileDialogs } from '@/main/features/printing/driver';
import { CHANNELS as C } from '@/shared/channels';
let h: Harness;
let file: string;
let restoreFile: string | null = null;
let now = Date.UTC(2026, 8, 30, 3);
const channel = 'bengkelin:supplierTransfer:';
const header =
  'external_id,name,phone_number,email,address,is_active,as_of_date,opening_balance\n';
beforeEach(async () => {
  now = Date.UTC(2026, 8, 30, 3);
  restoreFile = null;
  h = createHarness({
    clock: { now: () => new Date(now).toISOString() },
    restore: { relaunch: () => {} },
    dialogs: {
      ...noFileDialogs,
      chooseRestoreFile: async () => restoreFile,
      chooseCsvFile: async () => file,
    },
  });
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  file = path.join(h.dir, 'suppliers.csv');
  writeFileSync(file, header + 'SU-1,Alpha,,,,true,2026-10-31,1284002694\n');
});
afterEach(() => {
  vi.restoreAllMocks();
  h.close();
});
async function preview() {
  return value(await h.call<any>(channel + 'previewImport'));
}
const commit = (token: string) =>
  h.call<any>(channel + 'commitImport', { token });
test('combined import is atomic and reimport preserves payments across restart', async () => {
  let p = await preview();
  expect(p.canCommit).toBe(true);
  expect(p.totalOpeningAmount).toBe('1284002694');
  const result = value(await commit(p.token));
  expect(value(await commit(p.token))).toEqual(result);
  const { id } = h.db.prepare('SELECT id FROM suppliers').get() as {
    id: string;
  };
  const payment = {
    requestId: randomUUID(),
    supplierId: id,
    method: 'CASH',
    amount: '100000',
  };
  const paid = value(
    await h.call<any>('bengkelin:supplierPayables:recordPayment', payment),
  );
  expect(paid.outstandingAmount).toBe('1283902694');
  const report = value(
    await h.call<any>(C.reports.daily, { date: '2026-09-30' }),
  );
  expect(report.purchasePayments.amount).toBe('100000');
  expect(report.purchases.billCount).toBe(0);
  expect(
    value(await h.call('bengkelin:supplierPayables:recordPayment', payment)),
  ).toEqual(paid);
  p = await preview();
  expect(p.summary.openings.unchanged).toBe(1);
  value(await commit(p.token));
  h.reopen();
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  expect(
    value(
      await h.call<any>('bengkelin:supplierPayables:get', { supplierId: id }),
    ).payments,
  ).toHaveLength(1);
  writeFileSync(file, header + 'SU-1,Changed,,,,true,2026-10-31,100\n');
  p = await preview();
  expect(p.canCommit).toBe(false);
  expect((await commit(p.token)).ok).toBe(false);
  expect(h.db.prepare('SELECT name FROM suppliers').get()).toEqual({
    name: 'Alpha',
  });
});
test.each([
  '2026-02-30,1',
  '2026-10-31,-1',
  '2026-10-31,1.5',
  '2026-10-31,9223372036854775808',
  ',1',
])('rejects invalid opening %s', async (financial) => {
  writeFileSync(file, header + 'SU-1,Alpha,,,,true,' + financial + '\n');
  expect((await preview()).canCommit).toBe(false);
});
test('backup failure and stale preview leave both tables unchanged', async () => {
  let p = await preview();
  vi.spyOn(h.services.backups, 'createValidatedBackup').mockRejectedValueOnce(
    Error('disk'),
  );
  expect((await commit(p.token)).ok).toBe(false);
  expect(h.db.prepare('SELECT count(*) n FROM suppliers').get()).toEqual({
    n: 0n,
  });
  p = await preview();
  value(
    await h.call(C.suppliers.save, { requestId: randomUUID(), name: 'Other' }),
  );
  expect((await commit(p.token)).ok).toBe(false);
});
test('prepared workbook CSV imports all three original balances', async () => {
  file = path.resolve('references/supplier-import.csv');
  const p = await preview();
  expect(p.canCommit).toBe(true);
  expect(p.summary.suppliers.creates).toBe(3);
  expect(p.summary.openings.creates).toBe(3);
  expect(p.totalOpeningAmount).toBe('1284002694');
  value(await commit(p.token));
  expect(
    h.db
      .prepare('SELECT phone_number FROM suppliers WHERE external_id=?')
      .get('SU-0001'),
  ).toEqual({ phone_number: '81386919191' });
});
test('contact-only update preserves identity and original balance', async () => {
  value(await commit((await preview()).token));
  writeFileSync(file, header + 'SU-1,Updated,,,,false,,\n');
  const p = await preview();
  expect(p.summary.openings.skipped).toBe(1);
  value(await commit(p.token));
  expect(
    h.db
      .prepare('SELECT external_id,name,version,is_active FROM suppliers')
      .get(),
  ).toEqual({
    external_id: 'SU-1',
    name: 'Updated',
    version: 2n,
    is_active: 0n,
  });
  expect(
    h.db.prepare('SELECT amount FROM supplier_opening_balances').get(),
  ).toEqual({ amount: 1284002694n });
});
test('all rows and receipt roll back if an opening insert fails', async () => {
  writeFileSync(
    file,
    header +
      'SU-1,Alpha,,,,true,2026-10-31,0\nSU-2,Beta,,,,true,2026-10-31,1\n',
  );
  h.db.exec(
    "CREATE TRIGGER reject_second_opening BEFORE INSERT ON supplier_opening_balances WHEN NEW.amount=1 BEGIN SELECT RAISE(ABORT,'disk'); END",
  );
  const p = await preview();
  expect((await commit(p.token)).ok).toBe(false);
  expect(h.db.prepare('SELECT count(*) n FROM suppliers').get()).toEqual({
    n: 0n,
  });
  expect(
    h.db
      .prepare('SELECT request_id FROM command_receipts WHERE request_id=?')
      .get(p.token),
  ).toBeUndefined();
});
test('duplicate phones need acknowledgement and duplicate external IDs block', async () => {
  writeFileSync(
    file,
    header + 'SU-1,Alpha,08123,,,true,,\nSU-2,Beta,+628123,,,true,,\n',
  );
  const p = await preview();
  expect(p.requiresDuplicatePhoneAcknowledgement).toBe(true);
  expect((await commit(p.token)).ok).toBe(false);
  value(
    await h.call(channel + 'commitImport', {
      token: p.token,
      acknowledgeDuplicatePhones: true,
    }),
  );
  writeFileSync(file, header + 'SU-1,A,,,,true,,\nSU-1,B,,,,true,,\n');
  expect((await preview()).canCommit).toBe(false);
});
test.each(['logout', 'stale'])(
  'rechecks %s after safety backup',
  async (change) => {
    const p = await preview();
    const original = h.services.backups.createValidatedBackup.bind(
      h.services.backups,
    );
    vi.spyOn(
      h.services.backups,
      'createValidatedBackup',
    ).mockImplementationOnce(async (input) => {
      const result = await original(input);
      if (change === 'logout') value(await h.call(C.auth.logout));
      else
        value(
          await h.call(C.suppliers.save, {
            requestId: randomUUID(),
            name: 'Changed',
          }),
        );
      return result;
    });
    expect((await commit(p.token)).ok).toBe(false);
    expect(
      h.db.prepare('SELECT count(*) n FROM supplier_opening_balances').get(),
    ).toEqual({ n: 0n });
  },
);
test('matching includes inactive suppliers beyond fifty records', async () => {
  const now = '2026-09-30T03:00:00.000Z';
  for (let i = 0; i < 55; i++)
    h.db
      .prepare(
        'INSERT INTO suppliers(id,external_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
      .run(randomUUID(), 'SU-' + i, 'Supplier ' + i, 0, now, now);
  writeFileSync(file, header + 'SU-54,Updated,,,,false,2026-10-31,0\n');
  const p = await preview();
  expect(p.summary.suppliers.updates).toBe(1);
  value(await commit(p.token));
  expect(h.db.prepare('SELECT count(*) n FROM suppliers').get()).toEqual({
    n: 55n,
  });
});
test('two overlapping payment commands cannot overpay and originals are immutable', async () => {
  value(await commit((await preview()).token));
  const { id } = h.db.prepare('SELECT id FROM suppliers').get() as {
    id: string;
  };
  const pay = () =>
    h.call('bengkelin:supplierPayables:recordPayment', {
      requestId: randomUUID(),
      supplierId: id,
      method: 'CASH',
      amount: '1000000000',
    });
  const results = await Promise.all([pay(), pay()]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(() =>
    h.db.prepare('UPDATE supplier_opening_balances SET amount=0').run(),
  ).toThrow();
  expect(() =>
    h.db.prepare('DELETE FROM supplier_opening_payments').run(),
  ).toThrow();
});
test('backup contains original debt and its payments', async () => {
  value(await commit((await preview()).token));
  const { id } = h.db.prepare('SELECT id FROM suppliers').get() as {
    id: string;
  };
  value(
    await h.call('bengkelin:supplierPayables:recordPayment', {
      requestId: randomUUID(),
      supplierId: id,
      method: 'CASH',
      amount: '100000',
    }),
  );
  const backup = await h.services.backups.createValidatedBackup({
    kind: 'SAFETY',
  });
  const { openDatabase } = await import('@/main/database/connection');
  const db = openDatabase(path.join(h.dir, 'backups', backup.fileName));
  try {
    expect(db.prepare('SELECT external_id FROM suppliers').get()).toEqual({
      external_id: 'SU-1',
    });
    expect(
      db.prepare('SELECT amount FROM supplier_opening_payments').get(),
    ).toEqual({ amount: 100000n });
  } finally {
    db.close();
  }
});
test('logout and same-admin login during backup invalidate the original preview', async () => {
  const p = await preview();
  const original = h.services.backups.createValidatedBackup.bind(
    h.services.backups,
  );
  vi.spyOn(h.services.backups, 'createValidatedBackup').mockImplementationOnce(
    async (input) => {
      const backup = await original(input);
      value(await h.call(C.auth.logout));
      value(
        await h.call(C.auth.login, {
          username: 'admin',
          password: ADMIN_PASSWORD,
        }),
      );
      return backup;
    },
  );
  expect((await commit(p.token)).ok).toBe(false);
  expect(h.db.prepare('SELECT count(*) n FROM suppliers').get()).toEqual({
    n: 0n,
  });
});
test('restore rolls back later payments and keeps imported identity', async () => {
  value(await commit((await preview()).token));
  const { id } = h.db.prepare('SELECT id FROM suppliers').get() as {
    id: string;
  };
  const pay = (amount: string) =>
    h.call('bengkelin:supplierPayables:recordPayment', {
      requestId: randomUUID(),
      supplierId: id,
      method: 'CASH',
      amount,
    });
  value(await pay('100000'));
  const backup = await h.services.backups.createValidatedBackup({
    kind: 'SAFETY',
  });
  value(await pay('100'));
  restoreFile = path.join(h.dir, 'backups', backup.fileName);
  const inspection = value(await h.call<any>(C.backups.inspectRestore));
  value(
    await h.call(C.backups.restore, {
      token: inspection.preview.token,
      confirmed: true,
    }),
  );
  h.reopen();
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  const detail = value(
    await h.call<any>('bengkelin:supplierPayables:get', { supplierId: id }),
  );
  expect(detail.outstandingAmount).toBe('1283902694');
  expect(detail.payments).toHaveLength(1);
  expect(detail.externalId).toBe('SU-1');
});
test('opening repayments follow shop midnight and cashier filters', async () => {
  value(await commit((await preview()).token));
  const { id } = h.db.prepare('SELECT id FROM suppliers').get() as {
    id: string;
  };
  const actor = value(await h.call<any>(C.auth.currentSession));
  now = Date.parse('2026-10-31T16:59:59.999Z');
  value(
    await h.call('bengkelin:supplierPayables:recordPayment', {
      requestId: randomUUID(),
      supplierId: id,
      method: 'CASH',
      amount: '100',
    }),
  );
  now += 1;
  value(
    await h.call('bengkelin:supplierPayables:recordPayment', {
      requestId: randomUUID(),
      supplierId: id,
      method: 'BANK_TRANSFER',
      amount: '200',
    }),
  );
  const report = (date: string, cashierId?: string) =>
    h.call<any>(C.reports.daily, { date, ...(cashierId ? { cashierId } : {}) });
  expect(value(await report('2026-10-31')).purchasePayments.amount).toBe('100');
  expect(
    value(await report('2026-11-01', actor.cashierId)).purchasePayments.amount,
  ).toBe('200');
  const other = value(
    await h.call<any>(C.cashiers.create, {
      username: 'other',
      displayName: 'Other',
      password: 'other-cashier-password',
      role: 'CASHIER',
    }),
  );
  expect(
    value(await report('2026-11-01', other.id)).purchasePayments.amount,
  ).toBe('0');
});
test('expired previews and cashier import requests are rejected', async () => {
  const p = await preview();
  now += 31 * 60 * 1000;
  expect((await commit(p.token)).ok).toBe(false);
  value(
    await h.call(C.cashiers.create, {
      username: 'cashier',
      displayName: 'Cashier',
      password: 'cashier-password',
      role: 'CASHIER',
    }),
  );
  value(await h.call(C.auth.logout));
  value(
    await h.call(C.auth.login, {
      username: 'cashier',
      password: 'cashier-password',
    }),
  );
  expect((await h.call(channel + 'previewImport')).ok).toBe(false);
});
