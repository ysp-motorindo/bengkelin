import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CHANNELS as C } from '@/shared/channels';
import { noFileDialogs } from '@/main/features/printing/driver';
import { formatCsv } from '@/main/features/csv/writer';
import { toInstant } from '@/shared/time';
import type {
  ReferenceImportPreviewDto,
  ReferenceImportSummaryDto,
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
const header = ['code', 'name', 'address', 'city', 'phone_number', 'is_active'];
const row = ['001', 'Alpha', 'Street', 'Bandung', '0812', 'true'];
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
  file = path.join(h.dir, 'sales.csv');
  writeFileSync(file, formatCsv([header, row]));
});
afterEach(() => {
  vi.restoreAllMocks();
  h.close();
});
async function preview(entity: 'sales' | 'expedition' = 'sales') {
  const p = value(
    await h.call<ReferenceImportPreviewDto>(C.referenceTransfer.previewImport, {
      entity,
    }),
  );
  if (p.outcome !== 'READY') throw new Error('cancelled');
  return p;
}
const commit = (token: string) =>
  h.call<ReferenceImportSummaryDto>(C.referenceTransfer.commitImport, {
    token,
  });
test('imports text codes, preserves blanks, repeats and replays after restart', async () => {
  const p = await preview();
  expect(p.summary.creates).toBe(1);
  const first = value(await commit(p.token));
  expect(value(await commit(p.token))).toEqual(first);
  writeFileSync(
    file,
    formatCsv([header, ['001', 'Renamed', '', '', '', 'false']]),
  );
  const update = await preview();
  expect(update.summary.updates).toBe(1);
  value(await commit(update.token));
  expect(
    h.db
      .prepare(
        'SELECT code, label, address, phone_number, is_active FROM sales',
      )
      .get(),
  ).toEqual({
    code: '001',
    label: 'Renamed',
    address: 'Street',
    phone_number: '0812',
    is_active: 0n,
  });
  const repeat = await preview();
  expect(repeat.summary.unchanged).toBe(1);
  value(await commit(repeat.token));
  h.reopen();
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  expect(value(await commit(p.token))).toEqual(first);
});
test('rejects duplicates, strict headers, blank names and invalid status', async () => {
  for (const records of [
    [header, row, row],
    [
      [...header, 'unknown'],
      [...row, 'x'],
    ],
    [header, ['002', '', '', '', '', 'true']],
    [header, ['002', 'Name', '', '', '', 'yes']],
  ]) {
    writeFileSync(file, formatCsv(records));
    const p = await preview();
    expect(p.canCommit).toBe(false);
    expect(failure(await commit(p.token)).code).toBe('IMPORT_HAS_ERRORS');
  }
});
test('checks stale masters before and after safety backup and supports cancellation/expiry', async () => {
  const p = await preview();
  vi.spyOn(h.services.backups, 'createValidatedBackup').mockImplementationOnce(
    async () => {
      h.db
        .prepare(
          "INSERT INTO sales (id, code, label, created_at, updated_at) VALUES ('id', 'X', 'Changed', 'now', 'now')",
        )
        .run();
      return { fileName: 'safety.sqlite' } as never;
    },
  );
  expect(failure(await commit(p.token)).code).toBe('IMPORT_PREVIEW_STALE');
  const expired = await preview();
  now += 31 * 60_000;
  expect(failure(await commit(expired.token)).code).toBe(
    'IMPORT_PREVIEW_EXPIRED',
  );
  file = '';
  expect(
    value(await h.call(C.referenceTransfer.previewImport, { entity: 'sales' })),
  ).toEqual({ outcome: 'CANCELLED' });
});
test('backup failure prevents writes and expedition uses its own code namespace', async () => {
  const p = await preview();
  vi.spyOn(h.services.backups, 'createValidatedBackup').mockRejectedValueOnce(
    new Error('disk full'),
  );
  expect(failure(await commit(p.token)).code).toBe('IMPORT_BACKUP_FAILED');
  expect(h.db.prepare('SELECT count(*) n FROM sales').get()).toEqual({ n: 0n });
  value(await commit(p.token));
  writeFileSync(
    file,
    formatCsv([
      header.filter((x) => x !== 'phone_number'),
      row.filter((_, i) => i !== 4),
    ]),
  );
  const e = await preview('expedition');
  expect(e.summary.creates).toBe(1);
  value(await commit(e.token));
});

