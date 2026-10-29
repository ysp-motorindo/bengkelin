import { withCurrentCustomerColumns } from './helpers/legacy-customers';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApplicationServices } from '@/main/compose';
import { openDatabase } from '@/main/database/connection';
import {
  bundledMigrations,
  latestBundledVersion,
  migrateDatabase,
  readSchemaVersion,
} from '@/main/database/migrate';
import type { RestoreStep } from '@/main/features/backups/restore';
import {
  nodeRestoreFs,
  readMarker,
  restoreLayout,
  writeMarker,
  type RestoreFs,
} from '@/main/features/backups/restore-fs';
import { recoverInterruptedRestore } from '@/main/features/backups/restore-recovery';
import {
  asidePathFor,
  performSwap,
  SWAP_STEPS,
  type SwapPlan,
  type SwapStep,
} from '@/main/features/backups/restore-swap';
import { validateBackup } from '@/main/features/backups/validation';
import { executeCommand } from '@/main/platform/command';
import { buildCommands } from '@/main/platform/commands';
import type { Logger } from '@/main/platform/logger';
import { MaintenanceGate } from '@/main/platform/maintenance';
import { CHANNELS } from '@/shared/channels';
import type {
  BackupSummary,
  DraftView,
  RestoreInspectionDto,
  RestorePreviewDto,
  RestoreStartedDto,
} from '@/shared/contracts';
import { DomainError, type Instant, type Result } from '@/shared/primitives';
import { toInstant } from '@/shared/time';
import {
  ADMIN_WINDOW,
  CASHIER_WINDOW,
  criticalInvoice,
  FIXTURE_ADMIN_PASSWORD,
  FIXTURE_CASHIER_PASSWORD,
  fixtureId,
  issueInvoice,
  seedPrintShop,
  type PrintShop,
} from '../fixtures/print-invoices';
import { FakeDialogs } from './helpers/fake-print';
import { createHarness, failure, value, type Harness } from './helpers/harness';

/**
 * Task 16: safe restore and restart recovery (spec 17, 42, 43, 44, 47, 55,
 * 60; Part A review focus 5). An interruption at any point must leave either
 * the complete old database or the complete restored one, and invoice
 * numbers are never reused.
 * T0 = 2026-09-30 10:00 WIB (Asia/Jakarta).
 */

