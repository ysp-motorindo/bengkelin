import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CHANNELS as C } from '@/shared/channels';
import type {
  ReferenceDto,
  ReferenceImportPreviewDto,
} from '@/shared/contracts';
import { noFileDialogs } from '@/main/features/printing/driver';
import {
  ADMIN_PASSWORD,
  createHarness,
  failure,
  validSetup,
  value,
  type Harness,
} from './helpers/harness';

let h: Harness;
let file: string;
beforeEach(async () => {
  file = '';
  h = createHarness({
    dialogs: { ...noFileDialogs, chooseCsvFile: async () => file || null },
  });
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  h.close();
});
const save = (code: string, label: string, isDefault = false) =>
  h.call<ReferenceDto>(C.references.save, {
    entity: 'stockLocation',
    code,
    label,
    isDefault,
  });
async function preview(
  csv = 'code,name,is_active,is_default\n01,Gudang,true,true\n',
) {
  file = path.join(h.dir, 'locations.csv');
  writeFileSync(file, csv);
  const p = value(
    await h.call<ReferenceImportPreviewDto>(C.referenceTransfer.previewImport, {
      entity: 'stockLocation',
    }),
  );
  if (p.outcome !== 'READY') throw new Error('cancelled');
  return p;
}
const commit = (token: string) =>
  h.call(C.referenceTransfer.commitImport, { token });

