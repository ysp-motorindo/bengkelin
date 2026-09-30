import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openDatabase } from '@/main/database/connection';
import {
  bundledMigrations,
  latestBundledVersion,
  migrateDatabase,
} from '@/main/database/migrate';
import {
  recordRestoreNotice,
  restoreNoticePath,
} from '@/main/features/backups/restore-notice';
import {
  routePrintsToPdf,
  testPrintToPdfDir,
} from '@/main/features/printing/test-print-route';
import { installCrashLogging } from '@/main/platform/crash-logging';
import type { Logger } from '@/main/platform/logger';
import { CHANNELS } from '@/shared/channels';
import type {
  AboutDto,
  AdHocReferenceDto,
  CashierNameDto,
  CatalogItemDto,
  DraftView,
  InvoiceView,
  ReferenceDto,
  RestoreNoticeDto,
  SaveVehicleResult,
  VehicleDto,
} from '@/shared/contracts';
import { toInstant } from '@/shared/time';
import { FakePrintDriver } from './helpers/fake-print';
import {
  ADMIN_PASSWORD,
  createHarness,
  failure,
  validSetup,
  value,
  type Harness,
} from './helpers/harness';

/**
 * Task 17 carried items: migration-outcome and crash logging, the About
 * data, names-only cashier listing, ad-hoc reference administration,
 * vehicle deactivation, the one-time restore notice, the menu context and
 * the test-only print-to-PDF route.
 */

const C = CHANNELS;
const ADMIN = 1;
const CASHIER = 2;
const NOBODY = 99;
const T0 = Date.UTC(2026, 8, 30, 3, 0, 0);

let h: Harness;
let nowMs = T0;
let counter = 0;
let bengkel: string;

const uuid = () => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};

beforeEach(async () => {
  nowMs = T0;
  counter = 0;
  h = createHarness({ clock: { now: () => toInstant(nowMs) } });
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(
      C.auth.login,
      { username: 'admin', password: ADMIN_PASSWORD },
      ADMIN,
    ),
  );
  value(
    await h.call(
      C.cashiers.create,
      {
        username: 'siti',
        displayName: 'Siti',
        password: 'siti-password-1',
        role: 'CASHIER',
      },
      ADMIN,
    ),
  );
  value(
    await h.call(
      C.auth.login,
      { username: 'siti', password: 'siti-password-1' },
      CASHIER,
    ),
  );
  bengkel = value(
    await h.call<ReferenceDto[]>(C.references.list, { entity: 'channel' }),
  ).find((c) => c.code === 'BENGKEL')!.id;
});
afterEach(() => h.close());

const rows = (sql: string, ...params: unknown[]) =>
  h.db.prepare(sql).all(...params) as Record<string, unknown>[];

async function newDraft(windowId = CASHIER) {
  return value(
    await h.call<DraftView>(
      C.drafts.create,
      {
        requestId: uuid(),
        channelId: bengkel,
        invoiceDate: '2026-09-30',
        pricingAt: toInstant(nowMs),
      },
      windowId,
    ),
  );
}

async function apply(
  draft: { id: string; version: number },
  op: Record<string, unknown>,
  windowId = CASHIER,
) {
  return h.call<DraftView>(
    C.drafts.apply,
    {
      requestId: uuid(),
      invoiceId: draft.id,
      expectedVersion: draft.version,
      op,
    },
    windowId,
  );
}

function memoryLogger() {
  const entries: { level: string; event: string; fields: unknown }[] = [];
  const logger: Logger = {
    info: (event, fields) => entries.push({ level: 'info', event, fields }),
    warn: (event, fields) => entries.push({ level: 'warn', event, fields }),
    error: (event, fields) => entries.push({ level: 'error', event, fields }),
  };
  return { entries, logger };
}

// ---------------------------------------------------------------------------

