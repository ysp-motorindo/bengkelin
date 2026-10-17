import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openDatabase, withWriteTransaction } from '@/main/database/connection';
import { APPLICATION_ID, readApplicationId } from '@/main/database/identity';
import {
  bundledMigrations,
  migrateDatabase,
  readSchemaVersion,
  type Migration,
} from '@/main/database/migrate';

let dir: string;
let file: string;
const open: { close(): unknown }[] = [];
function track<T extends { close(): unknown }>(db: T): T {
  open.push(db);
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bengkelin-db-'));
  file = path.join(dir, 'bengkelin.sqlite');
});
afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const only001 = bundledMigrations.filter((m) => m.version === 1);
const now = '2026-09-30T00:00:00.000Z';
const insertCashier = `INSERT INTO cashiers (id, username, display_name, password_hash, role, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?)`;

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('connection pragmas', () => {
  test('applies WAL, FULL sync, foreign keys, busy timeout and safe integers', () => {
    const db = track(openDatabase(file));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(Number(db.pragma('synchronous', { simple: true }))).toBe(2);
    expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(1);
    expect(Number(db.pragma('busy_timeout', { simple: true }))).toBe(5000);
    const row = db.prepare('SELECT 9007199254740993 AS big').get() as {
      big: unknown;
    };
    expect(row.big).toBe(9007199254740993n);
  });
});

describe('migrations', () => {
  test('bundled migrations are contiguous from 001', () => {
    expect(bundledMigrations.map((m) => m.version)).toEqual(
      bundledMigrations.map((_, i) => i + 1),
    );
    expect(only001).toHaveLength(1);
  });

  test('apply 001, persist across reopen, and stamp identity', () => {
    const db = track(openDatabase(file));
    expect(readSchemaVersion(db)).toBe(0);
    migrateDatabase(db, only001);
    expect(readSchemaVersion(db)).toBe(1);
    expect(readApplicationId(db)).toBe(APPLICATION_ID);
    db.close();

    const reopened = track(openDatabase(file));
    expect(readSchemaVersion(reopened)).toBe(1);
    expect(readApplicationId(reopened)).toBe(APPLICATION_ID);
  });

  test('default run reaches the latest bundled version', () => {
    const db = track(openDatabase(file));
    migrateDatabase(db);
    const latest = Math.max(...bundledMigrations.map((m) => m.version));
    expect(readSchemaVersion(db)).toBe(latest);
  });

  test('backfills existing cashier preferences from current shop values', () => {
    const db = track(openDatabase(file));
    const beforePreferences = bundledMigrations.filter((m) => m.version <= 12);
    migrateDatabase(db, beforePreferences);
    db.prepare("UPDATE settings SET language='en', appearance='DARK'").run();
    db.prepare(insertCashier).run(
      'c1',
      'admin',
      'Admin',
      'h',
      'ADMIN',
      now,
      now,
    );
    db.prepare(insertCashier).run(
      'c2',
      'siti',
      'Siti',
      'h',
      'CASHIER',
      now,
      now,
    );
    migrateDatabase(db);
    db.close();

    const reopened = track(openDatabase(file));
    expect(
      reopened
        .prepare(
          'SELECT id, username, display_name, role, language, appearance FROM cashiers ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        id: 'c1',
        username: 'admin',
        display_name: 'Admin',
        role: 'ADMIN',
        language: 'en',
        appearance: 'DARK',
      },
      {
        id: 'c2',
        username: 'siti',
        display_name: 'Siti',
        role: 'CASHIER',
        language: 'en',
        appearance: 'DARK',
      },
    ]);
    expect(
      reopened.prepare('SELECT language, appearance FROM settings').get(),
    ).toEqual({ language: 'en', appearance: 'DARK' });
  });

  test('is idempotent when repeated', () => {
    const db = track(openDatabase(file));
    migrateDatabase(db, only001);
    db.prepare(insertCashier).run(
      'c1',
      'admin',
      'Admin',
      'h',
      'ADMIN',
      now,
      now,
    );
    migrateDatabase(db, only001);
    migrateDatabase(db, only001);
    expect(readSchemaVersion(db)).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM cashiers').get()).toEqual({
      n: 1n,
    });
  });

  test('creates only the foundation tables with defaults', () => {
    const db = track(openDatabase(file));
    migrateDatabase(db, only001);
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toEqual([
      'audit_log',
      'cashiers',
      'command_receipts',
      'settings',
    ]);
    const settings = db.prepare('SELECT * FROM settings').get();
    expect(settings).toMatchObject({
      timezone: 'Asia/Jakarta',
      language: 'id',
      appearance: 'SYSTEM',
      setup_completed_at: null,
    });
  });

  test('a failing migration rolls back, keeps earlier data, and errors', () => {
    const db = track(openDatabase(file));
    migrateDatabase(db, only001);
    db.prepare(insertCashier).run(
      'c1',
      'admin',
      'Admin',
      'h',
      'ADMIN',
      now,
      now,
    );
    const failing: Migration = {
      version: 2,
      name: 'broken',
      sql: `CREATE TABLE half_done (id INTEGER PRIMARY KEY);
            INSERT INTO half_done (id) VALUES (1);
            INSERT INTO cashiers (id) VALUES ('missing-columns');`,
    };
    expect(codeOf(() => migrateDatabase(db, [...only001, failing]))).toBe(
      'MIGRATION_FAILED',
    );
    expect(readSchemaVersion(db)).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='half_done'").get(),
    ).toBeUndefined();
    expect(db.prepare('SELECT username FROM cashiers').all()).toEqual([
      { username: 'admin' },
    ]);
  });

  test('applies migrations in order, each in its own transaction', () => {
    const db = track(openDatabase(file));
    const ok2: Migration = {
      version: 2,
      name: 'two',
      sql: 'CREATE TABLE two (id INTEGER PRIMARY KEY);',
    };
    const bad3: Migration = { version: 3, name: 'three', sql: 'NOT SQL' };
    // Supplied out of order on purpose: they must be sorted.
    expect(codeOf(() => migrateDatabase(db, [bad3, ok2, ...only001]))).toBe(
      'MIGRATION_FAILED',
    );
    expect(readSchemaVersion(db)).toBe(2);
  });

  test('rejects a non-contiguous migration list', () => {
    const db = track(openDatabase(file));
    const gap: Migration = { version: 3, name: 'gap', sql: 'SELECT 1;' };
    expect(codeOf(() => migrateDatabase(db, [...only001, gap]))).toBe(
      'MIGRATION_FAILED',
    );
  });

  test('rejects a schema newer than the app knows (open and migrate)', () => {
    const db = track(openDatabase(file));
    migrateDatabase(db, only001);
    db.pragma('user_version = 999');
    expect(codeOf(() => migrateDatabase(db))).toBe('UNSUPPORTED_SCHEMA');
    db.close();
    expect(codeOf(() => openDatabase(file))).toBe('UNSUPPORTED_SCHEMA');
  });

  test('rejects a foreign non-empty database (open and migrate)', () => {
    const foreign = new Database(file);
    foreign.exec('CREATE TABLE other_app (id INTEGER)');
    foreign.close();
    expect(codeOf(() => openDatabase(file))).toBe('FOREIGN_DATABASE');

    // openDatabase refuses, so drive migrateDatabase over a raw handle.
    const raw = track(new Database(file));
    expect(codeOf(() => migrateDatabase(raw as never))).toBe(
      'FOREIGN_DATABASE',
    );
  });

  test('accepts an empty pre-existing file', () => {
    new Database(file).close();
    const db = track(openDatabase(file));
    migrateDatabase(db, only001);
    expect(readSchemaVersion(db)).toBe(1);
  });
});

