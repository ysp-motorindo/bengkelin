import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { noFileDialogs } from '@/main/features/printing/driver';
import { CHANNELS as C } from '@/shared/channels';
import type {
  CatalogFileOutcomeDto,
  ImportPreviewDto,
  ReferenceDto,
} from '@/shared/contracts';
import {
  ADMIN_PASSWORD,
  createHarness,
  failure,
  validSetup,
  value,
  type Harness,
} from './helpers/harness';
import { parseCsv } from './helpers/csv';
let h: Harness;
let input: string;
let output: string;
let location: ReferenceDto;
beforeEach(async () => {
  h = createHarness({
    dialogs: {
      ...noFileDialogs,
      chooseCsvFile: async () => input,
      chooseCsvDestination: async () => output,
    },
  });
  input = path.join(h.dir, 'in.csv');
  output = path.join(h.dir, 'out.csv');
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  location = value(
    await h.call<ReferenceDto>(C.references.save, {
      entity: 'stockLocation',
      code: '01',
      label: 'Renamed depot',
      isDefault: true,
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  h.close();
});
async function preview(csv: string) {
  writeFileSync(input, csv);
  const p = value(
    await h.call<ImportPreviewDto>(C.catalogTransfer.previewImport),
  );
  if (p.outcome !== 'READY') throw new Error('cancelled');
  return p;
}
const commit = (token: string) =>
  h.call(C.catalogTransfer.commitImport, { token });
test('tracked imports require an exact active code, rejecting missing and damaged leading zeros', async () => {
  for (const code of ['', 'unknown', '1', '1.0', '1E0']) {
    const p = await preview(
      `sku,title,type,unit,stock_location,opening_stock\nOIL,Oil,STOCK_ITEM,PCS,${code},5\n`,
    );
    expect(p.canCommit, code).toBe(false);
    expect(p.errors.some((e) => e.column === 'stock_location')).toBe(true);
    expect(failure(await commit(p.token)).code).toBe('IMPORT_HAS_ERRORS');
  }
  const missing = await preview(
    'sku,title,type,unit\nOIL,Oil,STOCK_ITEM,PCS\n',
  );
  expect(missing.canCommit).toBe(false);
  value(
    await h.call(C.references.deactivate, {
      entity: 'stockLocation',
      id: location.id,
    }),
  );
  const inactive = await preview(
    'sku,title,type,unit,stock_location\nOIL,Oil,STOCK_ITEM,PCS,01\n',
  );
  expect(inactive.canCommit).toBe(false);
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM catalog_items').get()).toEqual(
    { n: 0n },
  );
});
test('location import resolves 01, permits blank service codes and rejects tracked updates without location', async () => {
  const p = await preview(
    'sku,title,type,unit,stock_location,opening_stock\nOIL,Oil,STOCK_ITEM,PCS,01,5\nSVC,Service,SERVICE,SERVICE,,\n',
  );
  expect(p.canCommit).toBe(true);
  expect(p.rows[0]!.stockLocation).toEqual({
    id: location.id,
    code: '01',
    label: 'Renamed depot',
  });
  value(await commit(p.token));
  expect(
    h.db
      .prepare(
        'SELECT stock_location_id,quantity_delta FROM stock_ledger_entries',
      )
      .get(),
  ).toEqual({ stock_location_id: location.id, quantity_delta: 5n });
  const update = await preview('sku,title\nOIL,New title\n');
  expect(update.canCommit).toBe(false);
});
test('location changes during safety backup invalidate a catalog preview atomically', async () => {
  const p = await preview(
    'sku,title,type,unit,stock_location,opening_stock\nOIL,Oil,STOCK_ITEM,PCS,01,5\n',
  );
  expect(p.canCommit).toBe(true);
  vi.spyOn(h.services.backups, 'createValidatedBackup').mockImplementationOnce(
    async () => {
      value(
        await h.call(C.references.deactivate, {
          entity: 'stockLocation',
          id: location.id,
        }),
      );
      return { fileName: 'safety.sqlite' } as Awaited<
        ReturnType<typeof h.services.backups.createValidatedBackup>
      >;
    },
  );
  expect(failure(await commit(p.token)).code).toBe('IMPORT_PREVIEW_STALE');
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM catalog_items').get()).toEqual(
    { n: 0n },
  );
});
test('export scopes quantities to the selected location and reimport never creates opening stock', async () => {
  const p = await preview(
    'sku,title,type,unit,stock_location,opening_stock\nOIL,Oil,STOCK_ITEM,PCS,01,5\n',
  );
  value(await commit(p.token));
  const other = value(
    await h.call<ReferenceDto>(C.references.save, {
      entity: 'stockLocation',
      code: 'B',
      label: 'Branch',
      isDefault: false,
    }),
  );
  const result = value(
    await h.call<CatalogFileOutcomeDto>(C.catalogTransfer.exportCatalog, {
      stockLocationId: other.id,
    }),
  );
  expect(result.outcome).toBe('SAVED');
  const csv = readFileSync(output, 'utf8');
  const records = parseCsv(csv);
  const header = records[0]!;
  const row = records[1]!;
  expect(row[header.indexOf('stock_location')]).toBe('B');
  expect(row[header.indexOf('current_stock')]).toBe('0');
  expect(row[header.indexOf('opening_stock')]).toBe('');
  const repeat = await preview(csv);
  expect(repeat.canCommit).toBe(true);
  value(await commit(repeat.token));
  expect(
    h.db.prepare('SELECT COUNT(*) AS n FROM stock_ledger_entries').get(),
  ).toEqual({ n: 1n });
});
test('template uses renamed configured locations and errors without active locations', async () => {
  value(await h.call(C.catalogTransfer.downloadTemplate));
  const rows = parseCsv(readFileSync(output, 'utf8'));
  expect(rows[1]![rows[0]!.indexOf('stock_location')]).toBe('01');
  value(
    await h.call(C.references.deactivate, {
      entity: 'stockLocation',
      id: location.id,
    }),
  );
  expect(failure(await h.call(C.catalogTransfer.downloadTemplate)).code).toBe(
    'STOCK_LOCATION_REQUIRED',
  );
});