describe('a. logging (spec 46/48)', () => {
  test('migrateDatabase reports {from, to, applied}', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bengkelin-t17-mig-'));
    try {
      const db = openDatabase(path.join(dir, 'db.sqlite'));
      const partial = migrateDatabase(
        db,
        bundledMigrations.filter((m) => m.version <= 3),
      );
      expect(partial).toEqual({ from: 0, to: 3, applied: [1, 2, 3] });
      const rest = migrateDatabase(db);
      expect(rest.from).toBe(3);
      expect(rest.to).toBe(latestBundledVersion);
      expect(rest.applied).toEqual(
        bundledMigrations.filter((m) => m.version > 3).map((m) => m.version),
      );
      expect(migrateDatabase(db)).toEqual({
        from: latestBundledVersion,
        to: latestBundledVersion,
        applied: [],
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uncaught exceptions, unhandled rejections and gone processes are logged sanitized', () => {
    const proc = new EventEmitter();
    const app = new EventEmitter();
    const { entries, logger } = memoryLogger();
    const fatal: string[] = [];
    installCrashLogging({
      process: proc,
      app,
      logger,
      onUncaughtException: (error) => fatal.push(error.message),
    });

    const boom = Object.assign(new Error('boom for 0812-3456'), {
      code: 'EBOOM',
    });
    proc.emit('uncaughtException', boom, 'uncaughtException');
    proc.emit('unhandledRejection', 'plain reason', Promise.resolve());
    app.emit(
      'render-process-gone',
      {},
      { id: 7 },
      { reason: 'crashed', exitCode: 139 },
    );
    app.emit(
      'child-process-gone',
      {},
      { type: 'GPU', reason: 'oom', exitCode: 1, name: 'secret-name' },
    );

    expect(fatal).toEqual(['boom for 0812-3456']);
    expect(entries.map((e) => [e.level, e.event])).toEqual([
      ['error', 'process.uncaught_exception'],
      ['error', 'process.unhandled_rejection'],
      ['error', 'process.render_process_gone'],
      ['error', 'process.child_process_gone'],
    ]);
    expect(entries[0]!.fields).toMatchObject({
      error: { errorType: 'Error', code: 'EBOOM' },
    });
    expect(entries[2]!.fields).toEqual({
      webContentsId: 7,
      reason: 'crashed',
      exitCode: 139,
    });
    // Only small, known fields: no process names or payloads.
    expect(entries[3]!.fields).toEqual({
      processType: 'GPU',
      reason: 'oom',
      exitCode: 1,
    });
  });
});

describe('About data and the menu context', () => {
  test('about: application and schema version, readable before login', async () => {
    const about = value(await h.call<AboutDto>(C.app.about, undefined, NOBODY));
    expect(about).toEqual({
      appVersion: expect.any(String),
      schemaVersion: latestBundledVersion,
    });
  });

  test('the renderer reports its printable context; per window, signed in only', async () => {
    expect(h.services.menu.get(CASHIER)).toEqual({ printable: false });
    const changes: number[] = [];
    h.services.menu.onChange((windowId) => changes.push(windowId));
    value(await h.call(C.app.setMenuContext, { printable: true }, CASHIER));
    expect(h.services.menu.get(CASHIER)).toEqual({ printable: true });
    expect(h.services.menu.get(ADMIN)).toEqual({ printable: false });
    expect(changes).toEqual([CASHIER]);
    expect(
      failure(await h.call(C.app.setMenuContext, { printable: 1 }, CASHIER))
        .code,
    ).toBe('VALIDATION_FAILED');
    // No session: the context is ignored (nothing printable before login).
    value(await h.call(C.app.setMenuContext, { printable: true }, NOBODY));
    expect(h.services.menu.get(NOBODY)).toEqual({ printable: false });
  });

  test('session changes are observable (menu rebuilds on login/logout)', async () => {
    const seen: string[] = [];
    h.services.sessions.onChange((windowId) => seen.push(`w${windowId}`));
    value(await h.call(C.auth.logout, undefined, CASHIER));
    value(
      await h.call(
        C.auth.login,
        { username: 'siti', password: 'siti-password-1' },
        CASHIER,
      ),
    );
    expect(seen).toEqual(['w2', 'w2']);
  });
});

describe('d. names-only cashier listing', () => {
  test('any session lists names (no usernames, roles or hashes); ADMIN list stays ADMIN-only', async () => {
    const names = value(
      await h.call<CashierNameDto[]>(C.cashiers.listNames, undefined, CASHIER),
    );
    expect(names.map((c) => c.displayName).sort()).toEqual([
      'Pak Budi',
      'Siti',
    ]);
    for (const entry of names) {
      expect(Object.keys(entry).sort()).toEqual([
        'displayName',
        'id',
        'isActive',
      ]);
    }
    expect(
      failure(await h.call(C.cashiers.list, undefined, CASHIER)).code,
    ).toBe('FORBIDDEN');
    expect(
      failure(await h.call(C.cashiers.listNames, undefined, NOBODY)).code,
    ).toBe('UNAUTHENTICATED');
  });
});

describe('c. ad-hoc reference administration (spec 12)', () => {
  async function customLine(title: string) {
    const draft = await newDraft();
    return value(
      await apply(draft, {
        kind: 'addCustomLine',
        type: 'SERVICE',
        title,
        unitPrice: '35000',
      }),
    );
  }

  test('ADMIN lists, edits the description, deactivates and reactivates; inactive leaves autocomplete but not history', async () => {
    const withLine = await customLine('Jasa las bracket');
    await customLine('Jasa buka baut patah');
    const listed = value(
      await h.call<AdHocReferenceDto[]>(C.adHocReferences.list, {}, ADMIN),
    );
    expect(listed.map((r) => r.title)).toEqual([
      'Jasa buka baut patah',
      'Jasa las bracket',
    ]);
    const las = listed.find((r) => r.title === 'Jasa las bracket')!;

    const described = value(
      await h.call<AdHocReferenceDto>(
        C.adHocReferences.update,
        { id: las.id, description: 'Las ringan pada bracket' },
        ADMIN,
      ),
    );
    expect(described.description).toBe('Las ringan pada bracket');

    const inactive = value(
      await h.call<AdHocReferenceDto>(
        C.adHocReferences.deactivate,
        { id: las.id },
        ADMIN,
      ),
    );
    expect(inactive.isActive).toBe(false);

    // Gone from autocomplete...
    const search = value(
      await h.call<{ results: AdHocReferenceDto[] }>(
        C.adHocReferences.search,
        { query: 'las' },
        CASHIER,
      ),
    );
    expect(search.results).toEqual([]);
    // ...still listed for ADMIN (inactive included, or filtered by query)...
    const filtered = value(
      await h.call<AdHocReferenceDto[]>(
        C.adHocReferences.list,
        { query: 'las' },
        ADMIN,
      ),
    );
    expect(filtered.map((r) => [r.title, r.isActive])).toEqual([
      ['Jasa las bracket', false],
    ]);
    // ...and the historical line is untouched.
    const again = value(
      await h.call<DraftView>(C.drafts.get, withLine.id, CASHIER),
    );
    expect(again.lines[0]).toMatchObject({
      title: 'Jasa las bracket',
      adHocItemReferenceId: las.id,
    });
    // Picking it explicitly is refused while inactive.
    const draft = await newDraft();
    expect(
      failure(
        await apply(draft, {
          kind: 'addCustomLine',
          type: 'SERVICE',
          title: 'Jasa las bracket',
          unitPrice: '35000',
          adHocItemReferenceId: las.id,
        }),
      ).code,
    ).toBe('AD_HOC_REFERENCE_INACTIVE');

    value(await h.call(C.adHocReferences.reactivate, { id: las.id }, ADMIN));
    const back = value(
      await h.call<{ results: AdHocReferenceDto[] }>(
        C.adHocReferences.search,
        { query: 'las' },
        CASHIER,
      ),
    );
    expect(back.results.map((r) => r.title)).toEqual(['Jasa las bracket']);

    expect(
      rows(
        `SELECT action, entity_id FROM audit_log
         WHERE entity_type = 'adHocReference' ORDER BY rowid`,
      ),
    ).toEqual([
      { action: 'AD_HOC_REFERENCE_UPDATED', entity_id: las.id },
      { action: 'AD_HOC_REFERENCE_DEACTIVATED', entity_id: las.id },
      { action: 'AD_HOC_REFERENCE_REACTIVATED', entity_id: las.id },
    ]);
  });

  test('CASHIER is FORBIDDEN; unknown ids are reported', async () => {
    await customLine('Seal karet kecil');
    for (const [channel, input] of [
      [C.adHocReferences.list, {}],
      [C.adHocReferences.update, { id: uuid(), description: 'x' }],
      [C.adHocReferences.deactivate, { id: uuid() }],
      [C.adHocReferences.reactivate, { id: uuid() }],
    ] as const) {
      expect(failure(await h.call(channel, input, CASHIER)).code).toBe(
        'FORBIDDEN',
      );
    }
    expect(
      failure(await h.call(C.adHocReferences.deactivate, { id: uuid() }, ADMIN))
        .code,
    ).toBe('AD_HOC_REFERENCE_NOT_FOUND');
  });
});

describe('e. vehicle deactivation', () => {
  test('ADMIN deactivates/reactivates; an inactive vehicle cannot be newly selected; drafts keep one already chosen', async () => {
    const saved = value(
      await h.call<SaveVehicleResult>(
        C.vehicles.save,
        { plateNumber: 'B 1234 XYZ' },
        CASHIER,
      ),
    );
    const vehicleId = saved.vehicle.id;
    const kept = value(
      await apply(await newDraft(), {
        kind: 'updateHeader',
        changes: { vehicleId },
      }),
    );

    expect(
      failure(await h.call(C.vehicles.deactivate, { id: vehicleId }, CASHIER))
        .code,
    ).toBe('FORBIDDEN');
    const off = value(
      await h.call<VehicleDto>(C.vehicles.deactivate, { id: vehicleId }, ADMIN),
    );
    expect(off.isActive).toBe(false);

    const fresh = await newDraft();
    expect(
      failure(
        await apply(fresh, { kind: 'updateHeader', changes: { vehicleId } }),
      ).code,
    ).toBe('VEHICLE_INACTIVE');
    // The draft that already had it keeps working.
    const edited = value(
      await apply(kept, { kind: 'updateHeader', changes: { note: 'x' } }),
    );
    expect(edited.vehicle?.id).toBe(vehicleId);
    // Still found by plate (flagged inactive).
    const found = value(
      await h.call<{ results: VehicleDto[] }>(
        C.vehicles.searchByPlate,
        { query: 'b1234' },
        CASHIER,
      ),
    );
    expect(found.results.map((v) => [v.id, v.isActive])).toEqual([
      [vehicleId, false],
    ]);

    const on = value(
      await h.call<VehicleDto>(C.vehicles.reactivate, { id: vehicleId }, ADMIN),
    );
    expect(on.isActive).toBe(true);
    value(await apply(fresh, { kind: 'updateHeader', changes: { vehicleId } }));
    expect(
      failure(await h.call(C.vehicles.deactivate, { id: uuid() }, ADMIN)).code,
    ).toBe('VEHICLE_NOT_FOUND');
    expect(
      rows(
        `SELECT action FROM audit_log WHERE entity_type = 'vehicle'
           AND action IN ('VEHICLE_DEACTIVATED', 'VEHICLE_REACTIVATED') ORDER BY rowid`,
      ),
    ).toEqual([
      { action: 'VEHICLE_DEACTIVATED' },
      { action: 'VEHICLE_REACTIVATED' },
    ]);
  });
});

describe('f. one-time restore outcome notice', () => {
  test.each([
    [{ outcome: 'RESTORED', stage: 'REPLACED', asideFiles: [] }, 'COMPLETED'],
    [
      { outcome: 'RESTORED', stage: 'MOVED_ASIDE', asideFiles: [] },
      'ROLLED_FORWARD',
    ],
    [{ outcome: 'ROLLED_BACK', stage: 'MOVED_ASIDE' }, 'ROLLED_BACK'],
    [{ outcome: 'KEPT_CURRENT' }, 'ROLLED_BACK'],
  ] as const)(
    '%o is shown once, to the next ADMIN, as %s',
    async (recovery, expected) => {
      recordRestoreNotice({
        dataDir: h.dir,
        recovery: recovery as never,
        at: toInstant(nowMs),
      });
      expect(existsSync(restoreNoticePath(h.dir))).toBe(true);
      // A CASHIER does not consume it.
      expect(
        failure(await h.call(C.backups.takeRestoreNotice, undefined, CASHIER))
          .code,
      ).toBe('FORBIDDEN');
      const notice = value(
        await h.call<RestoreNoticeDto | null>(
          C.backups.takeRestoreNotice,
          undefined,
          ADMIN,
        ),
      );
      expect(notice).toEqual({ outcome: expected, at: toInstant(nowMs) });
      expect(existsSync(restoreNoticePath(h.dir))).toBe(false);
      expect(
        value(await h.call(C.backups.takeRestoreNotice, undefined, ADMIN)),
      ).toBeNull();
    },
  );

  test('no marker writes nothing; an unreadable notice is dropped', async () => {
    recordRestoreNotice({
      dataDir: h.dir,
      recovery: { outcome: 'NO_MARKER' },
      at: toInstant(nowMs),
    });
    expect(existsSync(restoreNoticePath(h.dir))).toBe(false);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(restoreNoticePath(h.dir), '{not json');
    expect(
      value(await h.call(C.backups.takeRestoreNotice, undefined, ADMIN)),
    ).toBeNull();
    expect(existsSync(restoreNoticePath(h.dir))).toBe(false);
  });
});

describe('workflow e2e print hook (test-only route to printToPDF)', () => {
  test('a paper print becomes a PDF file and is recorded in print_jobs', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'bengkelin-t17-print-'));
    const fake = new FakePrintDriver();
    const routed = routePrintsToPdf(fake, out);
    const ph = createHarness({
      clock: { now: () => toInstant(nowMs) },
      printDriver: routed,
    });
    try {
      value(await ph.call(C.settings.completeSetup, validSetup()));
      value(
        await ph.call(
          C.auth.login,
          { username: 'admin', password: ADMIN_PASSWORD },
          ADMIN,
        ),
      );
      const unit = value(
        await ph.call<ReferenceDto[]>(C.references.list, { entity: 'unit' }),
      ).find((u) => u.code === 'PCS')!.id;
      const channel = value(
        await ph.call<ReferenceDto[]>(C.references.list, { entity: 'channel' }),
      ).find((c) => c.code === 'BENGKEL')!.id;
      value(
        await ph.call<CatalogItemDto>(
          C.catalog.save,
          { type: 'SERVICE', title: 'Jasa', unitId: unit },
          ADMIN,
        ),
      );
      let draft = value(
        await ph.call<DraftView>(
          C.drafts.create,
          {
            requestId: uuid(),
            channelId: channel,
            invoiceDate: '2026-09-30',
            pricingAt: toInstant(nowMs),
          },
          ADMIN,
        ),
      );
      draft = value(
        await ph.call<DraftView>(
          C.drafts.apply,
          {
            requestId: uuid(),
            invoiceId: draft.id,
            expectedVersion: draft.version,
            op: {
              kind: 'addCustomLine',
              type: 'SERVICE',
              title: 'Jasa',
              unitPrice: '1000',
            },
          },
          ADMIN,
        ),
      );
      const preview = value(
        await ph.call<{ draftVersion: number; warnings: unknown[] }>(
          C.invoices.previewFinalize,
          { invoiceId: draft.id },
          ADMIN,
        ),
      );
      const invoice = value(
        await ph.call<InvoiceView>(
          C.invoices.finalize,
          {
            requestId: uuid(),
            invoiceId: draft.id,
            expectedVersion: preview.draftVersion,
            acknowledgedWarnings: preview.warnings,
          },
          ADMIN,
        ),
      );
      const outcome = value(
        await ph.call<{ outcome: string }>(
          C.printing.print,
          { invoiceId: invoice.id, format: 'THERMAL_58' },
          ADMIN,
        ),
      );
      expect(outcome.outcome).toBe('PRINTED');
      expect(fake.printCalls).toHaveLength(0);
      expect(fake.pdfCalls.map((c) => c.format)).toEqual(['THERMAL_58']);
      const files = readdirSync(out);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/THERMAL_58\.pdf$/);
      expect(readFileSync(path.join(out, files[0]!), 'utf8')).toContain('%PDF');
      expect(
        ph.db.prepare('SELECT format, action, outcome FROM print_jobs').all(),
      ).toEqual([
        { format: 'THERMAL_58', action: 'PRINT', outcome: 'PRINTED' },
      ]);
    } finally {
      ph.close();
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('the hook is honored only in unpackaged builds', () => {
    const env = { BENGKELIN_TEST_PRINT_TO_PDF_DIR: 'prints' };
    expect(testPrintToPdfDir({ isPackaged: true }, env)).toBeNull();
    expect(testPrintToPdfDir({ isPackaged: false }, {})).toBeNull();
    expect(testPrintToPdfDir({ isPackaged: false }, env)).toBe(
      path.resolve('prints'),
    );
  });

  test('listing printers and PDF export pass through unchanged', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'bengkelin-t17-print-'));
    try {
      const fake = new FakePrintDriver();
      fake.printers = [{ name: 'P', displayName: 'P', isDefault: true }];
      const routed = routePrintsToPdf(fake, out);
      expect(await routed.listPrinters()).toEqual(fake.printers);
      expect(await routed.printToPdf('<p/>', 'A4')).toBe(fake.pdfBytes);
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
