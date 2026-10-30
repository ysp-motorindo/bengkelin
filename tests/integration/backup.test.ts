import { withCurrentCustomerColumns } from './helpers/legacy-customers';
import { createHash } from 'node:crypto';
import fs, {
  accessSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApplicationServices } from '@/main/compose';
import { openDatabase } from '@/main/database/connection';
import { APPLICATION_ID } from '@/main/database/identity';
import {
  bundledMigrations,
  latestBundledVersion,
  migrateDatabase,
  readSchemaVersion,
} from '@/main/database/migrate';
import {
  backupFileName,
  parseBackupFileName,
} from '@/main/features/backups/naming';
import { pruneAutoBackups } from '@/main/features/backups/retention';
import {
  BackupScheduler,
  type BackupTimers,
} from '@/main/features/backups/scheduler';
import {
  BackupService,
  type BackupHooks,
} from '@/main/features/backups/service';
import { validateBackup } from '@/main/features/backups/validation';
import { executeCommand } from '@/main/platform/command';
import { buildCommands } from '@/main/platform/commands';
import { noopLogger } from '@/main/platform/logger';
import { CHANNELS } from '@/shared/channels';
import type {
  BackupDestinationChoiceDto,
  BackupStatusDto,
  BackupSummary,
  DraftView,
  FinalizePreviewDto,
  InvoiceView,
} from '@/shared/contracts';
import type { Instant, Result } from '@/shared/primitives';
import { toInstant } from '@/shared/time';
import {
  ADMIN_WINDOW,
  CASHIER_WINDOW,
  criticalInvoice,
  fixtureId,
  seedPrintShop,
  type PrintShop,
} from '../fixtures/print-invoices';
import { FakeDialogs } from './helpers/fake-print';
import { createHarness, failure, value, type Harness } from './helpers/harness';

// Directory chmod does not simulate denied writes on Windows.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    accessSync: vi.fn(actual.accessSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});

/**
 * Task 14: validated local backups (spec 42, 44, 46, 47, 48, 55; Part A
 * review focus 5). The backup is SQLite's online backup of the live
 * connection (committed WAL content included) into `<final>.partial`,
 * validated through a READONLY raw handle, fsynced and atomically renamed.
 * A failed backup never touches business state or blocks a cashier.
 * T0 = 2026-09-30 10:00 WIB (Asia/Jakarta).
 */

