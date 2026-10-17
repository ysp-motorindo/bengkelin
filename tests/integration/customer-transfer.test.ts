import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CHANNELS as C } from '@/shared/channels';
import { noFileDialogs } from '@/main/features/printing/driver';
import { DomainError } from '@/shared/primitives';
import { formatCsv } from '@/main/features/csv/writer';
import { toInstant } from '@/shared/time';
import type {
  CustomerImportPreviewDto,
  CustomerImportSummaryDto,
} from '@/shared/contracts';
import {
  ADMIN_PASSWORD,
  createHarness,
  validSetup,
  value,
  failure,
  type Harness,
} from './helpers/harness';
let h: Harness;
let file: string;
let now: number;
const header = [
  'external_id',
  'name',
  'phone_number',
  'address',
  'city_or_regency',
  'is_active',
];
const row = ['CU-1', 'Alpha', '0812-000-12', 'Jl. "A", 1', 'Jakarta', 'true'];
beforeEach(async () => {
  now = Date.UTC(2026, 8, 30, 3);
  file = '';
  h = createHarness({
    clock: { now: () => toInstant(now) },
    dialogs: { ...noFileDialogs, chooseCsvFile: async () => file || null },
  });
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  file = path.join(h.dir, 'customers.csv');
  writeFileSync(file, formatCsv([header, row]));
});
afterEach(() => {
  vi.restoreAllMocks();
  h.close();
});
async function preview() {
  const p = value(
    await h.call<CustomerImportPreviewDto>(C.customerTransfer.previewImport),
  );
  if (p.outcome !== 'READY') throw new Error('cancelled');
  return p;
}
const count = () => h.db.prepare('SELECT count(*) AS n FROM customers').get();
test('actual IPC import preserves text, repeats and token replay across restart', async () => {
  const p = await preview();
  expect(p.canCommit).toBe(true);
  expect(p.summary.creates).toBe(1);
  const input = { token: p.token };
  const result = value(
    await h.call<CustomerImportSummaryDto>(
      C.customerTransfer.commitImport,
      input,
    ),
  );
  expect(result.creates).toBe(1);
  expect(
    h.db
      .prepare(
        'SELECT external_id, phone_number, address, is_active FROM customers',
      )
      .get(),
  ).toEqual({
    external_id: 'CU-1',
    phone_number: row[2],
    address: row[3],
    is_active: 1n,
  });
  expect(value(await h.call(C.customerTransfer.commitImport, input))).toEqual(
    result,
  );
  const p2 = await preview();
  expect(p2.summary.unchanged).toBe(1);
  value(await h.call(C.customerTransfer.commitImport, { token: p2.token }));
  expect(count()).toEqual({ n: 1n });
  h.reopen();
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  expect(value(await h.call(C.customerTransfer.commitImport, input))).toEqual(
    result,
  );
});
test('blank optional fields preserve data, status changes, distinct IDs never merge', async () => {
  let p = await preview();
  value(await h.call(C.customerTransfer.commitImport, { token: p.token }));
  writeFileSync(
    file,
    formatCsv([
      header,
      ['CU-1', '', '', '', '', 'false'],
      ['CU-2', 'Alpha', row[2], '', '', 'true'],
    ]),
  );
  p = await preview();
  expect(p.requiresDuplicatePhoneAcknowledgement).toBe(true);
  expect(
    failure(await h.call(C.customerTransfer.commitImport, { token: p.token }))
      .code,
  ).toBe('CUSTOMER_IMPORT_DUPLICATE_PHONES');
  value(
    await h.call(C.customerTransfer.commitImport, {
      token: p.token,
      acknowledgeDuplicatePhones: true,
    }),
  );
  expect(count()).toEqual({ n: 2n });
  expect(
    h.db
      .prepare(
        "SELECT name, phone_number, address, is_active FROM customers WHERE external_id='CU-1'",
      )
      .get(),
  ).toEqual({
    name: 'Alpha',
    phone_number: row[2],
    address: row[3],
    is_active: 0n,
  });
});
test.each([
  [[row, row], 'CUSTOMER_IMPORT_DUPLICATE_ID'],
  [[['', 'Name', '', '', '', 'true']], 'CUSTOMER_IMPORT_INVALID_ROW'],
  [[['X', 'Name', '', '', '', '0']], 'CUSTOMER_IMPORT_INVALID_ROW'],
  [[['X', '', '', '', '', 'true']], 'CUSTOMER_NAME_OR_PHONE_REQUIRED'],
  [[['X', 'A'.repeat(121), '', '', '', 'true']], 'CUSTOMER_IMPORT_INVALID_ROW'],
])('invalid rows block commit (%s)', async (rows, code) => {
  writeFileSync(file, formatCsv([header, ...rows]));
  const p = await preview();
  expect(p.canCommit).toBe(false);
  expect(p.errors.some((x) => x.error.code === code)).toBe(true);
  expect(
    failure(await h.call(C.customerTransfer.commitImport, { token: p.token }))
      .code,
  ).toBe('IMPORT_HAS_ERRORS');
  expect(count()).toEqual({ n: 0n });
});
test('expired and stale plans write nothing', async () => {
  let p = await preview();
  now += 30 * 60 * 1000;
  expect(
    failure(await h.call(C.customerTransfer.commitImport, { token: p.token }))
      .code,
  ).toBe('IMPORT_PREVIEW_EXPIRED');
  p = await preview();
  value(await h.call(C.customers.save, { name: 'Other' }));
  expect(
    failure(await h.call(C.customerTransfer.commitImport, { token: p.token }))
      .code,
  ).toBe('IMPORT_PREVIEW_STALE');
  expect(count()).toEqual({ n: 1n });
});
test('backup failure permits retry and concurrent same-token calls share one backup', async () => {
  const p = await preview();
  const spy = vi.spyOn(h.services.backups, 'createValidatedBackup');
  spy.mockRejectedValueOnce(new DomainError('BACKUP_FAILED'));
  expect(
    failure(await h.call(C.customerTransfer.commitImport, { token: p.token }))
      .code,
  ).toBe('IMPORT_BACKUP_FAILED');
  expect(count()).toEqual({ n: 0n });
  const [a, b] = await Promise.all([
    h.call(C.customerTransfer.commitImport, { token: p.token }),
    h.call(C.customerTransfer.commitImport, { token: p.token }),
  ]);
  expect(value(a)).toEqual(value(b));
  expect(spy).toHaveBeenCalledTimes(2);
  expect(count()).toEqual({ n: 1n });
});
test('customer writes while backup awaits make the preview stale', async () => {
  const p = await preview();
  const original = h.services.backups.createValidatedBackup.bind(
    h.services.backups,
  );
  vi.spyOn(h.services.backups, 'createValidatedBackup').mockImplementation(
    async (input) => {
      value(
        await h.call(C.customers.save, {
          name: 'Collision',
          phoneNumber: row[2],
        }),
      );
      return original(input);
    },
  );
  expect(
    failure(await h.call(C.customerTransfer.commitImport, { token: p.token }))
      .code,
  ).toBe('IMPORT_PREVIEW_STALE');
  expect(count()).toEqual({ n: 1n });
});
test('write failure rolls back all customers and receipt', async () => {
  writeFileSync(
    file,
    formatCsv([header, row, ['CU-2', 'Beta', '', '', '', 'true']]),
  );
  const p = await preview();
  h.db.exec(
    "CREATE TRIGGER fail_second BEFORE INSERT ON customers WHEN NEW.external_id = 'CU-2' BEGIN SELECT RAISE(ABORT, 'fail'); END;",
  );
  expect(
    (await h.call(C.customerTransfer.commitImport, { token: p.token })).ok,
  ).toBe(false);
  expect(count()).toEqual({ n: 0n });
  expect(
    h.db
      .prepare('SELECT * FROM command_receipts WHERE request_id=?')
      .get(p.token),
  ).toBeUndefined();
});
test('permissions, actor binding and logout during backup are enforced', async () => {
  expect(
    failure(await h.call(C.customerTransfer.previewImport, undefined, 99)).code,
  ).toBe('UNAUTHENTICATED');
  value(
    await h.call(C.cashiers.create, {
      username: 'cashier',
      displayName: 'Cashier',
      password: 'password-123',
      role: 'CASHIER',
    }),
  );
  value(
    await h.call(
      C.auth.login,
      { username: 'cashier', password: 'password-123' },
      2,
    ),
  );
  expect(
    failure(await h.call(C.customerTransfer.previewImport, undefined, 2)).code,
  ).toBe('FORBIDDEN');
  const p = await preview();
  const original = h.services.backups.createValidatedBackup.bind(
    h.services.backups,
  );
  vi.spyOn(h.services.backups, 'createValidatedBackup').mockImplementation(
    async (input) => {
      h.services.sessions.endWindow(1);
      return original(input);
    },
  );
  expect(
    failure(await h.call(C.customerTransfer.commitImport, { token: p.token }))
      .code,
  ).toBe('UNAUTHENTICATED');
  expect(count()).toEqual({ n: 0n });
});