test('fresh locations are empty and other references report false defaults', async () => {
  expect(
    value(await h.call(C.references.list, { entity: 'stockLocation' })),
  ).toEqual([]);
  const unit = value(
    await h.call<ReferenceDto>(C.references.save, {
      entity: 'unit',
      code: 'TEST_CRATE',
      label: 'Test crate',
    }),
  );
  expect(unit.isDefault).toBe(false);
});
test('locations preserve codes while labels and nonexclusive defaults are editable', async () => {
  const a = value(await save('01', 'Gudang', true));
  expect(a).toMatchObject({
    code: '01',
    label: 'Gudang',
    isDefault: true,
    isActive: true,
  });
  value(await save('B', 'Branch', true));
  expect(
    failure(
      await h.call(C.references.save, {
        entity: 'stockLocation',
        id: a.id,
        code: '02',
        label: 'Changed',
        isDefault: true,
      }),
    ).code,
  ).toBe('REFERENCE_CODE_IMMUTABLE');
  const edited = value(
    await h.call<ReferenceDto>(C.references.save, {
      entity: 'stockLocation',
      id: a.id,
      label: 'Renamed',
      isDefault: false,
    }),
  );
  expect(edited).toMatchObject({
    code: '01',
    label: 'Renamed',
    isDefault: false,
  });
  expect(() =>
    h.db
      .prepare('UPDATE stock_locations SET code = ? WHERE id = ?')
      .run('02', a.id),
  ).toThrow();
  expect(() =>
    h.db.prepare('DELETE FROM stock_locations WHERE id = ?').run(a.id),
  ).toThrow();
});
test('only admins manage locations and signed-in cashiers list active locations', async () => {
  const a = value(await save('A', 'Alpha'));
  value(
    await h.call(C.cashiers.create, {
      username: 'staff',
      displayName: 'Staff',
      password: 'staff-password-1',
      role: 'CASHIER',
    }),
  );
  value(
    await h.call(
      C.auth.login,
      { username: 'staff', password: 'staff-password-1' },
      2,
    ),
  );
  expect(
    failure(
      await h.call(
        C.references.save,
        { entity: 'stockLocation', code: 'B', label: 'Beta', isDefault: false },
        2,
      ),
    ).code,
  ).toBe('FORBIDDEN');
  expect(
    failure(await h.call(C.references.list, { entity: 'stockLocation' }, 2))
      .code,
  ).toBe('FORBIDDEN');
  expect(
    value(
      await h.call(C.references.listActive, { entity: 'stockLocation' }, 2),
    ),
  ).toEqual([a]);
  value(
    await h.call(C.references.deactivate, {
      entity: 'stockLocation',
      id: a.id,
    }),
  );
  expect(
    value(
      await h.call(C.references.listActive, { entity: 'stockLocation' }, 2),
    ),
  ).toEqual([]);
});
test('resolver selects renamed non-01 defaults deterministically and rejects inactive explicit IDs', async () => {
  value(await save('Z', 'Aardvark'));
  const beta = value(await save('B', 'beta', true));
  const alphaZ = value(await save('Z2', 'Alpha', true));
  const alphaA = value(await save('A', 'alpha', true));
  const { resolveStockLocation, requireActiveStockLocation } =
    await import('@/main/features/references/stock-locations');
  expect(resolveStockLocation(h.db)).toEqual({
    id: alphaA.id,
    code: 'A',
    label: 'alpha',
  });
  value(
    await h.call(C.references.deactivate, {
      entity: 'stockLocation',
      id: alphaA.id,
    }),
  );
  expect(resolveStockLocation(h.db).id).toBe(alphaZ.id);
  expect(() => requireActiveStockLocation(h.db, alphaA.id)).toThrow(
    expect.objectContaining({ code: 'STOCK_LOCATION_INACTIVE' }),
  );
  expect(() => resolveStockLocation(h.db, 'missing')).toThrow(
    expect.objectContaining({ code: 'STOCK_LOCATION_NOT_FOUND' }),
  );
  expect(resolveStockLocation(h.db, beta.id).id).toBe(beta.id);
});
test('resolver falls back to first active location and errors without any active locations', async () => {
  const a = value(await save('X', 'Renamed depot'));
  const { resolveStockLocation } =
    await import('@/main/features/references/stock-locations');
  expect(resolveStockLocation(h.db).id).toBe(a.id);
  value(
    await h.call(C.references.deactivate, {
      entity: 'stockLocation',
      id: a.id,
    }),
  );
  expect(() => resolveStockLocation(h.db)).toThrow(
    expect.objectContaining({ code: 'STOCK_LOCATION_REQUIRED' }),
  );
});
test('location CSV imports exact codes/defaults and supports updates and replay', async () => {
  const p = await preview();
  expect(p.canCommit).toBe(true);
  const result = value(await commit(p.token));
  expect(value(await commit(p.token))).toEqual(result);
  expect(
    h.db.prepare('SELECT code, label, is_default FROM stock_locations').get(),
  ).toEqual({ code: '01', label: 'Gudang', is_default: 1n });
  const update = await preview(
    'code,name,is_active,is_default\n01,Renamed,false,false\n',
  );
  expect(update.summary.updates).toBe(1);
  value(await commit(update.token));
  expect(
    h.db
      .prepare('SELECT code, label, is_active, is_default FROM stock_locations')
      .get(),
  ).toEqual({ code: '01', label: 'Renamed', is_active: 0n, is_default: 0n });
});
test('location CSV rejects invalid default flags and duplicate codes atomically', async () => {
  for (const csv of [
    'code,name,is_active,is_default\n01,Gudang,true,yes\n',
    'code,name,is_active,is_default\n01,Gudang,true,true\n01,Other,true,false\n',
  ]) {
    const p = await preview(csv);
    expect(p.canCommit).toBe(false);
    expect(failure(await commit(p.token)).code).toBe('IMPORT_HAS_ERRORS');
  }
  expect(
    value(await h.call(C.references.list, { entity: 'stockLocation' })),
  ).toEqual([]);
});
test('location import detects changed defaults and deactivation during its safety backup', async () => {
  const a = value(await save('01', 'Gudang', true));
  const p = await preview();
  vi.spyOn(h.services.backups, 'createValidatedBackup').mockImplementationOnce(
    async () => {
      value(
        await h.call(C.references.deactivate, {
          entity: 'stockLocation',
          id: a.id,
        }),
      );
      return { fileName: 'safety.sqlite' } as Awaited<
        ReturnType<typeof h.services.backups.createValidatedBackup>
      >;
    },
  );
  expect(failure(await commit(p.token)).code).toBe('IMPORT_PREVIEW_STALE');
});
