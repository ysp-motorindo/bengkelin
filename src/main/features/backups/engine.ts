import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AppDatabase } from '@/main/database/connection';
import type { BackupValidation } from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import { writeError } from './destination';
import { PARTIAL_SUFFIX } from './naming';
import { validateBackup } from './validation';

/** Test seams around the file steps (never set by the app). */
export interface BackupHooks {
  /** After each online-backup step (pages copied so far). */
  onStep?(progress: { totalPages: number; remainingPages: number }): void;
  /** After the copy is written, before it is validated. */
  afterWrite?(partialPath: string): void | Promise<void>;
  /** After validation and fsync, before the atomic rename. */
  beforeRename?(partialPath: string): void | Promise<void>;
}

export interface WrittenBackup {
  size: number;
  validation: BackupValidation & { ok: true };
}

/**
 * Writes a validated backup of the live connection to `finalPath`:
 *
 *  1. SQLite online backup (`db.backup`) into `<final>.partial`. It reads
 *     through the app's own connection, so committed content still in the
 *     -wal file is included. It copies `pagesPerStep` pages per step and
 *     yields to the event loop between steps; no transaction is held
 *     between steps, and writes made meanwhile through the same connection
 *     are carried into the copy, so cashier commands are never blocked.
 *  2. The copy is switched to the rollback-journal format so the backup is a
 *     single self-contained file (no -wal/-shm needed next to it).
 *  3. `validateBackup` (read-only handle) must accept it.
 *  4. fsync the file, rename it atomically to its final name, fsync the
 *     folder where the platform supports it.
 *
 * On any failure the partial file (and any side file) is removed and a
 * DomainError with a backup code is thrown. The final name is never
 * overwritten. Business data is only read.
 */
export async function writeValidatedBackup(
  db: AppDatabase,
  finalPath: string,
  options: { pagesPerStep?: number; hooks?: BackupHooks } = {},
): Promise<WrittenBackup> {
  const { hooks = {}, pagesPerStep = 100 } = options;
  const partial = finalPath + PARTIAL_SUFFIX;
  try {
    try {
      await db.backup(partial, {
        progress: (progress) => {
          hooks.onStep?.(progress);
          return pagesPerStep;
        },
      });
      useRollbackJournal(partial);
    } catch (error) {
      throw writeError(error);
    }
    await hooks.afterWrite?.(partial);

    const validation = validateBackup(partial);
    if (!validation.ok) {
      throw new DomainError('BACKUP_VALIDATION_FAILED', undefined, {
        reason: validation.error ?? 'UNKNOWN',
      });
    }

    try {
      fsyncFile(partial);
      await hooks.beforeRename?.(partial);
      if (existsSync(finalPath)) {
        throw new Error('Backup file name already taken');
      }
      renameSync(partial, finalPath);
      fsyncDirectory(path.dirname(finalPath));
      return {
        size: statSync(finalPath).size,
        validation: validation as WrittenBackup['validation'],
      };
    } catch (error) {
      throw writeError(error);
    }
  } finally {
    removePartial(partial);
  }
}

/**
 * The online backup copies the source header, so a copy of a WAL database
 * is marked WAL. Switch it to DELETE through a short raw handle on the copy
 * (never on the live database).
 */
function useRollbackJournal(file: string): void {
  const copy = new Database(file, { fileMustExist: true });
  try {
    copy.pragma('journal_mode = DELETE');
  } finally {
    copy.close();
  }
}

function fsyncFile(file: string): void {
  const fd = openSync(file, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Makes the rename durable. Not supported on Windows: ignored there. */
function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // EISDIR/EPERM/EINVAL on platforms that cannot fsync a directory.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function removePartial(partial: string): void {
  for (const file of [
    partial,
    `${partial}-journal`,
    `${partial}-wal`,
    `${partial}-shm`,
  ]) {
    try {
      rmSync(file, { force: true });
    } catch {
      // The partial name stays reserved (naming skips it); nothing else.
    }
  }
}
