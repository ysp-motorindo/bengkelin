import type { AppDatabase } from '@/main/database/connection';
import type { BackupKind, BackupRunDto } from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';

interface RunRow {
  kind: string;
  outcome: string;
  started_at: string;
  finished_at: string;
  file_name: string | null;
  error_code: string | null;
}

export interface NewRun {
  kind: BackupKind;
  startedAt: Instant;
  finishedAt: Instant;
  outcome: 'SUCCEEDED' | 'FAILED';
  fileName: string | null;
  errorCode: string | null;
  destinationDir: string;
}

const COLUMNS = 'kind, outcome, started_at, finished_at, file_name, error_code';

function toRunDto(row: RunRow): BackupRunDto {
  return {
    kind: row.kind as BackupKind,
    outcome: row.outcome as BackupRunDto['outcome'],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    fileName: row.file_name,
    errorCode: row.error_code,
  };
}

/** `backup_runs` (append-only) and the backup folder setting. */
export class BackupRepository {
  constructor(private readonly db: AppDatabase) {}

  insertRun(run: NewRun): void {
    this.db
      .prepare(
        `INSERT INTO backup_runs (kind, started_at, finished_at, outcome, file_name, error_code, destination_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.kind,
        run.startedAt,
        run.finishedAt,
        run.outcome,
        run.fileName,
        run.errorCode,
        run.destinationDir,
      );
  }

  /** The latest run of a kind (optionally only successful ones). */
  lastRun(kind: BackupKind, outcome?: 'SUCCEEDED'): BackupRunDto | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM backup_runs
          WHERE kind = ? ${outcome ? 'AND outcome = ?' : ''}
          ORDER BY id DESC LIMIT 1`,
      )
      .get(...(outcome ? [kind, outcome] : [kind])) as RunRow | undefined;
    return row ? toRunDto(row) : null;
  }

  recentRuns(limit: number): BackupRunDto[] {
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM backup_runs ORDER BY id DESC LIMIT ?`)
        .all(limit) as RunRow[]
    ).map(toRunDto);
  }

  /**
   * The failed AUTO run to show as an ADMIN notice: the latest AUTO run
   * FAILED and no AUTO or MANUAL backup succeeded after it.
   */
  unresolvedAutoFailure(): BackupRunDto | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM backup_runs AS failed
          WHERE failed.id = (SELECT MAX(id) FROM backup_runs WHERE kind = 'AUTO')
            AND failed.outcome = 'FAILED'
            AND NOT EXISTS (
              SELECT 1 FROM backup_runs AS later
               WHERE later.id > failed.id
                 AND later.outcome = 'SUCCEEDED'
                 AND later.kind IN ('AUTO', 'MANUAL'))`,
      )
      .get() as RunRow | undefined;
    return row ? toRunDto(row) : null;
  }

  configuredDirectory(): string | null {
    const row = this.db
      .prepare('SELECT backup_directory FROM settings WHERE id = 1')
      .get() as { backup_directory: string | null };
    return row.backup_directory;
  }

  setConfiguredDirectory(dir: string | null): void {
    this.db
      .prepare('UPDATE settings SET backup_directory = ? WHERE id = 1')
      .run(dir);
  }

  /** Shop timezone and whether first-run setup is complete. */
  shopContext(): { timezone: string; setupCompleted: boolean } {
    const row = this.db
      .prepare('SELECT timezone, setup_completed_at FROM settings WHERE id = 1')
      .get() as { timezone: string; setup_completed_at: string | null };
    return {
      timezone: row.timezone,
      setupCompleted: row.setup_completed_at !== null,
    };
  }
}