const C = CHANNELS;
const T0 = Date.UTC(2026, 8, 30, 3, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TTL = 15 * MINUTE;
const OTHER_ADMIN_WINDOW = 3;
const DAY1 = '2026-09-30';
const DAY2 = '2026-10-01';
/** Invoice numbers issued before the backup (A) and after it (B). */
const NEW_NUMBERS = ['INV-20260930-0001'];
const OLD_NUMBERS = ['INV-20260930-0001', 'INV-20260930-0002'];
const SHOP_NAME = 'Bengkel Maju Jaya Motor';

let nowMs = T0;
const now = (): Instant => toInstant(nowMs);
const clock = { now };
const priceStart = () => toInstant(T0 - 30 * DAY);

let h: Harness;
let dialogs: FakeDialogs;
let shop: PrintShop;
let scratch: string;
let relaunches = 0;
let beforeStep: ((step: RestoreStep) => void | Promise<void>) | undefined;
let renameFault: ((from: string, to: string) => void) | undefined;

/** The real fs layer, with an injectable rename failure. */
const faultyFs: RestoreFs = {
  ...nodeRestoreFs,
  rename(from, to) {
    renameFault?.(from, to);
    nodeRestoreFs.rename(from, to);
  },
};

beforeEach(async () => {
  nowMs = T0;
  relaunches = 0;
  beforeStep = undefined;
  renameFault = undefined;
  dialogs = new FakeDialogs();
  h = createHarness({
    clock,
    dialogs,
    restore: {
      relaunch: () => {
        relaunches += 1;
      },
      hooks: { beforeStep: (step) => beforeStep?.(step) },
      fs: faultyFs,
      tokenTtlMs: TTL,
    },
  });
  scratch = mkdtempSync(path.join(tmpdir(), 'bengkelin-restore-'));
  shop = await seedPrintShop(h.call, now);
});
afterEach(() => {
  h.close();
  rmSync(scratch, { recursive: true, force: true });
});

// ---- helpers ----

type RawDb = Database.Database;
const EXCLUDED = new Set([
  'audit_log',
  'command_receipts',
  'invoice_daily_counters',
]);

function openRaw(file: string, readonly = true): RawDb {
  const db = new Database(file, { readonly, fileMustExist: true });
  db.defaultSafeIntegers(true);
  return db;
}

function withFile<T>(file: string, read: (db: RawDb) => T): T {
  const db = openRaw(file);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function tableNames(db: RawDb): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

function rows(db: RawDb, table: string): unknown[] {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
}

/** Every business table, excluding the intentional restore safeguards. */
function businessData(db: RawDb): Record<string, unknown[]> {
  return Object.fromEntries(
    tableNames(db)
      .filter((name) => !EXCLUDED.has(name))
      .map((name) => [name, rows(db, name)]),
  );
}

function issuedNumbers(db: RawDb): string[] {
  return (
    db
      .prepare(
        `SELECT invoice_number FROM invoices WHERE invoice_number IS NOT NULL ORDER BY invoice_number`,
      )
      .all() as { invoice_number: string }[]
  ).map((row) => row.invoice_number);
}

function counters(db: RawDb): Record<string, bigint> {
  return Object.fromEntries(
    (
      db
        .prepare(
          `SELECT business_date, last_sequence FROM invoice_daily_counters ORDER BY business_date`,
        )
        .all() as { business_date: string; last_sequence: bigint }[]
    ).map((row) => [row.business_date, row.last_sequence]),
  );
}

function shopName(db: RawDb): string {
  return (
    db.prepare('SELECT shop_name FROM settings WHERE id = 1').get() as {
      shop_name: string;
    }
  ).shop_name;
}

function integrity(db: RawDb): string {
  return String(db.pragma('integrity_check', { simple: true }));
}

const sha = (file: string) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

const stagingRoot = () => path.join(h.dir, 'restore-staging');
function stagingEntries(): string[] {
  return existsSync(stagingRoot()) ? readdirSync(stagingRoot()).sort() : [];
}
const markerFile = () => path.join(h.dir, 'restore-marker.json');
function asideFiles(): string[] {
  return readdirSync(h.dir)
    .filter((name) => name.includes('.pre-restore-'))
    .sort();
}

function admin<T>(channel: string, input?: unknown, windowId = ADMIN_WINDOW) {
  return h.call<T>(channel, input, windowId);
}

async function backupNow(): Promise<string> {
  const summary = value(await admin<BackupSummary>(C.backups.create));
  return path.join(h.backupsDir, summary.fileName);
}

async function inspect(
  file: string,
  windowId = ADMIN_WINDOW,
): Promise<Result<RestoreInspectionDto>> {
  dialogs.restoreAnswers.push(file);
  return admin<RestoreInspectionDto>(
    C.backups.inspectRestore,
    undefined,
    windowId,
  );
}

async function preview(
  file: string,
  windowId = ADMIN_WINDOW,
): Promise<RestorePreviewDto> {
  const inspection = value(await inspect(file, windowId));
  if (inspection.outcome !== 'READY') throw new Error('expected a preview');
  return inspection.preview;
}

async function restore(
  file: string,
  windowId = ADMIN_WINDOW,
): Promise<Result<RestoreStartedDto>> {
  const { token } = await preview(file, windowId);
  return admin<RestoreStartedDto>(
    C.backups.restore,
    { token, confirmed: true },
    windowId,
  );
}

interface LogLine {
  level: string;
  event: string;
  fields: unknown;
}
function capturingLogger(lines: LogLine[]): Logger {
  return {
    info: (event, fields) => void lines.push({ level: 'info', event, fields }),
    warn: (event, fields) => void lines.push({ level: 'warn', event, fields }),
    error: (event, fields) =>
      void lines.push({ level: 'error', event, fields }),
  };
}

function recover(lines: LogLine[] = []) {
  return recoverInterruptedRestore({
    dataDir: h.dir,
    databasePath: h.file,
    fs: faultyFs,
    logger: capturingLogger(lines),
  });
}

async function relogin(): Promise<void> {
  value(
    await h.call(
      C.auth.login,
      { username: 'admin', password: FIXTURE_ADMIN_PASSWORD },
      ADMIN_WINDOW,
    ),
  );
  value(
    await h.call(
      C.auth.login,
      { username: 'siti', password: FIXTURE_CASHIER_PASSWORD },
      CASHIER_WINDOW,
    ),
  );
}

/** Startup after a (possibly interrupted) restore: recovery, open, login. */
async function restart(lines: LogLine[] = []) {
  const outcome = recover(lines);
  h.reopen();
  await relogin();
  return outcome;
}

function serviceInvoice(title: string) {
  return issueInvoice(shop, {
    lines: [{ custom: { type: 'SERVICE', title, price: '50000' } }],
  });
}

/** A (numbered -0001), a validated backup, then B (-0002). */
async function scenario(): Promise<string> {
  await criticalInvoice(shop, priceStart());
  const backupFile = await backupNow();
  await serviceInvoice('Servis B');
  expect(issuedNumbers(h.db)).toEqual(OLD_NUMBERS);
  return backupFile;
}

function draftAsCashier() {
  return h.call<DraftView>(
    C.drafts.create,
    {
      requestId: fixtureId(),
      channelId: shop.bengkel,
      invoiceDate: DAY1,
      pricingAt: now(),
    },
    CASHIER_WINDOW,
  );
}

function setUserVersion(file: string, version: number): void {
  const db = new Database(file);
  try {
    db.pragma(`user_version = ${version}`);
  } finally {
    db.close();
  }
}

/**
 * Leaves `file` (closed, WAL mode) with a change that exists ONLY in its
 * `-wal`: the main file is put back to its pre-change bytes.
 */
function walOnlyShopName(file: string, name: string): void {
  const before = readFileSync(file);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.prepare('UPDATE settings SET shop_name = ? WHERE id = 1').run(name);
  const wal = readFileSync(`${file}-wal`);
  db.close();
  writeFileSync(file, before);
  writeFileSync(`${file}-wal`, wal);
  rmSync(`${file}-shm`, { force: true });
}

/** A real WAL of the OLD database that would rename the shop if applied. */
function staleWalOfOldDatabase(): Buffer {
  h.db.pragma('wal_checkpoint(TRUNCATE)');
  const copy = path.join(scratch, 'old-copy.sqlite');
  copyFileSync(h.file, copy);
  const db = new Database(copy);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.prepare('UPDATE settings SET shop_name = ? WHERE id = 1').run('STALE WAL');
  db.exec('CREATE TABLE stale_marker (x INTEGER)');
  const wal = readFileSync(`${copy}-wal`);
  db.close();
  expect(wal.length).toBeGreaterThan(32);
  return wal;
}

class SimulatedCrash extends Error {}

// ---- required assertions ----

describe('required assertions', () => {
  // Backup, restore and restart can exceed five seconds on Windows CI.
  test('restores the exact backed-up state, keeps counters ahead and rejects a newer schema', async () => {
    await criticalInvoice(shop, priceStart());
    const backupFile = await backupNow();
    const backedUpBusinessData = withFile(backupFile, businessData);
    const backedUpReceipts = withFile(backupFile, (db) =>
      rows(db, 'command_receipts'),
    );
    const backedUpAudit = withFile(backupFile, (db) => rows(db, 'audit_log'));
    expect(withFile(backupFile, counters)).toEqual({ [DAY1]: 1n });

    // Data B: two more numbers on day 1, one on a day the backup never saw.
    await serviceInvoice('Servis B1');
    await serviceInvoice('Servis B2');
    value(
      await admin(C.customers.save, {
        name: 'Pelanggan Setelah Cadangan',
        phoneNumber: '081299990000',
      }),
    );
    nowMs = T0 + DAY;
    await serviceInvoice('Servis C');
    expect(counters(h.db)).toEqual({ [DAY1]: 3n, [DAY2]: 1n });
    const highestPreviouslyIssuedSequence = Number(counters(h.db)[DAY2]);

    const started = value(await restore(backupFile));
    expect(started.restarting).toBe(true);
    expect(started.safetyBackupFileName).toMatch(
      /^bengkelin-safety-\d{8}-\d{6}\.sqlite$/,
    );
    expect(relaunches).toBe(1);
    expect(h.db.open).toBe(false);
    expect(readMarker(nodeRestoreFs, h.dir)).toMatchObject({
      kind: 'MARKER',
      marker: { stage: 'REPLACED' },
    });

    // Startup: recovery, then the normal open (before anyone signs in).
    const outcome = recover();
    h.reopen();
    expect(outcome.outcome).toBe('RESTORED');
    expect(existsSync(markerFile())).toBe(false);
    expect(stagingEntries()).toEqual([]);

    const restoredBusinessData = businessData(h.db);
    expect(restoredBusinessData).toEqual(backedUpBusinessData);
    // The intentional safeguards, compared separately.
    expect(rows(h.db, 'command_receipts')).toEqual(backedUpReceipts);
    const audit = rows(h.db, 'audit_log') as Record<string, unknown>[];
    expect(audit.slice(0, -1)).toEqual(backedUpAudit);
    const restoredAudit = audit.at(-1)!;
    expect(restoredAudit).toMatchObject({
      cashier_id: null,
      action: 'DATABASE_RESTORED',
      entity_type: 'backup',
      entity_id: path.basename(backupFile),
    });
    expect(JSON.parse(restoredAudit.metadata as string)).toEqual({
      actorUsername: 'admin',
      actorDisplayName: 'Pak Budi',
      sourceFileName: path.basename(backupFile),
      safetyBackupFileName: started.safetyBackupFileName,
      originalSchemaVersion: latestBundledVersion,
      schemaVersion: latestBundledVersion,
    });
    // max(current, backup) per business date, including dates only current had.
    expect(counters(h.db)).toEqual({ [DAY1]: 3n, [DAY2]: 1n });

    // After the restart the login screen: sessions were in memory only.
    expect(
      failure(await h.call(C.drafts.list, undefined, CASHIER_WINDOW)).code,
    ).toBe('UNAUTHENTICATED');
    await relogin();

    const next = await serviceInvoice('Servis setelah pemulihan');
    const nextInvoiceSequence = Number(next.invoiceNumber.split('-')[2]);
    expect(nextInvoiceSequence).toBeGreaterThan(
      highestPreviouslyIssuedSequence,
    );
    expect(next.invoiceNumber).toBe('INV-20261001-0002');

    // The safety backup holds the pre-restore state (B included).
    const safety = path.join(h.backupsDir, started.safetyBackupFileName);
    expect(validateBackup(safety).ok).toBe(true);
    expect(withFile(safety, issuedNumbers)).toEqual([
      'INV-20260930-0001',
      'INV-20260930-0002',
      'INV-20260930-0003',
      'INV-20261001-0001',
    ]);

    const newer = path.join(scratch, 'newer.sqlite');
    copyFileSync(backupFile, newer);
    setUserVersion(newer, latestBundledVersion + 1);
    const newerSchemaRestore = await inspect(newer);
    if (newerSchemaRestore.ok) throw new Error('expected a rejection');
    expect(newerSchemaRestore.error.code).toBe('UNSUPPORTED_SCHEMA');
  }, 30_000);
});

// ---- inspectRestore ----

describe('inspectRestore', () => {
  test('stages a copy, never modifies the original and previews it', async () => {
    await criticalInvoice(shop, priceStart());
    const file = await backupNow();
    const originalHash = sha(file);
    const auditBefore = rows(h.db, 'audit_log');

    const inspection = value(await inspect(file));
    if (inspection.outcome !== 'READY') throw new Error('expected READY');
    const p = inspection.preview;
    const expectedCounts = withFile(file, (db) => {
      const count = (sql: string) =>
        Number((db.prepare(sql).get() as { n: bigint }).n);
      return {
        catalogItems: count('SELECT COUNT(*) AS n FROM catalog_items'),
        customers: count('SELECT COUNT(*) AS n FROM customers'),
        cashiers: count('SELECT COUNT(*) AS n FROM cashiers'),
      };
    });
    expect(p).toEqual({
      token: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expiresAt: toInstant(T0 + TTL),
      sourceFileName: path.basename(file),
      sourceSize: statSync(file).size,
      originalSchemaVersion: latestBundledVersion,
      schemaVersion: latestBundledVersion,
      shopName: SHOP_NAME,
      counts: {
        invoices: { draft: 0, finalized: 1, void: 0 },
        ...expectedCounts,
      },
      latestFinalizedAt: toInstant(T0),
      activeAdmins: 1,
    });
    expect(expectedCounts.cashiers).toBe(2);
    expect(sha(file)).toBe(originalHash);
    expect(stagingEntries()).toEqual([p.token]);
    expect(readdirSync(path.join(stagingRoot(), p.token))).toEqual([
      'candidate.sqlite',
    ]);
    expect(dialogs.restoreCalls).toBe(1);
    // Inspecting writes nothing to the live database.
    expect(rows(h.db, 'audit_log')).toEqual(auditBefore);
  });

  test('a cancelled dialog stages nothing', async () => {
    const result = value(
      await admin<RestoreInspectionDto>(C.backups.inspectRestore),
    );
    expect(result).toEqual({ outcome: 'CANCELLED' });
    expect(stagingEntries()).toEqual([]);
  });

  test.each([
    ['a text file', 'NOT_SQLITE'],
    ['a corrupt database', 'CORRUPT_DATABASE'],
    ['a foreign SQLite database', 'FOREIGN_DATABASE'],
    ['an empty file', 'BACKUP_NOT_FOUND'],
  ])(
    'rejects %s with %s and leaves everything unchanged',
    async (kind, code) => {
      await criticalInvoice(shop, priceStart());
      const backupFile = await backupNow();
      const file = path.join(scratch, 'candidate.sqlite');
      if (kind === 'a text file') {
        writeFileSync(file, 'kode,nama\nB-1,Busi\n'.repeat(20));
      } else if (kind === 'a corrupt database') {
        copyFileSync(backupFile, file);
        truncateSync(file, Math.floor(statSync(file).size / 2));
      } else if (kind === 'a foreign SQLite database') {
        const foreign = new Database(file);
        foreign.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
        foreign.prepare('INSERT INTO notes (body) VALUES (?)').run('bukan');
        foreign.close();
      } else {
        writeFileSync(file, '');
      }
      const originalHash = sha(file);
      const before = businessData(h.db);

      expect(failure(await inspect(file)).code).toBe(code);
      expect(sha(file)).toBe(originalHash);
      expect(stagingEntries()).toEqual([]);
      expect(businessData(h.db)).toEqual(before);
    },
  );

  test('blocks a backup without an active ADMIN (RESTORE_NO_ACTIVE_ADMIN)', async () => {
    const backupFile = await backupNow();
    const file = path.join(scratch, 'no-admin.sqlite');
    copyFileSync(backupFile, file);
    const db = new Database(file);
    db.prepare(`UPDATE cashiers SET is_active = 0 WHERE role = 'ADMIN'`).run();
    db.close();

    expect(failure(await inspect(file)).code).toBe('RESTORE_NO_ACTIVE_ADMIN');
    expect(stagingEntries()).toEqual([]);
  });

  test('a migration failure of the staged copy is RESTORE_MIGRATION_FAILED', async () => {
    const file = path.join(scratch, 'v10-broken.sqlite');
    const db = openDatabase(file);
    migrateDatabase(
      db,
      bundledMigrations.filter((m) => m.version <= 10),
    );
    // Migration 011 creates this table: it will fail on the staged copy.
    db.exec('CREATE TABLE backup_runs (id INTEGER)');
    db.close();
    const originalHash = sha(file);

    expect(failure(await inspect(file)).code).toBe('RESTORE_MIGRATION_FAILED');
    expect(sha(file)).toBe(originalHash);
    expect(stagingEntries()).toEqual([]);
  });

  test('a new inspection replaces the pending one; cancel and expiry delete the staging', async () => {
    const file = await backupNow();
    const first = await preview(file);
    const second = await preview(file);
    expect(stagingEntries()).toEqual([second.token]);
    expect(
      failure(
        await admin(C.backups.restore, { token: first.token, confirmed: true }),
      ).code,
    ).toBe('RESTORE_TOKEN_EXPIRED');

    value(await admin(C.backups.cancelRestore, { token: second.token }));
    expect(stagingEntries()).toEqual([]);
    expect(
      failure(
        await admin(C.backups.restore, {
          token: second.token,
          confirmed: true,
        }),
      ).code,
    ).toBe('RESTORE_TOKEN_EXPIRED');

    const third = await preview(file);
    expect(stagingEntries()).toEqual([third.token]);
    nowMs += TTL + 1;
    expect(
      failure(
        await admin(C.backups.restore, { token: third.token, confirmed: true }),
      ).code,
    ).toBe('RESTORE_TOKEN_EXPIRED');
    expect(stagingEntries()).toEqual([]);
    expect(relaunches).toBe(0);
    expect(h.db.open).toBe(true);
  });

  test('CASHIER is forbidden and signed-out callers are unauthenticated', async () => {
    const file = await backupNow();
    const { token } = await preview(file);
    dialogs.restoreCalls = 0;
    for (const windowId of [CASHIER_WINDOW, 99]) {
      const expected =
        windowId === CASHIER_WINDOW ? 'FORBIDDEN' : 'UNAUTHENTICATED';
      dialogs.restoreAnswers.push(file);
      expect(
        failure(await h.call(C.backups.inspectRestore, undefined, windowId))
          .code,
      ).toBe(expected);
      expect(
        failure(
          await h.call(C.backups.restore, { token, confirmed: true }, windowId),
        ).code,
      ).toBe(expected);
      expect(
        failure(await h.call(C.backups.cancelRestore, { token }, windowId))
          .code,
      ).toBe(expected);
      dialogs.restoreAnswers.length = 0;
    }
    expect(dialogs.restoreCalls).toBe(0);
    expect(stagingEntries()).toEqual([token]);
    expect(relaunches).toBe(0);
  });

  test('restore requires confirmed === true and accepts no path from the renderer', async () => {
    const file = await backupNow();
    const { token } = await preview(file);
    for (const input of [
      { token },
      { token, confirmed: false },
      { token, confirmed: 'true' },
      { token, confirmed: true, path: file },
    ]) {
      expect(failure(await admin(C.backups.restore, input)).code).toBe(
        'VALIDATION_FAILED',
      );
    }
    expect(
      failure(await admin(C.backups.inspectRestore, { path: file })).code,
    ).toBe('VALIDATION_FAILED');
    expect(relaunches).toBe(0);
    expect(stagingEntries()).toEqual([token]);
  });
});

// ---- restore ----

describe('restore', () => {
  test('an older-schema populated backup is migrated and restored', async () => {
    const v10File = path.join(scratch, 'v10.sqlite');
    let v10Data: Record<string, unknown[]>;
    let v10shop: PrintShop;
    {
      const db = openDatabase(v10File);
      migrateDatabase(
        db,
        bundledMigrations.filter((m) => m.version <= 10),
      );
      const services = createApplicationServices({
        db,
        clock,
        logDir: path.join(scratch, 'v10-logs'),
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
      v10shop = await withCurrentCustomerColumns(db, async () => {
        const seeded = await seedPrintShop(call, now);
        await criticalInvoice(seeded, priceStart());
        return seeded;
      });
      v10Data = businessData(db);
      db.close();
    }
    expect(
      withFile(v10File, (db) =>
        Number(db.pragma('user_version', { simple: true })),
      ),
    ).toBe(10);

    await criticalInvoice(shop, priceStart());
    await serviceInvoice('Servis B');
    const p = await preview(v10File);
    expect(p.originalSchemaVersion).toBe(10);
    expect(p.schemaVersion).toBe(latestBundledVersion);
    value(await admin(C.backups.restore, { token: p.token, confirmed: true }));
    expect((await restart()).outcome).toBe('RESTORED');

    expect(readSchemaVersion(h.db)).toBe(latestBundledVersion);
    const restored = businessData(h.db);
    for (const [table, data] of Object.entries(v10Data)) {
      if (table === 'settings') continue;
      if (table === 'customers') {
        expect(restored[table], table).toEqual(
          data.map((row) => ({
            ...(row as object),
            is_active: 1n,
            external_id: null,
          })),
        );
      } else if (table === 'cashiers') {
        expect(restored[table], table).toEqual(
          data.map((row) => ({
            ...(row as object),
            language: 'id',
            appearance: 'SYSTEM',
            number_format: 'ID',
          })),
        );
      } else expect(restored[table], table).toEqual(data);
    }
    expect(shopName(h.db)).toBe(SHOP_NAME);
    expect(issuedNumbers(h.db)).toEqual(['INV-20260930-0001']);
    // The live database had issued -0002 today: that number stays used.
    expect(counters(h.db)).toEqual({ [DAY1]: 2n });
    // The restored shop's own reference ids, through the live command table.
    const next = await issueInvoice(
      { ...v10shop, call: h.call },
      {
        lines: [
          {
            custom: {
              type: 'SERVICE',
              title: 'Servis setelah pemulihan',
              price: '50000',
            },
          },
        ],
      },
    );
    expect(next.invoiceNumber).toBe('INV-20260930-0003');
  });

  test('a failed safety backup aborts with nothing changed', async () => {
    const backupFile = await scenario();
    const usb = path.join(scratch, 'usb');
    mkdirSync(usb);
    dialogs.backupDirAnswers.push(usb);
    value(await admin(C.backups.chooseDestination));
    rmSync(usb, { recursive: true });
    const before = businessData(h.db);
    delete before.backup_runs;
    const { token } = await preview(backupFile);

    const result = await admin(C.backups.restore, { token, confirmed: true });
    expect(failure(result).code).toBe('RESTORE_SAFETY_BACKUP_FAILED');

    const after = businessData(h.db);
    delete after.backup_runs;
    expect(after).toEqual(before);
    expect(h.db.open).toBe(true);
    expect(relaunches).toBe(0);
    expect(existsSync(markerFile())).toBe(false);
    expect(stagingEntries()).toEqual([]);
    expect(asideFiles()).toEqual([]);
    // Writes are allowed again and the token was used up.
    value(await draftAsCashier());
    expect(
      failure(await admin(C.backups.restore, { token, confirmed: true })).code,
    ).toBe('RESTORE_TOKEN_EXPIRED');
    expect((await restart()).outcome).toBe('NO_MARKER');
    expect(issuedNumbers(h.db)).toEqual(OLD_NUMBERS);
  });

  test('RESTORE_IN_PROGRESS blocks every write while restoring; reads continue', async () => {
    const backupFile = await scenario();
    const { token } = await preview(backupFile);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const atSafetyBackup = new Promise<void>((resolve) => {
      reached = resolve;
    });
    beforeStep = async (step) => {
      if (step !== 'safetyBackup') return;
      reached();
      await paused;
    };

    const pending = admin<RestoreStartedDto>(C.backups.restore, {
      token,
      confirmed: true,
    });
    await atSafetyBackup;

    expect(failure(await draftAsCashier()).code).toBe('RESTORE_IN_PROGRESS');
    expect(
      failure(
        await admin(C.customers.save, {
          name: 'Tidak Boleh',
          phoneNumber: '081200000001',
        }),
      ).code,
    ).toBe('RESTORE_IN_PROGRESS');
    expect(failure(await admin(C.backups.create)).code).toBe(
      'RESTORE_IN_PROGRESS',
    );
    expect(failure(await inspect(backupFile)).code).toBe('RESTORE_IN_PROGRESS');
    expect(
      failure(await admin(C.backups.restore, { token, confirmed: true })).code,
    ).toBe('RESTORE_IN_PROGRESS');
    // Reads continue.
    value(await h.call(C.invoices.search, { filters: {} }, CASHIER_WINDOW));
    value(await h.call(C.drafts.list, undefined, CASHIER_WINDOW));

    release();
    value(await pending);
    expect(relaunches).toBe(1);
    // Once the connection is closed even reads are refused (restarting).
    expect(
      failure(await h.call(C.drafts.list, undefined, CASHIER_WINDOW)).code,
    ).toBe('RESTORE_IN_PROGRESS');
    expect((await restart()).outcome).toBe('RESTORED');
    expect(issuedNumbers(h.db)).toEqual(NEW_NUMBERS);
  });

  test('audits the pre-restore actor even when that cashier is not in the backup', async () => {
    const backupFile = await scenario();
    value(
      await admin(C.cashiers.create, {
        username: 'rina',
        displayName: 'Rina Kartika',
        password: 'rina-password-1',
        role: 'ADMIN',
      }),
    );
    value(
      await h.call(
        C.auth.login,
        { username: 'rina', password: 'rina-password-1' },
        OTHER_ADMIN_WINDOW,
      ),
    );
    const started = value(await restore(backupFile, OTHER_ADMIN_WINDOW));
    expect((await restart()).outcome).toBe('RESTORED');

    const cashiers = (
      h.db.prepare('SELECT username FROM cashiers ORDER BY username').all() as {
        username: string;
      }[]
    ).map((row) => row.username);
    expect(cashiers).toEqual(['admin', 'siti']);
    const last = h.db
      .prepare(
        `SELECT cashier_id, action, metadata FROM audit_log WHERE action = 'DATABASE_RESTORED'`,
      )
      .get() as { cashier_id: string | null; action: string; metadata: string };
    expect(last.cashier_id).toBeNull();
    expect(last.action).toBe('DATABASE_RESTORED');
    expect(JSON.parse(last.metadata)).toMatchObject({
      actorUsername: 'rina',
      actorDisplayName: 'Rina Kartika',
      sourceFileName: path.basename(backupFile),
      safetyBackupFileName: started.safetyBackupFileName,
    });
  });

  test('a backup of uncheckpointed WAL-era data restores that data', async () => {
    h.db.pragma('wal_checkpoint(TRUNCATE)');
    h.db.pragma('wal_autocheckpoint = 0');
    const a = await criticalInvoice(shop, priceStart());
    expect(statSync(`${h.file}-wal`).size).toBeGreaterThan(0);
    const backupFile = await backupNow();
    await serviceInvoice('Servis B');

    value(await restore(backupFile));
    expect((await restart()).outcome).toBe('RESTORED');
    expect(issuedNumbers(h.db)).toEqual([a.invoiceNumber]);
    expect(
      h.db.prepare('SELECT status FROM invoices WHERE id = ?').get(a.id),
    ).toEqual({ status: 'FINALIZED' });
  });

  test('a stale -wal at the target during the swap is never applied', async () => {
    const backupFile = await scenario();
    const expected = withFile(backupFile, businessData);
    const staleWal = staleWalOfOldDatabase();
    beforeStep = (step) => {
      if (step === 'removeStaleSidecars') {
        writeFileSync(`${h.file}-wal`, staleWal);
      }
    };
    value(await restore(backupFile));
    expect(existsSync(`${h.file}-wal`)).toBe(false);
    expect((await restart()).outcome).toBe('RESTORED');
    expect(businessData(h.db)).toEqual(expected);
    expect(shopName(h.db)).toBe(SHOP_NAME);
    expect(tableNames(h.db)).not.toContain('stale_marker');
    expect(integrity(h.db)).toBe('ok');
  });

  test('a stale -wal/-shm appearing before startup recovery is never applied', async () => {
    const backupFile = await scenario();
    const expected = withFile(backupFile, businessData);
    const staleWal = staleWalOfOldDatabase();
    value(await restore(backupFile));
    writeFileSync(`${h.file}-wal`, staleWal);
    writeFileSync(`${h.file}-shm`, Buffer.alloc(32_768));

    expect((await restart()).outcome).toBe('RESTORED');
    expect(businessData(h.db)).toEqual(expected);
    expect(tableNames(h.db)).not.toContain('stale_marker');
    expect(integrity(h.db)).toBe('ok');
  });

  test.each([
    'drain',
    'safetyBackup',
    'stageSafeguards',
    'closeStaged',
    'revalidate',
    'markPrepared',
    'closeLive',
  ] as const)(
    'a failure before the live connection closes (%s) leaves the old database untouched',
    async (step) => {
      const backupFile = await scenario();
      const before = businessData(h.db);
      delete before.backup_runs;
      const { token } = await preview(backupFile);
      beforeStep = (current) => {
        if (current === step) throw new Error(`injected at ${step}`);
      };

      const result = await admin(C.backups.restore, { token, confirmed: true });
      expect(failure(result).code).toBe('RESTORE_FAILED');
      beforeStep = undefined;
      expect(h.db.open).toBe(true);
      expect(relaunches).toBe(0);
      expect(existsSync(markerFile())).toBe(false);
      expect(stagingEntries()).toEqual([]);
      expect(asideFiles()).toEqual([]);
      // The maintenance flag is cleared: writes work again.
      value(await draftAsCashier());

      expect((await restart()).outcome).toBe('NO_MARKER');
      const after = businessData(h.db);
      delete after.backup_runs;
      delete after.invoices;
      delete before.invoices;
      expect(after).toEqual(before);
      expect(issuedNumbers(h.db)).toEqual(OLD_NUMBERS);
    },
  );

  test.each([
    ['moveAsideMain', 'KEPT_CURRENT', 'OLD'],
    ['moveAsideWal', 'ROLLED_BACK', 'OLD'],
    ['moveAsideShm', 'ROLLED_BACK', 'OLD'],
    ['markMovedAside', 'ROLLED_BACK', 'OLD'],
    ['removeStaleSidecars', 'RESTORED', 'NEW'],
    ['swapIn', 'RESTORED', 'NEW'],
    ['markReplaced', 'RESTORED', 'NEW'],
    ['relaunch', 'RESTORED', 'NEW'],
  ] as const)(
    'a crash at %s: startup recovery reports %s and the %s database is complete',
    async (step, outcome, database) => {
      const backupFile = await scenario();
      const oldData = businessData(h.db);
      const newData = withFile(backupFile, businessData);
      const { token } = await preview(backupFile);
      beforeStep = (current) => {
        if (current === step) throw new SimulatedCrash(step);
      };

      const result = await admin(C.backups.restore, { token, confirmed: true });
      expect(failure(result).code).toBe('RESTORE_FAILED');
      beforeStep = undefined;
      // The connection is already closed: the app restarts either way.
      expect(h.db.open).toBe(false);
      expect(relaunches).toBe(1);
      expect(existsSync(markerFile())).toBe(true);

      expect((await restart()).outcome).toBe(outcome);
      expect(existsSync(markerFile())).toBe(false);
      expect(stagingEntries()).toEqual([]);
      expect(validateBackup(h.file).ok).toBe(true);
      expect(integrity(h.db)).toBe('ok');
      const data = businessData(h.db);
      if (database === 'OLD') {
        expect(issuedNumbers(h.db)).toEqual(OLD_NUMBERS);
        delete data.backup_runs;
        delete oldData.backup_runs;
        expect(data).toEqual(oldData);
      } else {
        expect(issuedNumbers(h.db)).toEqual(NEW_NUMBERS);
        expect(data).toEqual(newData);
        expect(asideFiles().length).toBeGreaterThan(0);
      }
    },
  );

  test('a failed rename while swapping in rolls forward at startup', async () => {
    const backupFile = await scenario();
    renameFault = (from, to) => {
      if (to === h.file && from.includes('restore-staging')) {
        throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      }
    };
    expect(failure(await restore(backupFile)).code).toBe('RESTORE_FAILED');
    expect(relaunches).toBe(1);
    expect(readMarker(nodeRestoreFs, h.dir)).toMatchObject({
      marker: { stage: 'MOVED_ASIDE' },
    });

    renameFault = undefined;
    expect((await restart()).outcome).toBe('RESTORED');
    expect(issuedNumbers(h.db)).toEqual(NEW_NUMBERS);
  });

  test('a rename that keeps failing at startup rolls back to the old database', async () => {
    const backupFile = await scenario();
    renameFault = (from, to) => {
      if (to === h.file && from.includes('restore-staging')) {
        throw Object.assign(new Error('permission'), { code: 'EPERM' });
      }
    };
    expect(failure(await restore(backupFile)).code).toBe('RESTORE_FAILED');
    expect((await restart()).outcome).toBe('ROLLED_BACK');
    expect(issuedNumbers(h.db)).toEqual(OLD_NUMBERS);
    expect(asideFiles()).toEqual([]);
  });
});

// ---- the swap state machine and startup recovery ----

describe('swap state machine and startup recovery', () => {
  const WAL_NAME = 'Nama Hanya di WAL';

  /** The staged file (a validated backup) and a plan to swap it in. */
  async function prepared(): Promise<{
    plan: SwapPlan;
    backupFile: string;
  }> {
    const backupFile = await scenario();
    const staged = path.join(stagingRoot(), 'manual', 'candidate.sqlite');
    mkdirSync(path.dirname(staged), { recursive: true });
    copyFileSync(backupFile, staged);
    const startedAt = now();
    const plan: SwapPlan = {
      dataDir: h.dir,
      targetPath: h.file,
      stagedPath: staged,
      asidePath: asidePathFor(h.file, startedAt),
      safetyBackup: path.join(h.backupsDir, 'bengkelin-safety-x.sqlite'),
      startedAt,
    };
    return { plan, backupFile };
  }

  /** Closes the live DB the way the app would, leaving WAL-only data behind. */
  function closeLiveWithWal(): void {
    h.db.close();
    walOnlyShopName(h.file, WAL_NAME);
  }

  function swapCrashingAt(plan: SwapPlan, crashAt: SwapStep | 'end'): void {
    const run = () =>
      performSwap(plan, {
        fs: nodeRestoreFs,
        closeLive: closeLiveWithWal,
        beforeStep: (step) => {
          if (step === crashAt) throw new SimulatedCrash(step);
        },
      });
    if (crashAt === 'end') run();
    else expect(run).toThrow(SimulatedCrash);
    // The process died: whatever connection was open is gone.
    if (h.db.open) h.db.close();
  }

  test('SWAP_STEPS lists every step in order', () => {
    expect(SWAP_STEPS).toEqual([
      'markPrepared',
      'closeLive',
      'moveAsideMain',
      'moveAsideWal',
      'moveAsideShm',
      'markMovedAside',
      'removeStaleSidecars',
      'swapIn',
      'markReplaced',
    ]);
  });

  test.each([
    ['markPrepared', 'NO_MARKER', 'OLD', SHOP_NAME],
    ['closeLive', 'KEPT_CURRENT', 'OLD', SHOP_NAME],
    ['moveAsideMain', 'KEPT_CURRENT', 'OLD', WAL_NAME],
    ['moveAsideWal', 'ROLLED_BACK', 'OLD', WAL_NAME],
    ['moveAsideShm', 'ROLLED_BACK', 'OLD', WAL_NAME],
    ['markMovedAside', 'ROLLED_BACK', 'OLD', WAL_NAME],
    ['removeStaleSidecars', 'RESTORED', 'NEW', SHOP_NAME],
    ['swapIn', 'RESTORED', 'NEW', SHOP_NAME],
    ['markReplaced', 'RESTORED', 'NEW', SHOP_NAME],
    ['end', 'RESTORED', 'NEW', SHOP_NAME],
  ] as const)(
    'crash before %s -> %s, the %s database complete (shop name %s)',
    async (crashAt, outcome, database, name) => {
      const { plan, backupFile } = await prepared();
      const newData = withFile(backupFile, businessData);
      swapCrashingAt(plan, crashAt);

      expect((await restart()).outcome).toBe(outcome);
      expect(existsSync(markerFile())).toBe(false);
      expect(stagingEntries()).toEqual([]);
      expect(integrity(h.db)).toBe('ok');
      expect(shopName(h.db)).toBe(name);
      if (database === 'OLD') {
        expect(issuedNumbers(h.db)).toEqual(OLD_NUMBERS);
        expect(asideFiles()).toEqual([]);
      } else {
        expect(issuedNumbers(h.db)).toEqual(NEW_NUMBERS);
        expect(businessData(h.db)).toEqual(newData);
        // The old database and its WAL are kept together as a safety net.
        expect(asideFiles()).toEqual([
          path.basename(plan.asidePath),
          `${path.basename(plan.asidePath)}-wal`,
        ]);
      }
    },
  );

  test('MOVED_ASIDE with a damaged staged file rolls back', async () => {
    const { plan } = await prepared();
    swapCrashingAt(plan, 'removeStaleSidecars');
    truncateSync(plan.stagedPath, 4096);

    expect((await restart()).outcome).toBe('ROLLED_BACK');
    expect(issuedNumbers(h.db)).toEqual(OLD_NUMBERS);
    expect(shopName(h.db)).toBe(WAL_NAME);
  });

  test('REPLACED with an invalid target rolls back', async () => {
    const { plan } = await prepared();
    swapCrashingAt(plan, 'end');
    writeFileSync(h.file, 'bukan database');

    expect((await restart()).outcome).toBe('ROLLED_BACK');
    expect(issuedNumbers(h.db)).toEqual(OLD_NUMBERS);
    expect(shopName(h.db)).toBe(WAL_NAME);
    expect(integrity(h.db)).toBe('ok');
  });

  test('with nothing valid left, recovery is FATAL and never creates an empty database', async () => {
    const { plan } = await prepared();
    swapCrashingAt(plan, 'removeStaleSidecars');
    rmSync(plan.stagedPath);
    rmSync(plan.asidePath);
    rmSync(`${plan.asidePath}-wal`);

    const lines: LogLine[] = [];
    const outcome = recover(lines);
    expect(outcome).toEqual({
      outcome: 'FATAL',
      stage: 'MOVED_ASIDE',
      safetyBackup: plan.safetyBackup,
      asideFiles: [],
    });
    expect(existsSync(h.file)).toBe(false);
    expect(existsSync(markerFile())).toBe(true);
    // Every later start stops at the same point.
    expect(recover().outcome).toBe('FATAL');
    expect(existsSync(h.file)).toBe(false);
    expect(lines.map((line) => line.event)).toContain('restore.recovery.fatal');
  });

  test('FATAL names the aside files that still exist', async () => {
    const { plan } = await prepared();
    swapCrashingAt(plan, 'end');
    writeFileSync(h.file, 'bukan database');
    writeFileSync(plan.asidePath, 'juga rusak');

    const outcome = recover();
    expect(outcome).toMatchObject({
      outcome: 'FATAL',
      safetyBackup: plan.safetyBackup,
      asideFiles: [plan.asidePath, `${plan.asidePath}-wal`],
    });
  });

  test('a crash after PREPARED leaves the old database; staging is removed', async () => {
    const { plan } = await prepared();
    writeMarker(nodeRestoreFs, h.dir, { ...plan, stage: 'PREPARED' });
    expect((await restart()).outcome).toBe('KEPT_CURRENT');
    expect(issuedNumbers(h.db)).toEqual(OLD_NUMBERS);
    expect(stagingEntries()).toEqual([]);
    expect(existsSync(markerFile())).toBe(false);
  });

  test('PREPARED with the database gone is FATAL rather than a fresh database', async () => {
    const { plan } = await prepared();
    writeMarker(nodeRestoreFs, h.dir, { ...plan, stage: 'PREPARED' });
    h.db.close();
    rmSync(h.file);
    expect(recover()).toEqual({
      outcome: 'FATAL',
      stage: 'PREPARED',
      safetyBackup: plan.safetyBackup,
      asideFiles: [],
    });
    expect(existsSync(h.file)).toBe(false);
    expect(existsSync(markerFile())).toBe(true);
  });

  test('without a marker, orphaned staging is removed and the database is untouched', async () => {
    await scenario();
    mkdirSync(path.join(stagingRoot(), 'orphan'), { recursive: true });
    writeFileSync(path.join(stagingRoot(), 'orphan', 'candidate.sqlite'), 'x');
    expect((await restart()).outcome).toBe('NO_MARKER');
    expect(stagingEntries()).toEqual([]);
    expect(issuedNumbers(h.db)).toEqual(OLD_NUMBERS);
  });

  test('an unreadable or foreign marker with a valid database keeps the database', async () => {
    await scenario();
    h.db.close();
    writeFileSync(markerFile(), '{"stage": "MOVED_AS');
    expect(recover().outcome).toBe('KEPT_CURRENT');
    expect(existsSync(markerFile())).toBe(false);

    writeMarker(nodeRestoreFs, h.dir, {
      stage: 'MOVED_ASIDE',
      dataDir: h.dir,
      targetPath: path.join(scratch, 'elsewhere.sqlite'),
      stagedPath: path.join(scratch, 'x.sqlite'),
      asidePath: path.join(scratch, 'elsewhere.sqlite.pre-restore-x'),
      safetyBackup: 'x',
      startedAt: now(),
    });
    expect(recover().outcome).toBe('KEPT_CURRENT');
    expect(readdirSync(scratch)).not.toContain('elsewhere.sqlite');
    h.reopen();
    await relogin();
    expect(issuedNumbers(h.db)).toEqual(OLD_NUMBERS);
  });

  test('restore layout and marker live in userData', () => {
    expect(restoreLayout(h.dir)).toEqual({
      stagingRoot: path.join(h.dir, 'restore-staging'),
      markerPath: path.join(h.dir, 'restore-marker.json'),
    });
  });

  test('recovery logs every decision without personal data or paths', async () => {
    const { plan } = await prepared();
    swapCrashingAt(plan, 'markReplaced');
    const lines: LogLine[] = [];
    expect((await restart(lines)).outcome).toBe('RESTORED');
    const events = lines.map((line) => line.event);
    expect(events).toContain('restore.recovery.marker');
    expect(events).toContain('restore.recovery.rolled_forward');
    expect(events).toContain('restore.recovery.aside_kept');
    const text = JSON.stringify(lines);
    for (const secret of [h.dir, scratch, 'Pak Budi', 'Siti', 'admin']) {
      expect(text).not.toContain(secret);
    }
  });
});

// ---- maintenance gate ----

describe('maintenance gate', () => {
  test('waits for in-flight writes, rejects new ones, and reopens', async () => {
    const gate = new MaintenanceGate();
    let finish!: () => void;
    const write = gate.runWrite(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    gate.blockWrites();
    expect(() => gate.assertWritable()).toThrow(DomainError);
    expect(() => gate.blockWrites()).toThrow(/RESTORE_IN_PROGRESS|restore/i);
    await expect(gate.runWrite(() => 1)).rejects.toMatchObject({
      code: 'RESTORE_IN_PROGRESS',
    });
    let drained: boolean | undefined;
    const draining = gate.drain(5_000).then((result) => {
      drained = result;
    });
    await Promise.resolve();
    expect(drained).toBeUndefined();
    finish();
    await write;
    await draining;
    expect(drained).toBe(true);

    gate.reopen();
    expect(await gate.runWrite(() => 2)).toBe(2);
  });

  test('drain gives up after its timeout; a closed gate refuses reads', async () => {
    const gate = new MaintenanceGate();
    void gate.runWrite(() => new Promise<void>(() => undefined));
    gate.blockWrites();
    expect(await gate.drain(20)).toBe(false);
    gate.assertReadable();
    gate.close();
    expect(() => gate.assertReadable()).toThrow(DomainError);
  });
});