const C = CHANNELS;
const NOBODY = 99;
const T0 = Date.UTC(2026, 8, 30, 3, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let h: Harness;
let dialogs: FakeDialogs;
let nowMs = T0;
let shop: PrintShop;
let scratch: string;
const now = (): Instant => toInstant(nowMs);
const clock = { now };
const priceStart = () => toInstant(T0 - 30 * DAY);

beforeEach(async () => {
  vi.mocked(accessSync).mockReset().mockImplementation(fs.accessSync);
  vi.mocked(mkdirSync).mockReset().mockImplementation(fs.mkdirSync);
  nowMs = T0;
  dialogs = new FakeDialogs();
  h = createHarness({ clock, dialogs });
  scratch = mkdtempSync(path.join(tmpdir(), 'bengkelin-backup-'));
  shop = await seedPrintShop(h.call, now);
});
afterEach(() => {
  h.close();
  rmSync(scratch, { recursive: true, force: true });
});

// ---- helpers ----

function service(
  options: { hooks?: BackupHooks; pagesPerStep?: number } = {},
): BackupService {
  return new BackupService({
    db: h.db,
    clock,
    logger: noopLogger,
    defaultDir: h.backupsDir,
    dialogs,
    ...options,
  });
}

const backups = () => h.services.backups;

function files(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Rows read through a raw, read-only handle (never the app's opener). */
function readRaw<T>(file: string, sql: string): T[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function invoiceIds(file?: string): string[] {
  const sql = 'SELECT id FROM invoices ORDER BY id';
  const rows = file
    ? readRaw<{ id: string }>(file, sql)
    : (h.db.prepare(sql).all() as { id: string }[]);
  return rows.map((r) => r.id);
}

/** Committed business state a backup must never touch. */
function businessState() {
  return JSON.stringify(
    [
      'invoices',
      'invoice_items',
      'payments',
      'stock_ledger_entries',
      'invoice_daily_counters',
      'catalog_items',
      'cashiers',
    ].map((table) =>
      h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ),
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
}

interface RunRow {
  kind: string;
  started_at: string;
  finished_at: string;
  outcome: string;
  file_name: string | null;
  error_code: string | null;
  destination_dir: string;
}
function runs(): RunRow[] {
  return h.db
    .prepare(
      `SELECT kind, started_at, finished_at, outcome, file_name, error_code, destination_dir
         FROM backup_runs ORDER BY id`,
    )
    .all() as RunRow[];
}

/** A draft ready to finalize (as the CASHIER). */
async function prepareDraft() {
  let draft = value(
    await h.call<DraftView>(
      C.drafts.create,
      {
        requestId: fixtureId(),
        channelId: shop.bengkel,
        invoiceDate: '2026-09-30',
        pricingAt: now(),
      },
      CASHIER_WINDOW,
    ),
  );
  draft = value(
    await h.call<DraftView>(
      C.drafts.apply,
      {
        requestId: fixtureId(),
        invoiceId: draft.id,
        expectedVersion: draft.version,
        op: {
          kind: 'addCustomLine',
          type: 'SERVICE',
          title: 'Servis ringan',
          unitPrice: '75000',
        },
      },
      CASHIER_WINDOW,
    ),
  );
  const preview = value(
    await h.call<FinalizePreviewDto>(
      C.invoices.previewFinalize,
      { invoiceId: draft.id },
      CASHIER_WINDOW,
    ),
  );
  return { invoiceId: draft.id, preview };
}

function finalize(prepared: Awaited<ReturnType<typeof prepareDraft>>) {
  return h.call<InvoiceView>(
    C.invoices.finalize,
    {
      requestId: fixtureId(),
      invoiceId: prepared.invoiceId,
      expectedVersion: prepared.preview.draftVersion,
      acknowledgedWarnings: prepared.preview.warnings,
    },
    CASHIER_WINDOW,
  );
}

async function chooseDestination(dir: string) {
  dialogs.backupDirAnswers.push(dir);
  return h.call<BackupDestinationChoiceDto>(
    C.backups.chooseDestination,
    undefined,
    ADMIN_WINDOW,
  );
}

function status(windowId = ADMIN_WINDOW) {
  return h.call<BackupStatusDto>(C.backups.status, undefined, windowId);
}

/** Timers driven by the test: nothing fires until the test says so. */
class FakeTimers implements BackupTimers {
  timeouts: { fn: () => void; ms: number }[] = [];
  intervals: { fn: () => void; ms: number; cleared: boolean }[] = [];
  setTimeout(fn: () => void, ms: number) {
    const entry = { fn, ms };
    this.timeouts.push(entry);
    return entry;
  }
  clearTimeout(handle: unknown) {
    this.timeouts = this.timeouts.filter((t) => t !== handle);
  }
  setInterval(fn: () => void, ms: number) {
    const entry = { fn, ms, cleared: false };
    this.intervals.push(entry);
    return entry;
  }
  clearInterval(handle: unknown) {
    (handle as { cleared: boolean }).cleared = true;
  }
  fireTimeouts() {
    const due = this.timeouts;
    this.timeouts = [];
    for (const t of due) t.fn();
  }
  fireInterval() {
    for (const i of this.intervals) if (!i.cleared) i.fn();
  }
}

// ---- required assertions ----

describe('required assertions', () => {
  test('application id, WAL-inclusive invoice ids, FINALIZED after a failed backup', async () => {
    await criticalInvoice(shop, priceStart());
    // Keep the next commit in the -wal file only.
    h.db.pragma('wal_checkpoint(TRUNCATE)');
    h.db.pragma('wal_autocheckpoint = 0');
    await criticalInvoice(shop, priceStart());
    expect(statSync(`${h.file}-wal`).size).toBeGreaterThan(0);
    const sourceInvoiceIds = invoiceIds();
    expect(sourceInvoiceIds).toHaveLength(2);

    const summary = await backups().createValidatedBackup({ kind: 'MANUAL' });
    const file = path.join(h.backupsDir, summary.fileName);
    const validation = validateBackup(file);
    const expectedApplicationId = APPLICATION_ID;
    expect(validation.ok).toBe(true);
    expect(validation.applicationId).toBe(expectedApplicationId);
    const backupInvoiceIds = invoiceIds(file);
    expect(backupInvoiceIds).toEqual(sourceInvoiceIds);

    // A failed backup (destination gone), then an ordinary finalization.
    const usb = path.join(scratch, 'usb');
    mkdirSync(usb);
    value(await chooseDestination(usb));
    rmSync(usb, { recursive: true });
    const before = businessState();
    expect(
      failure(await h.call(C.backups.create, undefined, ADMIN_WINDOW)).code,
    ).toBe('BACKUP_DESTINATION_UNAVAILABLE');
    expect(businessState()).toBe(before);
    const transactionAfterBackupFailure = value(
      await finalize(await prepareDraft()),
    );
    expect(transactionAfterBackupFailure.status).toBe('FINALIZED');
  });
});

// ---- the backup engine ----

describe('createValidatedBackup', () => {
  test('includes committed data that is still only in the -wal file', async () => {
    h.db.pragma('wal_checkpoint(TRUNCATE)');
    h.db.pragma('wal_autocheckpoint = 0');
    const invoice = await criticalInvoice(shop, priceStart());
    // The commit is in the WAL: the main file alone does not contain it.
    expect(statSync(`${h.file}-wal`).size).toBeGreaterThan(0);
    const mainOnly = path.join(scratch, 'main-only.sqlite');
    copyFileSync(h.file, mainOnly);
    expect(invoiceIds(mainOnly)).not.toContain(invoice.id);

    const summary = await backups().createValidatedBackup({ kind: 'AUTO' });
    const file = path.join(h.backupsDir, summary.fileName);
    expect(invoiceIds(file)).toContain(invoice.id);
    expect(invoiceIds(file)).toEqual(invoiceIds());
    const [status] = readRaw<{ status: string }>(
      file,
      `SELECT status FROM invoices WHERE id = '${invoice.id}'`,
    );
    expect(status?.status).toBe('FINALIZED');
    // The WAL was not checkpointed by the backup.
    expect(statSync(`${h.file}-wal`).size).toBeGreaterThan(0);
  });

  test('writes a self-contained, validated single file and returns its summary', async () => {
    const summary: BackupSummary = await backups().createValidatedBackup({
      kind: 'MANUAL',
    });
    expect(summary).toEqual({
      kind: 'MANUAL',
      fileName: 'bengkelin-manual-20260930-100000.sqlite',
      size: statSync(path.join(h.backupsDir, summary.fileName)).size,
      createdAt: now(),
      schemaVersion: latestBundledVersion,
      applicationId: APPLICATION_ID,
    });
    expect(summary.size).toBeGreaterThan(0);
    // Only the final file: no partial, no -wal/-shm/-journal sidecars.
    expect(files(h.backupsDir)).toEqual([summary.fileName]);
    const file = path.join(h.backupsDir, summary.fileName);
    const header = readFileSync(file).subarray(0, 20);
    expect(header.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');
    // Rollback-journal file format (1), not WAL (2): opens anywhere alone.
    expect([header[18], header[19]]).toEqual([1, 1]);
    expect(runs()).toEqual([
      {
        kind: 'MANUAL',
        started_at: now(),
        finished_at: now(),
        outcome: 'SUCCEEDED',
        file_name: summary.fileName,
        error_code: null,
        destination_dir: h.backupsDir,
      },
    ]);
  });

  test('creates the default folder on demand', async () => {
    expect(existsSync(h.backupsDir)).toBe(false);
    await backups().createValidatedBackup({ kind: 'SAFETY' });
    expect(files(h.backupsDir)).toEqual([
      'bengkelin-safety-20260930-100000.sqlite',
    ]);
  });

  test('an explicit destinationDir is used as given', async () => {
    const target = path.join(scratch, 'explicit');
    mkdirSync(target);
    const summary = await backups().createValidatedBackup({
      kind: 'SAFETY',
      destinationDir: target,
    });
    expect(files(target)).toEqual([summary.fileName]);
    expect(files(h.backupsDir)).toEqual([]);
  });

  test('names never collide and never overwrite (-2, -3, partial files respected)', async () => {
    const names: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      names.push(
        (await backups().createValidatedBackup({ kind: 'MANUAL' })).fileName,
      );
    }
    expect(names).toEqual([
      'bengkelin-manual-20260930-100000.sqlite',
      'bengkelin-manual-20260930-100000-2.sqlite',
      'bengkelin-manual-20260930-100000-3.sqlite',
    ]);
    const first = path.join(h.backupsDir, names[0]!);
    const hash = sha256(first);
    // A stale partial (a crash) also reserves its name.
    writeFileSync(
      path.join(
        h.backupsDir,
        'bengkelin-manual-20260930-100000-4.sqlite.partial',
      ),
      'stale',
    );
    const next = await backups().createValidatedBackup({ kind: 'MANUAL' });
    expect(next.fileName).toBe('bengkelin-manual-20260930-100000-5.sqlite');
    expect(sha256(first)).toBe(hash);
    expect(
      readFileSync(
        path.join(
          h.backupsDir,
          'bengkelin-manual-20260930-100000-4.sqlite.partial',
        ),
        'utf8',
      ),
    ).toBe('stale');
  });

  test('concurrent backups are serialized with distinct names', async () => {
    const results = await Promise.all([
      backups().createValidatedBackup({ kind: 'MANUAL' }),
      backups().createValidatedBackup({ kind: 'MANUAL' }),
    ]);
    expect(results.map((r) => r.fileName)).toEqual([
      'bengkelin-manual-20260930-100000.sqlite',
      'bengkelin-manual-20260930-100000-2.sqlite',
    ]);
  });

  test('a finalize while the backup is copying succeeds and no write transaction is held', async () => {
    await criticalInvoice(shop, priceStart());
    const prepared = await prepareDraft();
    let firstStep!: () => void;
    const copying = new Promise<void>((resolve) => {
      firstStep = resolve;
    });
    let steps = 0;
    const slow = service({
      pagesPerStep: 1,
      hooks: {
        onStep: () => {
          steps += 1;
          if (steps === 1) firstStep();
        },
      },
    });
    let done = false;
    const pending = slow
      .createValidatedBackup({ kind: 'MANUAL' })
      .finally(() => {
        done = true;
      });
    await copying;
    expect(done).toBe(false);
    expect(h.db.inTransaction).toBe(false);

    const finalized = value(await finalize(prepared));
    expect(finalized.status).toBe('FINALIZED');
    expect(done).toBe(false);

    const summary = await pending;
    expect(steps).toBeGreaterThan(2);
    const file = path.join(h.backupsDir, summary.fileName);
    expect(validateBackup(file).ok).toBe(true);
    // Writes through the same connection are carried into the backup.
    expect(invoiceIds(file)).toEqual(invoiceIds());
  });

  test('interrupted between write and rename: no final file, no partial left', async () => {
    const before = businessState();
    const broken = service({
      hooks: {
        beforeRename: () => {
          throw new Error('power cut');
        },
      },
    });
    await expect(
      broken.createValidatedBackup({ kind: 'MANUAL' }),
    ).rejects.toMatchObject({ code: 'BACKUP_WRITE_FAILED' });
    expect(files(h.backupsDir)).toEqual([]);
    expect(businessState()).toBe(before);
    expect(runs()).toMatchObject([
      { kind: 'MANUAL', outcome: 'FAILED', error_code: 'BACKUP_WRITE_FAILED' },
    ]);
    expect(runs()[0]!.file_name).toBeNull();
  });

  test('a copy that fails validation is removed and reported', async () => {
    const corrupting = service({
      hooks: {
        afterWrite: (partial) => writeFileSync(partial, 'not a database'),
      },
    });
    await expect(
      corrupting.createValidatedBackup({ kind: 'AUTO' }),
    ).rejects.toMatchObject({ code: 'BACKUP_VALIDATION_FAILED' });
    expect(files(h.backupsDir)).toEqual([]);
    expect(runs()).toMatchObject([
      { outcome: 'FAILED', error_code: 'BACKUP_VALIDATION_FAILED' },
    ]);
  });

  test('an unavailable destination fails clearly and is never created elsewhere', async () => {
    const usb = path.join(scratch, 'usb', 'backups');
    mkdirSync(usb, { recursive: true });
    value(await chooseDestination(usb));
    rmSync(path.join(scratch, 'usb'), { recursive: true });
    const before = businessState();

    const error = failure(
      await h.call(C.backups.create, undefined, ADMIN_WINDOW),
    );
    expect(error.code).toBe('BACKUP_DESTINATION_UNAVAILABLE');
    // No silent fallback: the missing folder is not recreated and the
    // default folder is not used.
    expect(existsSync(usb)).toBe(false);
    expect(files(h.backupsDir)).toEqual([]);
    expect(businessState()).toBe(before);
    expect(runs()).toMatchObject([
      {
        kind: 'MANUAL',
        outcome: 'FAILED',
        error_code: 'BACKUP_DESTINATION_UNAVAILABLE',
        destination_dir: usb,
        file_name: null,
      },
    ]);
    // A file where the folder should be is unavailable too.
    mkdirSync(path.join(scratch, 'usb'));
    writeFileSync(usb, 'not a folder');
    expect(
      failure(await h.call(C.backups.create, undefined, ADMIN_WINDOW)).code,
    ).toBe('BACKUP_DESTINATION_UNAVAILABLE');
  });

  test('a read-only destination fails with BACKUP_DESTINATION_READ_ONLY', async () => {
    const locked = path.join(scratch, 'locked');
    mkdirSync(locked);
    value(await chooseDestination(locked));
    vi.mocked(accessSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    });
    const before = businessState();
    const error = failure(
      await h.call(C.backups.create, undefined, ADMIN_WINDOW),
    );
    expect(error.code).toBe('BACKUP_DESTINATION_READ_ONLY');
    expect(files(locked)).toEqual([]);
    expect(businessState()).toBe(before);
    const after = value(await finalize(await prepareDraft()));
    expect(after.status).toBe('FINALIZED');
  });

  test('an unwritable default folder parent is reported, not bypassed', async () => {
    // The default folder cannot be created: its parent is read-only.
    const parent = path.join(scratch, 'userData');
    mkdirSync(parent);
    const blocked = new BackupService({
      db: h.db,
      clock,
      logger: noopLogger,
      defaultDir: path.join(parent, 'backups'),
      dialogs,
    });
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    });
    await expect(
      blocked.createValidatedBackup({ kind: 'AUTO' }),
    ).rejects.toMatchObject({ code: 'BACKUP_DESTINATION_READ_ONLY' });
  });
});

// ---- validation ----

describe('validateBackup', () => {
  let good: string;
  beforeEach(async () => {
    await criticalInvoice(shop, priceStart());
    const summary = await backups().createValidatedBackup({ kind: 'MANUAL' });
    good = path.join(scratch, 'good.sqlite');
    copyFileSync(path.join(h.backupsDir, summary.fileName), good);
  });

  /** A copy of the good backup changed through a raw read-write handle. */
  function variant(name: string, change: (db: Database.Database) => void) {
    const file = path.join(scratch, name);
    copyFileSync(good, file);
    const db = new Database(file);
    try {
      change(db);
    } finally {
      db.close();
    }
    return file;
  }

  function openHandlesTo(file: string): string[] {
    if (!existsSync('/proc/self/fd')) return [];
    const target = path.resolve(file);
    return readdirSync('/proc/self/fd')
      .map((fd) => {
        try {
          return readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          return '';
        }
      })
      .filter((link) => link.startsWith(target));
  }

  test('accepts a good backup without changing it or leaving handles/sidecars', () => {
    const hash = sha256(good);
    const result = validateBackup(good);
    expect(result).toEqual({
      ok: true,
      applicationId: APPLICATION_ID,
      schemaVersion: latestBundledVersion,
    });
    expect(sha256(good)).toBe(hash);
    expect(files(scratch).filter((f) => f.startsWith('good'))).toEqual([
      'good.sqlite',
    ]);
    expect(openHandlesTo(good)).toEqual([]);
  });

  test('accepts a WAL-format copy of the live database and cleans up its sidecars', () => {
    h.db.pragma('wal_checkpoint(TRUNCATE)');
    const live = path.join(scratch, 'live-copy.sqlite');
    copyFileSync(h.file, live);
    expect(readFileSync(live)[18]).toBe(2);
    expect(validateBackup(live)).toMatchObject({ ok: true });
    expect(files(scratch).filter((f) => f.startsWith('live-copy'))).toEqual([
      'live-copy.sqlite',
    ]);
  });

  test('BACKUP_NOT_FOUND: missing or empty file', () => {
    expect(validateBackup(path.join(scratch, 'nope.sqlite'))).toEqual({
      ok: false,
      applicationId: null,
      schemaVersion: null,
      error: 'BACKUP_NOT_FOUND',
    });
    const empty = path.join(scratch, 'empty.sqlite');
    writeFileSync(empty, '');
    expect(validateBackup(empty).error).toBe('BACKUP_NOT_FOUND');
    expect(validateBackup(scratch).error).toBe('BACKUP_NOT_FOUND');
  });

  test('NOT_SQLITE: a text file', () => {
    const text = path.join(scratch, 'notes.sqlite');
    writeFileSync(text, 'Nota servis Pak Budi, bukan database.\n'.repeat(10));
    expect(validateBackup(text)).toEqual({
      ok: false,
      applicationId: null,
      schemaVersion: null,
      error: 'NOT_SQLITE',
    });
    expect(files(scratch).filter((f) => f.startsWith('notes'))).toEqual([
      'notes.sqlite',
    ]);
  });

  test('CORRUPT_DATABASE: a truncated file', () => {
    const truncated = path.join(scratch, 'truncated.sqlite');
    copyFileSync(good, truncated);
    truncateSync(truncated, Math.floor(statSync(good).size / 2));
    expect(validateBackup(truncated)).toMatchObject({
      ok: false,
      error: 'CORRUPT_DATABASE',
    });
  });

  test('CORRUPT_DATABASE: damaged pages', () => {
    const [{ rootpage, page_size }] = readRaw<{
      rootpage: bigint | number;
      page_size: bigint | number;
    }>(
      good,
      `SELECT rootpage, (SELECT page_size FROM pragma_page_size) AS page_size
         FROM sqlite_master WHERE name = 'invoices'`,
    ) as [{ rootpage: number; page_size: number }];
    const bytes = readFileSync(good);
    const start = (Number(rootpage) - 1) * Number(page_size);
    bytes.fill(0xa5, start, start + Number(page_size));
    const damaged = path.join(scratch, 'damaged.sqlite');
    writeFileSync(damaged, bytes);
    expect(validateBackup(damaged)).toMatchObject({
      ok: false,
      error: 'CORRUPT_DATABASE',
    });
  });

  test('FOREIGN_DATABASE: a SQLite file of another application', () => {
    const foreign = path.join(scratch, 'foreign.sqlite');
    const db = new Database(foreign);
    db.pragma('application_id = 305419896');
    db.pragma('user_version = 3');
    db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY)');
    db.close();
    expect(validateBackup(foreign)).toEqual({
      ok: false,
      applicationId: 305419896,
      schemaVersion: 3,
      error: 'FOREIGN_DATABASE',
    });
    const unmarked = variant('unmarked.sqlite', (d) =>
      d.pragma('application_id = 0'),
    );
    expect(validateBackup(unmarked)).toMatchObject({
      ok: false,
      applicationId: 0,
      error: 'FOREIGN_DATABASE',
    });
  });

  test('UNSUPPORTED_SCHEMA: a newer schema version (and version 0)', () => {
    const newer = variant('newer.sqlite', (d) =>
      d.pragma(`user_version = ${latestBundledVersion + 1}`),
    );
    expect(validateBackup(newer)).toEqual({
      ok: false,
      applicationId: APPLICATION_ID,
      schemaVersion: latestBundledVersion + 1,
      error: 'UNSUPPORTED_SCHEMA',
    });
    const zero = variant('zero.sqlite', (d) => d.pragma('user_version = 0'));
    expect(validateBackup(zero)).toMatchObject({
      ok: false,
      schemaVersion: 0,
      error: 'UNSUPPORTED_SCHEMA',
    });
  });

  test('MISSING_TABLES: a core table is gone', () => {
    const missing = variant('missing.sqlite', (d) =>
      d.exec('DROP TABLE backup_runs'),
    );
    expect(validateBackup(missing)).toMatchObject({
      ok: false,
      applicationId: APPLICATION_ID,
      error: 'MISSING_TABLES',
    });
  });

  test.each(['sales', 'expeditions'])(
    'missing new master %s rejects a v16 backup',
    (table) => {
      const missing = variant(`missing-${table}.sqlite`, (d) =>
        d.exec(`DROP TABLE ${table}`),
      );
      expect(validateBackup(missing)).toMatchObject({
        ok: false,
        error: 'MISSING_TABLES',
      });
    },
  );

  test('an older supported schema passes with only the tables it had', () => {
    const dir = mkdtempSync(path.join(scratch, 'v6-'));
    const file = path.join(dir, 'v6.sqlite');
    const db = openDatabase(file);
    migrateDatabase(
      db,
      bundledMigrations.filter((m) => m.version <= 6),
    );
    db.pragma('journal_mode = DELETE');
    db.close();
    expect(validateBackup(file)).toEqual({
      ok: true,
      applicationId: APPLICATION_ID,
      schemaVersion: 6,
    });
  });
});

// ---- naming ----

describe('naming', () => {
  test('shop-timezone local time, kind in the name, parse round trip', () => {
    // 2026-09-30 23:59:58 WIB is 16:59:58Z.
    const at = toInstant(Date.UTC(2026, 8, 30, 16, 59, 58));
    expect(backupFileName('AUTO', at, 'Asia/Jakarta')).toBe(
      'bengkelin-auto-20260930-235958.sqlite',
    );
    expect(backupFileName('AUTO', at, 'Asia/Jayapura')).toBe(
      'bengkelin-auto-20261001-015958.sqlite',
    );
    expect(backupFileName('SAFETY', at, 'Asia/Jakarta', 3)).toBe(
      'bengkelin-safety-20260930-235958-3.sqlite',
    );
    expect(
      parseBackupFileName('bengkelin-manual-20260930-100000-2.sqlite'),
    ).toEqual({ kind: 'MANUAL', stamp: '20260930-100000', sequence: 2 });
    expect(
      parseBackupFileName('bengkelin-auto-20260930-100000.sqlite'),
    ).toEqual({ kind: 'AUTO', stamp: '20260930-100000', sequence: 1 });
    for (const foreign of [
      'bengkelin-auto-20260930-100000.sqlite.partial',
      'bengkelin-auto-2026093-100000.sqlite',
      'cashier-20260930-163215.sqlite',
      'bengkelin-weekly-20260930-100000.sqlite',
      'bengkelin-auto-20260930-100000-1.sqlite',
      'bengkelin-auto-20260930-100000-02.sqlite',
      'x-bengkelin-auto-20260930-100000.sqlite',
    ]) {
      expect(parseBackupFileName(foreign), foreign).toBeNull();
    }
  });
});

// ---- retention ----

describe('retention', () => {
  function seedFiles(dir: string) {
    mkdirSync(dir, { recursive: true });
    // 32 automatic backups, one a day from 2026-08-01 (all older than T0).
    const autos: string[] = [];
    for (let i = 0; i < 32; i += 1) {
      const day = new Date(Date.UTC(2026, 7, 1 + i));
      const stamp = day.toISOString().slice(0, 10).replaceAll('-', '');
      const name = `bengkelin-auto-${stamp}-020000.sqlite`;
      writeFileSync(path.join(dir, name), `auto ${i}`);
      // Unrecorded files are ordered by modification time.
      utimesSync(path.join(dir, name), day, day);
      autos.push(name);
    }
    const kept = [
      'bengkelin-manual-20260101-080000.sqlite',
      'bengkelin-manual-20260102-080000-2.sqlite',
      'bengkelin-safety-20250101-080000.sqlite',
      'bengkelin-auto-20200101-000000.sqlite.partial',
      'bengkelin-auto-2020.sqlite',
      'notes.txt',
      'cashier-20200101-000000.sqlite',
    ];
    for (const name of kept) writeFileSync(path.join(dir, name), name);
    // A folder that looks like an automatic backup is never touched.
    mkdirSync(path.join(dir, 'bengkelin-auto-20000101-000000.sqlite'));
    return { autos, kept };
  }

  test('a new automatic backup keeps the 30 newest autos; nothing else is pruned', async () => {
    const { autos, kept } = seedFiles(h.backupsDir);
    const outside = path.join(scratch, 'bengkelin-auto-19990101-000000.sqlite');
    writeFileSync(outside, 'outside');
    const hashes = Object.fromEntries(
      kept.map((name) => [name, sha256(path.join(h.backupsDir, name))]),
    );

    const summary = await backups().createValidatedBackup({ kind: 'AUTO' });

    const remaining = files(h.backupsDir);
    const remainingAutos = remaining.filter(
      (f) =>
        parseBackupFileName(f)?.kind === 'AUTO' &&
        statSync(path.join(h.backupsDir, f)).isFile(),
    );
    expect(remainingAutos).toHaveLength(30);
    expect(remainingAutos).toEqual(
      [...autos.slice(3), summary.fileName].sort(),
    );
    for (const name of autos.slice(0, 3)) expect(remaining).not.toContain(name);
    for (const name of kept) {
      expect(sha256(path.join(h.backupsDir, name)), name).toBe(hashes[name]);
    }
    expect(remaining).toContain('bengkelin-auto-20000101-000000.sqlite');
    expect(existsSync(outside)).toBe(true);
  });

  test('manual and safety backups and failed autos never prune', async () => {
    const { autos } = seedFiles(h.backupsDir);
    await backups().createValidatedBackup({ kind: 'MANUAL' });
    await backups().createValidatedBackup({ kind: 'SAFETY' });
    const failing = service({
      hooks: {
        beforeRename: () => {
          throw new Error('disk full');
        },
      },
    });
    await expect(
      failing.createValidatedBackup({ kind: 'AUTO' }),
    ).rejects.toMatchObject({ code: 'BACKUP_WRITE_FAILED' });
    for (const name of autos) {
      expect(existsSync(path.join(h.backupsDir, name)), name).toBe(true);
    }
  });

  test('pruneAutoBackups orders unrecorded files by modification time, never by the name stamp', () => {
    const dir = path.join(scratch, 'order');
    mkdirSync(dir);
    // Written oldest first (mtime), with name stamps in a different order.
    const names = [
      'bengkelin-auto-20261231-100000.sqlite',
      'bengkelin-auto-20260930-100000-2.sqlite',
      'bengkelin-auto-20260930-100000.sqlite',
      'bengkelin-auto-20260101-235959.sqlite',
    ];
    names.forEach((name, i) => {
      writeFileSync(path.join(dir, name), name);
      const at = new Date(T0 + i * MINUTE);
      utimesSync(path.join(dir, name), at, at);
    });
    expect(pruneAutoBackups(dir, 2).sort()).toEqual([
      'bengkelin-auto-20260930-100000-2.sqlite',
      'bengkelin-auto-20261231-100000.sqlite',
    ]);
    expect(files(dir)).toEqual([
      'bengkelin-auto-20260101-235959.sqlite',
      'bengkelin-auto-20260930-100000.sqlite',
    ]);
  });

  test('pruneAutoBackups: the protected file is always kept; recorded runs are ordered by run id', () => {
    const dir = path.join(scratch, 'recorded');
    mkdirSync(dir);
    const names = [
      'bengkelin-auto-20261201-100000.sqlite', // run 1 (oldest run)
      'bengkelin-auto-20261202-100000.sqlite', // run 2
      'bengkelin-auto-20260101-100000.sqlite', // run 3 (clock went back)
      'bengkelin-auto-20250101-100000.sqlite', // unrecorded
    ];
    for (const name of names) writeFileSync(path.join(dir, name), name);
    const deleted = pruneAutoBackups(dir, 2, {
      protect: 'bengkelin-auto-20250101-100000.sqlite',
      recordedNewestFirst: [names[2]!, names[1]!, names[0]!],
    });
    expect(deleted.sort()).toEqual([names[0]!, names[1]!].sort());
    expect(files(dir)).toEqual([names[3]!, names[2]!].sort());
  });

  test('clock went backwards: the new automatic backup survives pruning and the oldest runs go (C2a)', async () => {
    // 31 automatic backups recorded while the clock was ~1 month ahead.
    const future = Date.UTC(2026, 10, 1, 3);
    const recorded: string[] = [];
    for (let i = 0; i < 31; i += 1) {
      nowMs = future + i * DAY;
      const summary = await backups().createValidatedBackup({ kind: 'AUTO' });
      recorded.push(summary.fileName);
    }
    expect(files(h.backupsDir)).toHaveLength(30);
    // The clock is corrected (back to T0).
    nowMs = T0;
    const summary = await backups().createValidatedBackup({ kind: 'AUTO' });
    const remaining = files(h.backupsDir);
    expect(remaining).toContain(summary.fileName);
    expect(remaining).toHaveLength(30);
    // Pruned by run order: the two oldest runs, not the newest file.
    expect(remaining).not.toContain(recorded[0]);
    expect(remaining).not.toContain(recorded[1]);
    expect(remaining).toContain(recorded[30]);
  });
});

// ---- scheduling ----

describe('automatic schedule', () => {
  test('at most once per shop business day, across shop midnight', async () => {
    const auto = backups();
    // 2026-09-30 23:50 WIB.
    nowMs = Date.UTC(2026, 8, 30, 16, 50);
    expect(await auto.runAutomaticBackupIfDue()).toBe('SUCCEEDED');
    nowMs += 5 * MINUTE; // 23:55 WIB, same business day
    expect(await auto.runAutomaticBackupIfDue()).toBe('NOT_DUE');
    nowMs += 15 * MINUTE; // 00:10 WIB, the next business day
    expect(await auto.runAutomaticBackupIfDue()).toBe('SUCCEEDED');
    nowMs += 6 * HOUR;
    expect(await auto.runAutomaticBackupIfDue()).toBe('NOT_DUE');
    expect(files(h.backupsDir)).toEqual([
      'bengkelin-auto-20260930-235000.sqlite',
      'bengkelin-auto-20261001-001000.sqlite',
    ]);
    // A manual backup does not count as the day's automatic backup.
    nowMs += DAY;
    await auto.createValidatedBackup({ kind: 'MANUAL' });
    expect(await auto.runAutomaticBackupIfDue()).toBe('SUCCEEDED');
  });

  test('the scheduler checks every 15 minutes and catches up at startup without blocking', async () => {
    const timers = new FakeTimers();
    let scheduler = new BackupScheduler({ backups: backups(), timers });
    scheduler.start();
    // Nothing ran synchronously: startup (window creation) is not delayed.
    expect(runs()).toEqual([]);
    expect(timers.timeouts).toHaveLength(1);
    expect(timers.intervals.map((i) => i.ms)).toEqual([15 * MINUTE]);
    timers.fireTimeouts();
    await scheduler.whenIdle();
    expect(runs()).toMatchObject([{ kind: 'AUTO', outcome: 'SUCCEEDED' }]);

    nowMs += 15 * MINUTE;
    timers.fireInterval();
    await scheduler.whenIdle();
    expect(runs()).toHaveLength(1);
    scheduler.stop();
    expect(timers.intervals.every((i) => i.cleared)).toBe(true);

    // The app is closed overnight and started on a later business day.
    nowMs = Date.UTC(2026, 9, 2, 1, 0); // 2026-10-02 08:00 WIB
    h.reopen();
    const restarted = new FakeTimers();
    scheduler = new BackupScheduler({ backups: backups(), timers: restarted });
    scheduler.start();
    expect(runs()).toHaveLength(1);
    restarted.fireTimeouts();
    await scheduler.whenIdle();
    expect(runs().map((r) => r.file_name)).toEqual([
      'bengkelin-auto-20260930-100000.sqlite',
      'bengkelin-auto-20261002-080000.sqlite',
    ]);
    scheduler.stop();
  });

  test('overlapping checks never run two automatic backups', async () => {
    const timers = new FakeTimers();
    const scheduler = new BackupScheduler({ backups: backups(), timers });
    scheduler.start();
    timers.fireTimeouts();
    timers.fireInterval();
    timers.fireInterval();
    await scheduler.whenIdle();
    expect(runs()).toHaveLength(1);
    scheduler.stop();
  });

  test('a success recorded while the clock was ahead does not stall the schedule (C2b)', async () => {
    const auto = backups();
    nowMs = T0 + 10 * DAY; // the clock is 10 days ahead
    expect(await auto.runAutomaticBackupIfDue()).toBe('SUCCEEDED');
    nowMs = T0; // corrected
    expect(auto.isAutomaticBackupDue()).toBe(true);
    expect(await auto.runAutomaticBackupIfDue()).toBe('SUCCEEDED');
    nowMs += 5 * MINUTE;
    expect(await auto.runAutomaticBackupIfDue()).toBe('NOT_DUE');
    const log = readdirSync(h.logDir)
      .map((f) => readFileSync(path.join(h.logDir, f), 'utf8'))
      .join('\n');
    expect(log).toContain('backup.clock_skew');
    expect(log).not.toContain(h.backupsDir);
  });

  test('no automatic backup before first-run setup', async () => {
    const fresh = createHarness({ clock });
    try {
      expect(await fresh.services.backups.runAutomaticBackupIfDue()).toBe(
        'NOT_DUE',
      );
      expect(files(fresh.backupsDir)).toEqual([]);
    } finally {
      fresh.close();
    }
  });
});

// ---- failure notice ----

describe('automatic backup failure notice', () => {
  test('persists across restarts until a later success; manual failures raise none', async () => {
    const usb = path.join(scratch, 'usb');
    mkdirSync(usb);
    value(await chooseDestination(usb));
    rmSync(usb, { recursive: true });

    // A failed MANUAL backup is shown inline only.
    failure(await h.call(C.backups.create, undefined, ADMIN_WINDOW));
    expect(value(await status()).notice).toBeNull();

    expect(await backups().runAutomaticBackupIfDue()).toBe('FAILED');
    const failedAt = now();
    const noticed = value(await status());
    expect(noticed.notice).toEqual({
      errorCode: 'BACKUP_DESTINATION_UNAVAILABLE',
      failedAt,
    });
    expect(noticed.lastAutomatic).toMatchObject({
      kind: 'AUTO',
      outcome: 'FAILED',
      errorCode: 'BACKUP_DESTINATION_UNAVAILABLE',
    });

    // Not retried on every 15-minute check...
    nowMs += 15 * MINUTE;
    expect(await backups().runAutomaticBackupIfDue()).toBe('NOT_DUE');
    // ...and the notice survives a restart (derived from backup_runs).
    h.reopen();
    value(
      await h.call(
        C.auth.login,
        { username: 'admin', password: 'correct-horse-battery' },
        ADMIN_WINDOW,
      ),
    );
    expect(value(await status()).notice).toEqual({
      errorCode: 'BACKUP_DESTINATION_UNAVAILABLE',
      failedAt,
    });

    // The drive is back: the next retry succeeds and clears the notice.
    mkdirSync(usb);
    nowMs += HOUR;
    expect(await backups().runAutomaticBackupIfDue()).toBe('SUCCEEDED');
    const cleared = value(await status());
    expect(cleared.notice).toBeNull();
    expect(files(usb)).toHaveLength(1);
  });

  test('"Backup now" (manual) success also clears the notice', async () => {
    const usb = path.join(scratch, 'usb');
    mkdirSync(usb);
    value(await chooseDestination(usb));
    rmSync(usb, { recursive: true });
    expect(await backups().runAutomaticBackupIfDue()).toBe('FAILED');
    expect(value(await status()).notice).not.toBeNull();
    mkdirSync(usb);
    value(await h.call(C.backups.create, undefined, ADMIN_WINDOW));
    expect(value(await status()).notice).toBeNull();
  });

  test('failures are logged without paths or personal data', async () => {
    const usb = path.join(scratch, 'toko-budi-santoso');
    mkdirSync(usb);
    value(await chooseDestination(usb));
    rmSync(usb, { recursive: true });
    expect(await backups().runAutomaticBackupIfDue()).toBe('FAILED');
    const log = readdirSync(h.logDir)
      .map((f) => readFileSync(path.join(h.logDir, f), 'utf8'))
      .join('\n');
    expect(log).toContain('backup.failed');
    expect(log).toContain('BACKUP_DESTINATION_UNAVAILABLE');
    expect(log).not.toContain('budi');
    expect(log).not.toContain(scratch);
  });
});

// ---- ADMIN API ----

describe('backups API', () => {
  test('CASHIER is forbidden and signed-out callers are rejected', async () => {
    for (const channel of [
      C.backups.create,
      C.backups.status,
      C.backups.chooseDestination,
    ]) {
      expect(
        failure(await h.call(channel, undefined, CASHIER_WINDOW)).code,
      ).toBe('FORBIDDEN');
      expect(failure(await h.call(channel, undefined, NOBODY)).code).toBe(
        'UNAUTHENTICATED',
      );
    }
    expect(dialogs.backupDirCalls).toBe(0);
    expect(files(h.backupsDir)).toEqual([]);
    expect(runs()).toEqual([]);
  });

  test('the renderer can never pass a path', async () => {
    for (const channel of [C.backups.create, C.backups.chooseDestination]) {
      expect(
        failure(await h.call(channel, { path: scratch }, ADMIN_WINDOW)).code,
      ).toBe('VALIDATION_FAILED');
    }
    expect(
      failure(
        await h.call(
          C.backups.create,
          { destinationDir: scratch },
          ADMIN_WINDOW,
        ),
      ).code,
    ).toBe('VALIDATION_FAILED');
  });

  test('ADMIN manual backup: summary, file, run and audit', async () => {
    const summary = value(
      await h.call<BackupSummary>(C.backups.create, undefined, ADMIN_WINDOW),
    );
    expect(summary).toMatchObject({
      kind: 'MANUAL',
      fileName: 'bengkelin-manual-20260930-100000.sqlite',
      schemaVersion: latestBundledVersion,
      applicationId: APPLICATION_ID,
      createdAt: now(),
    });
    expect(existsSync(path.join(h.backupsDir, summary.fileName))).toBe(true);
    const audit = h.db
      .prepare(
        `SELECT action, entity_type, entity_id, metadata FROM audit_log
          WHERE action = 'DATABASE_BACKUP_CREATED'`,
      )
      .all() as { metadata: string; entity_type: string; entity_id: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entity_type: 'backup',
      entity_id: summary.fileName,
    });
    expect(JSON.parse(audit[0]!.metadata)).toEqual({
      kind: 'MANUAL',
      fileName: summary.fileName,
      size: summary.size,
      schemaVersion: latestBundledVersion,
    });
    // Automatic and safety backups are not business actions of a cashier.
    await backups().createValidatedBackup({ kind: 'AUTO' });
    await backups().createValidatedBackup({ kind: 'SAFETY' });
    expect(
      h.db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'DATABASE_BACKUP_CREATED'`,
        )
        .get(),
    ).toEqual({ n: 1n });
  });

  test('status: destination, recent runs, next automatic backup', async () => {
    let current = value(await status());
    expect(current).toEqual({
      destination: { path: h.backupsDir, isDefault: true },
      lastAutomatic: null,
      lastSuccessfulAutomatic: null,
      recentRuns: [],
      nextAutomaticAt: now(),
      notice: null,
    });
    await backups().runAutomaticBackupIfDue();
    value(await h.call(C.backups.create, undefined, ADMIN_WINDOW));
    current = value(await status());
    expect(current.lastAutomatic).toEqual({
      kind: 'AUTO',
      outcome: 'SUCCEEDED',
      startedAt: now(),
      finishedAt: now(),
      fileName: 'bengkelin-auto-20260930-100000.sqlite',
      errorCode: null,
    });
    expect(current.lastSuccessfulAutomatic).toEqual(current.lastAutomatic);
    expect(current.recentRuns.map((r) => r.kind)).toEqual(['MANUAL', 'AUTO']);
    // Next: the start of the next shop business day (2026-10-01 00:00 WIB).
    expect(current.nextAutomaticAt).toBe('2026-09-30T17:00:00.000Z');
  });

  test('chooseDestination: native dialog in main, stored, audited; cancel keeps it', async () => {
    const target = path.join(scratch, 'flashdisk');
    mkdirSync(target);
    const chosen = value(await chooseDestination(target));
    expect(chosen.outcome).toBe('UPDATED');
    expect(chosen.status.destination).toEqual({
      path: target,
      isDefault: false,
    });
    expect(dialogs.backupDirCalls).toBe(1);
    expect(
      h.db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'BACKUP_DESTINATION_CHANGED'`,
        )
        .get(),
    ).toEqual({ n: 1n });

    const summary = value(
      await h.call<BackupSummary>(C.backups.create, undefined, ADMIN_WINDOW),
    );
    expect(files(target)).toEqual([summary.fileName]);

    const cancelled = value(
      await h.call<BackupDestinationChoiceDto>(
        C.backups.chooseDestination,
        undefined,
        ADMIN_WINDOW,
      ),
    );
    expect(cancelled.outcome).toBe('CANCELLED');
    expect(cancelled.status.destination.path).toBe(target);

    // The setting survives a restart.
    h.reopen();
    value(
      await h.call(
        C.auth.login,
        { username: 'admin', password: 'correct-horse-battery' },
        ADMIN_WINDOW,
      ),
    );
    expect(value(await status()).destination.path).toBe(target);
  });

  test('chooseDestination rejects a missing or read-only folder', async () => {
    expect(
      failure(await chooseDestination(path.join(scratch, 'missing'))).code,
    ).toBe('BACKUP_DESTINATION_UNAVAILABLE');
    const locked = path.join(scratch, 'locked');
    mkdirSync(locked);
    vi.mocked(accessSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    });
    expect(failure(await chooseDestination(locked)).code).toBe(
      'BACKUP_DESTINATION_READ_ONLY',
    );
    expect(value(await status()).destination.isDefault).toBe(true);
  });
});