test('phone warnings reflect final state when imported customers exchange phones', async () => {
  writeFileSync(
    file,
    formatCsv([header, row, ['CU-2', 'Beta', '0813-200', '', '', 'true']]),
  );
  let p = await preview();
  value(await h.call(C.customerTransfer.commitImport, { token: p.token }));
  writeFileSync(
    file,
    formatCsv([
      header,
      ['CU-1', '', '0813-200', '', '', 'true'],
      ['CU-2', '', row[2], '', '', 'true'],
    ]),
  );
  p = await preview();
  expect(p.warnings).toEqual([]);
  value(await h.call(C.customerTransfer.commitImport, { token: p.token }));
});
test('formula guards are reversible for plus phones and literal apostrophes', async () => {
  writeFileSync(
    file,
    '\uFEFF' +
      header.join(',') +
      "\r\nX,''literal,'+6281200,\"'=address\",,true\r\n",
  );
  const p = await preview();
  expect(p.errors).toEqual([]);
  value(await h.call(C.customerTransfer.commitImport, { token: p.token }));
  expect(
    h.db.prepare('SELECT name,phone_number,address FROM customers').get(),
  ).toEqual({
    name: "'literal",
    phone_number: '+6281200',
    address: '=address',
  });
});
test('expiry during backup and a different admin cannot commit or replay', async () => {
  const p = await preview();
  value(
    await h.call(C.cashiers.create, {
      username: 'other',
      displayName: 'Other',
      password: 'password-123',
      role: 'ADMIN',
    }),
  );
  value(
    await h.call(
      C.auth.login,
      { username: 'other', password: 'password-123' },
      2,
    ),
  );
  expect(
    failure(
      await h.call(C.customerTransfer.commitImport, { token: p.token }, 2),
    ).code,
  ).toBe('IMPORT_PREVIEW_EXPIRED');
  const original = h.services.backups.createValidatedBackup.bind(
    h.services.backups,
  );
  vi.spyOn(h.services.backups, 'createValidatedBackup').mockImplementation(
    async (input) => {
      now += 30 * 60 * 1000;
      return original(input);
    },
  );
  expect(
    failure(await h.call(C.customerTransfer.commitImport, { token: p.token }))
      .code,
  ).toBe('IMPORT_PREVIEW_EXPIRED');
  expect(count()).toEqual({ n: 0n });
});
test('cancelled, malformed, invalid UTF-8, header and size failures are previews without writes', async () => {
  file = '';
  expect(value(await h.call(C.customerTransfer.previewImport))).toEqual({
    outcome: 'CANCELLED',
  });
  file = path.join(h.dir, 'bad.csv');
  for (const [bytes, code] of [
    [Buffer.from([0xff]), 'INVALID_ENCODING'],
    [Buffer.from('a,b\r\n"unterminated'), 'MALFORMED_CSV'],
    [Buffer.from('external_id,name\r\nX,Name\r\n'), 'CUSTOMER_IMPORT_HEADER'],
    [Buffer.alloc(5 * 1024 * 1024 + 1), 'FILE_TOO_LARGE'],
  ] as const) {
    writeFileSync(file, bytes);
    const p = await preview();
    expect(p.canCommit).toBe(false);
    expect(p.errors[0]?.error.code).toBe(code);
  }
  expect(count()).toEqual({ n: 0n });
});