describe('foundation constraints', () => {
  function migrated() {
    const db = track(openDatabase(file));
    migrateDatabase(db, only001);
    return db;
  }

  test('cashier role, username uniqueness and settings checks are enforced', () => {
    const db = migrated();
    const insert = db.prepare(insertCashier);
    insert.run('a', 'kasir', 'Kasir', 'h', 'CASHIER', now, now);
    expect(() =>
      insert.run('b', 'kasir', 'Dua', 'h', 'CASHIER', now, now),
    ).toThrow(/UNIQUE/);
    expect(() => insert.run('c', 'x', 'X', 'h', 'OWNER', now, now)).toThrow(
      /CHECK/,
    );
    expect(() => db.prepare("UPDATE settings SET language='fr'").run()).toThrow(
      /CHECK/,
    );
    expect(() =>
      db.prepare("UPDATE settings SET appearance='NEON'").run(),
    ).toThrow(/CHECK/);
    expect(() => db.prepare('DELETE FROM settings').run()).toThrow();
  });

  test('audit_log is append-only', () => {
    const db = migrated();
    const insert = db.prepare(
      'INSERT INTO audit_log (cashier_id, action, created_at) VALUES (NULL, ?, ?)',
    );
    insert.run('DATABASE_BACKUP_CREATED', now);
    expect(() => db.prepare("UPDATE audit_log SET action='X'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(
      /append-only/,
    );
    expect(() => insert.run('X', 'not-an-instant')).toThrow(/CHECK/);
  });
});

describe('withWriteTransaction', () => {
  test('commits on success and rolls back on throw', () => {
    const db = track(openDatabase(file));
    db.exec('CREATE TABLE t (v INTEGER)');
    withWriteTransaction(db, () =>
      db.prepare('INSERT INTO t VALUES (1)').run(),
    );
    expect(() =>
      withWriteTransaction(db, () => {
        db.prepare('INSERT INTO t VALUES (2)').run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 1n }]);
  });

  test('takes the write lock up front (BEGIN IMMEDIATE)', () => {
    const a = track(openDatabase(file));
    migrateDatabase(a, only001);
    const b = track(openDatabase(file));
    b.pragma('busy_timeout = 0');
    withWriteTransaction(a, () => {
      expect(() => withWriteTransaction(b, () => 1)).toThrow(/locked|busy/i);
    });
  });

  test('rejects async work and rolls back', () => {
    const db = track(openDatabase(file));
    db.exec('CREATE TABLE t (v INTEGER)');
    const asyncWork = (() => {
      db.prepare('INSERT INTO t VALUES (1)').run();
      return Promise.resolve(1);
    }) as never;
    expect(codeOf(() => withWriteTransaction(db, asyncWork))).toBe(
      'ASYNC_TRANSACTION',
    );
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0n });
  });
});