test('atomic rollback, retry and concurrent request protection', async () => {
  writeFileSync(
    file,
    formatCsv([header, row, ['002', 'Beta', '', '', '', 'true']]),
  );
  const p = await preview();
  h.db.exec(
    "CREATE TRIGGER import_failure BEFORE INSERT ON sales WHEN NEW.code = '002' BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
  );
  expect((await commit(p.token)).ok).toBe(false);
  expect(h.db.prepare('SELECT count(*) n FROM sales').get()).toEqual({ n: 0n });
  h.db.exec('DROP TRIGGER import_failure');
  const results = await Promise.all([commit(p.token), commit(p.token)]);
  expect(value(results[0]!)).toEqual(value(results[1]!));
  expect(h.db.prepare('SELECT count(*) n FROM sales').get()).toEqual({ n: 2n });
});
test('cashiers cannot preview, commit or download templates', async () => {
  value(
    await h.call(C.cashiers.create, {
      username: 'cashier',
      displayName: 'Cashier',
      password: 'cashier-password',
      role: 'CASHIER',
    }),
  );
  value(
    await h.call(
      C.auth.login,
      { username: 'cashier', password: 'cashier-password' },
      2,
    ),
  );
  const p = await preview();
  for (const [channel, input] of [
    [C.referenceTransfer.previewImport, { entity: 'sales' }],
    [C.referenceTransfer.commitImport, { token: p.token }],
    [C.referenceTransfer.downloadTemplate, { entity: 'sales' }],
  ] as const) {
    expect(failure(await h.call(channel, input, 2)).code).toBe('FORBIDDEN');
  }
});
test('supplied CSVs import every row and repeat unchanged', async () => {
  for (const [entity, name, count] of [
    ['sales', 'sales', 4],
    ['expedition', 'ekspedisi', 26],
  ] as const) {
    file = path.resolve(`references/${name}-import.csv`);
    const p = await preview(entity);
    expect(p.errors).toEqual([]);
    expect(p.summary.creates).toBe(count);
    value(await commit(p.token));
    const again = await preview(entity);
    expect(again.summary).toEqual({ creates: 0, updates: 0, unchanged: count });
  }
});

test('stale previews reject before backup, tokens are bound to their admin', async () => {
  const p = await preview();
  value(
    await h.call(C.references.save, {
      entity: 'sales',
      code: 'OTHER',
      label: 'Other',
    }),
  );
  const backup = vi.spyOn(h.services.backups, 'createValidatedBackup');
  expect(failure(await commit(p.token)).code).toBe('IMPORT_PREVIEW_STALE');
  expect(backup).not.toHaveBeenCalled();
  const owned = await preview();
  value(
    await h.call(C.cashiers.create, {
      username: 'admin2',
      displayName: 'Admin 2',
      password: 'another-password',
      role: 'ADMIN',
    }),
  );
  value(
    await h.call(
      C.auth.login,
      { username: 'admin2', password: 'another-password' },
      2,
    ),
  );
  expect(
    failure(
      await h.call(C.referenceTransfer.commitImport, { token: owned.token }, 2),
    ).code,
  ).toBe('IMPORT_PREVIEW_EXPIRED');
});
test('enforces size limit, normalized duplicate codes and formula protection', async () => {
  writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 1));
  expect((await preview()).errors[0]!.error.code).toBe('FILE_TOO_LARGE');
  writeFileSync(
    file,
    formatCsv([
      header,
      ['a01', 'One', '', '', '', 'true'],
      ['A01', 'Two', '', '', '', 'true'],
    ]),
  );
  expect(
    (await preview()).errors.some(
      (e) => e.error.code === 'REFERENCE_IMPORT_DUPLICATE_CODE',
    ),
  ).toBe(true);
  writeFileSync(
    file,
    formatCsv([header, ['001', '=Name', '+Address', '@City', '0812', 'true']]),
  );
  const p = await preview();
  expect(p.canCommit).toBe(true);
  value(await commit(p.token));
  expect(h.db.prepare('SELECT label, address, city FROM sales').get()).toEqual({
    label: '=Name',
    address: '+Address',
    city: '@City',
  });
});
