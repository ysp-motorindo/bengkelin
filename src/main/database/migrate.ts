import type { AppDatabase } from './connection';
import {
  normalizePhone,
  normalizePlate,
} from '@/main/features/vehicles/normalization';
import { DatabaseError } from './errors';
import {
  APPLICATION_ID,
  assertOwnDatabase,
  assertSupportedSchema,
  readSchemaVersion,
} from './identity';

export { readSchemaVersion };

export type Migration = { version: number; name: string; sql: string };

/** What a migration run did (logged at startup, spec 48). */
export interface MigrationOutcome {
  /** Schema version before the run. */
  from: number;
  /** Schema version after the run. */
  to: number;
  /** Versions applied by this run, in order (empty when up to date). */
  applied: number[];
}

// Bundled at build time (Vite inlines the SQL text), so dev, tests and the
// packaged asar all load the same migrations without any runtime file path.
const sources = import.meta.glob('./migrations/*.sql', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function parseBundled(): Migration[] {
  return Object.entries(sources)
    .map(([file, sql]) => {
      const match = /(\d{3})_([a-z0-9_]+)\.sql$/.exec(file);
      if (!match) throw new Error(`Bad migration file name: ${file}`);
      return { version: Number(match[1]), name: match[2] as string, sql };
    })
    .sort((a, b) => a.version - b.version);
}

export const bundledMigrations: readonly Migration[] = parseBundled();
export const latestBundledVersion: number = bundledMigrations.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);

/**
 * Deterministic SQL functions available to migration SQL, so a backfill can
 * use exactly the app's own normalization (008 search snapshots). Only
 * migrations call them; no trigger, index or view depends on them, so the
 * database stays readable by any SQLite tool.
 */
function registerMigrationFunctions(db: AppDatabase): void {
  const text = (fn: (value: string) => string) => (value: unknown) =>
    value === null || value === undefined ? null : fn(String(value));
  db.function(
    'bengkelin_normalize_phone',
    { deterministic: true },
    text(normalizePhone),
  );
  db.function(
    'bengkelin_normalize_plate',
    { deterministic: true },
    text(normalizePlate),
  );
}

function orderAndValidate(migrations: readonly Migration[]): Migration[] {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  ordered.forEach((m, index) => {
    if (m.version !== index + 1) {
      throw new DatabaseError(
        'MIGRATION_FAILED',
        `Migrations must be contiguous from 1; found ${m.version} at position ${index + 1}`,
      );
    }
  });
  return ordered;
}

/**
 * Applies pending migrations in order, each in its own `BEGIN IMMEDIATE`
 * transaction that also stamps `application_id` and `user_version`. A failure
 * rolls back only that migration; earlier ones stay committed. Migration SQL
 * must not contain PRAGMAs that cannot run inside a transaction
 * (e.g. foreign_keys) or its own BEGIN/COMMIT.
 */
export function migrateDatabase(
  db: AppDatabase,
  migrations: readonly Migration[] = bundledMigrations,
): MigrationOutcome {
  const ordered = orderAndValidate(migrations);
  assertOwnDatabase(db);
  assertSupportedSchema(db, ordered.length);
  registerMigrationFunctions(db);
  const from = readSchemaVersion(db);
  const applied: number[] = [];

  for (const migration of ordered) {
    if (migration.version <= readSchemaVersion(db)) continue;
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        db.pragma(`application_id = ${APPLICATION_ID}`);
        db.pragma(`user_version = ${migration.version}`);
      }).immediate();
    } catch (error) {
      throw new DatabaseError(
        'MIGRATION_FAILED',
        `Migration ${String(migration.version).padStart(3, '0')}_${migration.name} failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
    applied.push(migration.version);
  }
  return { from, to: readSchemaVersion(db), applied };
}
