import path from 'node:path';
import { openDatabase } from '@/main/database/connection';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { CHANNELS as C } from '@/shared/channels';
import type {
  CustomerOpeningDetail,
  CustomerOpeningPage,
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
let customerId: string;
beforeEach(async () => {
  h = createHarness();
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  customerId = randomUUID();
  h.db
    .prepare(
      'INSERT INTO customers (id,name,external_id,created_at,updated_at) VALUES (?,?,?,?,?)',
    )
    .run(
      customerId,
      'Alpha',
      'CU-1',
      '2026-09-30T03:00:00.000Z',
      '2026-09-30T03:00:00.000Z',
    );
  h.db
    .prepare(
      'INSERT INTO customer_opening_balances (customer_id,as_of_date,amount,created_at,imported_by_cashier_id) VALUES (?,?,?,?,?)',
    )
    .run(
      customerId,
      '2026-09-30',
      100000n,
      '2026-09-30T03:00:00.000Z',
      h.services.sessions.get(1)!.cashierId,
    );
});
afterEach(() => h.close());
const payment = (amount: string) => ({
  requestId: randomUUID(),
  customerId,
  method: 'CASH',
  amount,
});
test('repayment derives remaining debt, replays once and rejects overpayment', async () => {
  const input = payment('30000');
  const result = value(
    await h.call<CustomerOpeningDetail>(
      C.customerReceivables.recordPayment,
      input,
    ),
  );
  expect(result.outstandingAmount).toBe('70000');
  expect(
    value(await h.call(C.customerReceivables.recordPayment, input)),
  ).toEqual(result);
  expect(
    failure(await h.call(C.customerReceivables.recordPayment, payment('70001')))
      .code,
  ).toBe('PAYMENT_EXCEEDS_OUTSTANDING');
  expect(
    value(
      await h.call<CustomerOpeningDetail>(C.customerReceivables.get, {
        customerId,
      }),
    ).payments,
  ).toHaveLength(1);
});
test('competing full repayments permit one, paid records stay listed', async () => {
  const results = await Promise.all([
    h.call(C.customerReceivables.recordPayment, payment('100000')),
    h.call(C.customerReceivables.recordPayment, payment('100000')),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  const page = value(
    await h.call<CustomerOpeningPage>(C.customerReceivables.list, {}),
  );
  expect(page.items[0]!.paymentStatus).toBe('PAID');
  expect(page.totalOutstanding).toBe('0');
});
test('session and positive payment validation protect the API', async () => {
  expect(
    failure(await h.call(C.customerReceivables.get, { customerId }, 99)).code,
  ).toBe('UNAUTHENTICATED');
  for (const amount of ['0', '-1', '1.5', '9223372036854775808'])
    expect(
      failure(
        await h.call(C.customerReceivables.recordPayment, payment(amount)),
      ).code,
    ).toBe('VALIDATION_FAILED');
});
test('database protects immutable openings and append-only repayments', async () => {
  value(await h.call(C.customerReceivables.recordPayment, payment('30000')));
  expect(() =>
    h.db.prepare('UPDATE customer_opening_balances SET amount=1').run(),
  ).toThrow();
  expect(() =>
    h.db.prepare('DELETE FROM customer_opening_balances').run(),
  ).toThrow();
  expect(() =>
    h.db.prepare('UPDATE customer_opening_payments SET amount=1').run(),
  ).toThrow();
  expect(() =>
    h.db.prepare('DELETE FROM customer_opening_payments').run(),
  ).toThrow();
});
test('zero balances are paid and totals cover every page', async () => {
  const id = randomUUID();
  h.db
    .prepare(
      'INSERT INTO customers(id,name,created_at,updated_at) VALUES (?,?,?,?)',
    )
    .run(id, 'Zero', '2026-09-30T03:00:00.000Z', '2026-09-30T03:00:00.000Z');
  h.db
    .prepare('INSERT INTO customer_opening_balances VALUES (?,?,?,?,?)')
    .run(
      id,
      '2026-10-01',
      0n,
      '2026-09-30T03:00:00.000Z',
      h.services.sessions.get(1)!.cashierId,
    );
  const page = value(
    await h.call<CustomerOpeningPage>(C.customerReceivables.list, {
      page: { size: 1 },
    }),
  );
  expect(page.total).toBe(2);
  expect(page.totalOutstanding).toBe('100000');
  expect(page.hasMore).toBe(true);
  expect(
    value(
      await h.call<CustomerOpeningDetail>(C.customerReceivables.get, {
        customerId: id,
      }),
    ).paymentStatus,
  ).toBe('PAID');
});
test('validated backup preserves openings, payments and idempotency across restart', async () => {
  const input = payment('30000');
  const detail = value(
    await h.call<CustomerOpeningDetail>(
      C.customerReceivables.recordPayment,
      input,
    ),
  );
  const backup = await h.services.backups.createValidatedBackup({
    kind: 'SAFETY',
  });
  const restored = openDatabase(path.join(h.backupsDir, backup.fileName));
  try {
    expect(
      restored.prepare('SELECT amount FROM customer_opening_balances').get(),
    ).toEqual({ amount: 100000n });
    expect(
      restored.prepare('SELECT amount FROM customer_opening_payments').get(),
    ).toEqual({ amount: 30000n });
  } finally {
    restored.close();
  }
  h.reopen();
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  expect(
    value(await h.call(C.customerReceivables.recordPayment, input)),
  ).toEqual(detail);
  expect(
    value(
      await h.call<CustomerOpeningDetail>(C.customerReceivables.get, {
        customerId,
      }),
    ).outstandingAmount,
  ).toBe('70000');
});