// ---- migration 011 ----

describe('migration 011 on a populated version-10 database', () => {
  const v10 = bundledMigrations.filter((m) => m.version <= 10);

  test('adds backup_runs and the backup folder setting without touching data', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bengkelin-v10-'));
    const file = path.join(dir, 'db.sqlite');
    try {
      let db = openDatabase(file);
      migrateDatabase(db, v10);
      expect(readSchemaVersion(db)).toBe(10);
      const services = createApplicationServices({
        db,
        clock,
        logDir: path.join(dir, 'logs'),
        openPath: async () => '',
      });
      const commands = new Map(
        buildCommands(services).map((c) => [c.channel, c]),
      );
      const call = async <T>(channel: string, input?: unknown, windowId = 1) =>
        (await executeCommand(
          commands.get(channel)!,
          { windowId },
          input,
          services.logger,
        )) as Result<T>;
      await withCurrentCustomerColumns(db, async () => {
        const v10shop = await seedPrintShop(call, now);
        await criticalInvoice(v10shop, priceStart());
      });

      const tables = (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          )
          .all() as { name: string }[]
      ).map((t) => t.name);
      expect(tables).not.toContain('backup_runs');
      const dump = () =>
        Object.fromEntries(
          tables.map((name) => [
            name,
            db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
          ]),
        );
      const before = dump();
      const schemaBefore = db
        .prepare(
          `SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'index') ORDER BY name`,
        )
        .all();
      db.close();

      db = openDatabase(file);
      migrateDatabase(
        db,
        bundledMigrations.filter((m) => m.version <= 11),
      );
      expect(readSchemaVersion(db)).toBe(11);
      const after = dump();
      for (const name of tables) {
        if (name === 'settings') continue;
        expect(after[name], name).toEqual(before[name]);
      }
      const settingsBefore = (before.settings as Record<string, unknown>[])[0]!;
      const settingsAfter = (after.settings as Record<string, unknown>[])[0]!;
      for (const [key, v] of Object.entries(settingsBefore)) {
        expect(settingsAfter[key], key).toEqual(v);
      }
      expect(settingsAfter.backup_directory).toBeNull();
      expect(db.prepare('SELECT COUNT(*) AS n FROM backup_runs').get()).toEqual(
        { n: 0n },
      );
      const schemaAfter = db
        .prepare(
          `SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'index') ORDER BY name`,
        )
        .all();
      for (const entry of schemaBefore)
        expect(schemaAfter).toContainEqual(entry);

      // Constraints of the new table.
      const insert = db.prepare(
        `INSERT INTO backup_runs (kind, started_at, finished_at, outcome, file_name, error_code, destination_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const t = now();
      expect(() =>
        insert.run('WEEKLY', t, t, 'SUCCEEDED', 'x.sqlite', null, dir),
      ).toThrow();
      expect(() =>
        insert.run('AUTO', t, t, 'SUCCEEDED', null, null, dir),
      ).toThrow();
      expect(() =>
        insert.run('AUTO', t, t, 'FAILED', null, null, dir),
      ).toThrow();
      expect(() =>
        insert.run('AUTO', 'yesterday', t, 'FAILED', null, 'X', dir),
      ).toThrow();
      insert.run('AUTO', t, t, 'FAILED', null, 'BACKUP_WRITE_FAILED', dir);
      expect(() =>
        db.exec(`UPDATE backup_runs SET outcome = 'SUCCEEDED'`),
      ).toThrow();
      expect(() => db.exec('DELETE FROM backup_runs')).toThrow();
      expect(() =>
        db.exec(`UPDATE settings SET backup_directory = '' WHERE id = 1`),
      ).toThrow();
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      db.close();

      // The upgraded database backs up and validates with the new code.
      db = openDatabase(file);
      const upgraded = new BackupService({
        db,
        clock,
        logger: noopLogger,
        defaultDir: path.join(dir, 'backups'),
        dialogs,
      });
      const summary = await upgraded.createValidatedBackup({ kind: 'SAFETY' });
      expect(
        validateBackup(path.join(dir, 'backups', summary.fileName)),
      ).toMatchObject({ ok: true, schemaVersion: 11 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
