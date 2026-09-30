import type { AppDatabase } from './connection';
import { DatabaseError } from './errors';
import {
  APPLICATION_ID,
  assertOwnDatabase,
  assertSupportedSchema,
  readSchemaVersion,
} from './identity';

export { readSchemaVersion };

export type Migration = { version: number; name: string; sql: string };

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
): void {
  const ordered = orderAndValidate(migrations);
  assertOwnDatabase(db);
  assertSupportedSchema(db, ordered.length);

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
  }
}
