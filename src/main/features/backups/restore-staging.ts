import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { appendAudit } from '@/main/database/audit';
import {
  openDatabase,
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import {
  bundledMigrations,
  latestBundledVersion,
  migrateDatabase,
  readSchemaVersion,
  type Migration,
} from '@/main/database/migrate';
import type { RestoreCountsDto } from '@/shared/contracts';
import { DomainError, type Instant } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { raiseStagedCounters, type IssuedSequences } from './restore-counters';
import type { RestoreFs } from './restore-fs';
import { validateBackup } from './validation';

/**
 * Restore staging (T16): the selected file is copied into
 * `userData/restore-staging/<token>/candidate.sqlite` (the original is never
 * opened for writing, so read-only media and WAL-format copies work),
 * validated, migrated to the current schema and summarized. At restore time
 * the staged copy gets the counter and audit safeguards and is closed as a
 * single rollback-journal file, ready to be renamed into place.
 */

export const STAGED_FILE_NAME = 'candidate.sqlite';

export interface StagedSummary {
  shopName: string;
  counts: RestoreCountsDto;
  latestFinalizedAt: Instant | null;
  latestPurchaseFinalizedAt: Instant | null;
  activeAdmins: number;
}

export interface StagedCandidate {
  stagingDir: string;
  stagedPath: string;
  sourceFileName: string;
  sourceSize: number;
  originalSchemaVersion: number;
  schemaVersion: number;
  summary: StagedSummary;
}

export interface StageInput {
  source: string;
  stagingDir: string;
  fs: RestoreFs;
  migrations?: readonly Migration[];
}

const NOT_FOUND_CODES = new Set(['ENOENT', 'EISDIR', 'ENOTDIR']);

/** Copies, validates, migrates and summarizes; cleans up on any failure. */
export function stageCandidate(input: StageInput): StagedCandidate {
  const { fs, stagingDir } = input;
  const stagedPath = path.join(stagingDir, STAGED_FILE_NAME);
  try {
    mkdirSync(stagingDir, { recursive: true });
    try {
      fs.copyFile(input.source, stagedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      throw NOT_FOUND_CODES.has(code)
        ? new DomainError('BACKUP_NOT_FOUND')
        : new DomainError('RESTORE_STAGING_FAILED');
    }
    const sourceSize = statSync(stagedPath).size;

    const validation = validateBackup(stagedPath);
    if (!validation.ok) {
      throw new DomainError(
        validation.error ?? 'CORRUPT_DATABASE',
        'The selected file cannot be restored',
        validation.schemaVersion !== null
          ? { schemaVersion: String(validation.schemaVersion) }
          : undefined,
      );
    }
    const originalSchemaVersion = validation.schemaVersion as number;

    const db = openDatabase(stagedPath);
    try {
      try {
        migrateDatabase(db, input.migrations ?? bundledMigrations);
      } catch {
        throw new DomainError('RESTORE_MIGRATION_FAILED');
      }
      const summary = readSummary(db);
      const schemaVersion = readSchemaVersion(db);
      if (summary.activeAdmins === 0) {
        throw new DomainError('RESTORE_NO_ACTIVE_ADMIN');
      }
      closeAsSingleFile(db);
      return {
        stagingDir,
        stagedPath,
        sourceFileName: path.basename(input.source),
        sourceSize,
        originalSchemaVersion,
        schemaVersion,
        summary,
      };
    } finally {
      if (db.open) db.close();
    }
  } catch (error) {
    try {
      fs.removeTree(stagingDir);
    } catch {
      // Startup removes any staging left behind.
    }
    throw error;
  }
}

function count(db: AppDatabase, sql: string): number {
  return Number((db.prepare(sql).get() as { n: bigint }).n);
}

export function readSummary(db: AppDatabase): StagedSummary {
  const byStatus = Object.fromEntries(
    (
      db
        .prepare(
          `SELECT status, COUNT(*) AS n FROM invoices
           WHERE status <> 'DRAFT' OR discarded_at IS NULL GROUP BY status`,
        )
        .all() as { status: string; n: bigint }[]
    ).map((row) => [row.status, Number(row.n)]),
  );
  const latest = db
    .prepare('SELECT MAX(finalized_at) AS latest FROM invoices')
    .get() as { latest: string | null };
  const settings = db
    .prepare('SELECT shop_name FROM settings WHERE id = 1')
    .get() as { shop_name: string } | undefined;
  return {
    shopName: settings?.shop_name ?? '',
    counts: {
      invoices: {
        draft: byStatus.DRAFT ?? 0,
        finalized: byStatus.FINALIZED ?? 0,
        void: byStatus.VOID ?? 0,
      },
      purchases: {
        draft: count(
          db,
          "SELECT COUNT(*) AS n FROM purchases WHERE status='DRAFT' AND discarded_at IS NULL",
        ),
        finalized: count(
          db,
          "SELECT COUNT(*) AS n FROM purchases WHERE status='FINALIZED'",
        ),
        void: count(
          db,
          "SELECT COUNT(*) AS n FROM purchases WHERE status='VOID'",
        ),
      },
      suppliers: count(db, 'SELECT COUNT(*) AS n FROM suppliers'),
      catalogItems: count(db, 'SELECT COUNT(*) AS n FROM catalog_items'),
      customers: count(db, 'SELECT COUNT(*) AS n FROM customers'),
      cashiers: count(db, 'SELECT COUNT(*) AS n FROM cashiers'),
    },
    latestFinalizedAt: latest.latest,
    latestPurchaseFinalizedAt: (
      db.prepare('SELECT MAX(finalized_at) AS latest FROM purchases').get() as {
        latest: string | null;
      }
    ).latest,
    activeAdmins: count(
      db,
      `SELECT COUNT(*) AS n FROM cashiers WHERE role = 'ADMIN' AND is_active = 1`,
    ),
  };
}

/** Checkpoints and switches to a rollback journal: one self-contained file. */
function closeAsSingleFile(db: AppDatabase): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.pragma('journal_mode = DELETE');
  db.close();
}

export interface SafeguardInput {
  stagedPath: string;
  clock: Clock;
  /** What the current database has issued (counters and numbers). */
  currentSequences: IssuedSequences;
  audit: {
    actorUsername: string;
    actorDisplayName: string;
    sourceFileName: string;
    safetyBackupFileName: string;
    originalSchemaVersion: number;
  };
  /** Awaited-free test seam, called before checkpoint + close. */
  beforeClose?: () => void;
}

/**
 * Writes the restore safeguards into the STAGED database in one
 * transaction: counters raised to max(current, staged) per date, and the
 * DATABASE_RESTORED audit row (no actor id: the restoring cashier may not
 * exist in the backup; the names are in the metadata). Then checkpoints,
 * closes and fsyncs the file.
 */
export function applyStagedSafeguards(
  input: SafeguardInput,
  fs: RestoreFs,
): void {
  const db = openDatabase(input.stagedPath);
  try {
    withWriteTransaction(db, () => {
      raiseStagedCounters(db, input.currentSequences);
      appendAudit(db, input.clock, {
        cashierId: null,
        action: 'DATABASE_RESTORED',
        entityType: 'backup',
        entityId: input.audit.sourceFileName,
        metadata: {
          ...input.audit,
          schemaVersion: latestBundledVersion,
        },
      });
    });
    input.beforeClose?.();
    closeAsSingleFile(db);
  } finally {
    if (db.open) db.close();
  }
  fs.fsyncFile(input.stagedPath);
}
