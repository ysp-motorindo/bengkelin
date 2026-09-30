import path from 'node:path';
import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { requireAdmin } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type { FileDialogs } from '@/main/features/printing/driver';
import type { Logger } from '@/main/platform/logger';
import type {
  BackupDestinationChoiceDto,
  BackupErrorCode,
  BackupKind,
  BackupStatusDto,
  BackupSummary,
} from '@/shared/contracts';
import { DomainError, type Instant } from '@/shared/primitives';
import {
  businessDay,
  businessDayRange,
  toInstant,
  type Clock,
} from '@/shared/time';
import { prepareDestination } from './destination';
import { writeValidatedBackup, type BackupHooks } from './engine';
import { availableBackupName } from './naming';
import { BackupRepository } from './repository';
import { AUTO_BACKUPS_KEPT, pruneAutoBackups } from './retention';

export type { BackupHooks } from './engine';

export interface BackupServiceDeps {
  db: AppDatabase;
  clock: Clock;
  logger: Logger;
  /** `userData/backups`: used while no folder is configured. */
  defaultDir: string;
  /** The native folder dialog (main only). */
  dialogs: FileDialogs;
  /** Test seams; never set by the app. */
  hooks?: BackupHooks;
  /** Pages copied per online-backup step (default 100). */
  pagesPerStep?: number;
  /** After a failed automatic backup, wait this long before retrying. */
  retryAfterMs?: number;
  /** True while a restore is running: automatic backups are skipped. */
  isPaused?: () => boolean;
}

export interface CreateBackupInput {
  kind: BackupKind;
  /** Write here instead of the configured folder (must already exist). */
  destinationDir?: string;
}

export type AutomaticBackupOutcome = 'NOT_DUE' | 'SUCCEEDED' | 'FAILED';

const BACKUP_ERROR_CODES: ReadonlySet<string> = new Set<BackupErrorCode>([
  'BACKUP_DESTINATION_UNAVAILABLE',
  'BACKUP_DESTINATION_READ_ONLY',
  'BACKUP_WRITE_FAILED',
  'BACKUP_VALIDATION_FAILED',
]);
const DEFAULT_RETRY_MS = 60 * 60_000;
const RECENT_RUNS = 10;

/**
 * Validated local backups (spec 42). One backup runs at a time; each is
 * recorded in `backup_runs`. A failure is a recoverable operational error
 * (spec 46): it is recorded, logged without paths or personal data, and
 * never changes business data or blocks a cashier.
 */
export class BackupService {
  private readonly repo: BackupRepository;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BackupServiceDeps) {
    this.repo = new BackupRepository(deps.db);
  }

  /**
   * Creates a validated backup and returns its summary, or throws a
   * DomainError with a `BackupErrorCode`. Used by the ADMIN "Backup now",
   * the daily schedule, and by catalog import (T15) and restore (T16) for
   * their SAFETY backup. Calls are serialized.
   */
  createValidatedBackup(input: CreateBackupInput): Promise<BackupSummary> {
    return this.serialized(() => this.runBackup(input, null));
  }

  /** `backups.create()`: ADMIN "Backup now" (MANUAL, audited). */
  create(session: Session | undefined): Promise<BackupSummary> {
    const actor = requireAdmin(session);
    return this.serialized(() =>
      this.runBackup({ kind: 'MANUAL' }, actor.cashierId),
    );
  }

  status(session: Session | undefined): BackupStatusDto {
    requireAdmin(session);
    return this.currentStatus();
  }

  /** ADMIN picks the backup folder in a native dialog shown by main. */
  async chooseDestination(
    session: Session | undefined,
  ): Promise<BackupDestinationChoiceDto> {
    requireAdmin(session);
    const chosen = await this.deps.dialogs.chooseBackupDirectory();
    if (chosen === null) {
      return { outcome: 'CANCELLED', status: this.currentStatus() };
    }
    const dir = path.resolve(chosen);
    prepareDestination(dir, { create: false });
    // The dialog awaited: re-check the role before writing.
    const actor = requireAdmin(session);
    const isDefault = dir === path.resolve(this.deps.defaultDir);
    withWriteTransaction(this.deps.db, () => {
      this.repo.setConfiguredDirectory(isDefault ? null : dir);
      appendAudit(this.deps.db, this.deps.clock, {
        cashierId: actor.cashierId,
        action: 'BACKUP_DESTINATION_CHANGED',
        entityType: 'settings',
        entityId: '1',
        metadata: { isDefault },
      });
    });
    return { outcome: 'UPDATED', status: this.currentStatus() };
  }

  /** True when today's (shop business day) automatic backup is still due. */
  isAutomaticBackupDue(): boolean {
    const { setupCompleted, timezone } = this.repo.shopContext();
    if (!setupCompleted) return false;
    const now = this.deps.clock.now();
    return this.nextAutomaticAt(now, timezone) <= now;
  }

  /**
   * The scheduler's check: runs the automatic backup at most once per shop
   * business day (retrying a failure after `retryAfterMs`). Never throws.
   */
  runAutomaticBackupIfDue(): Promise<AutomaticBackupOutcome> {
    return this.serialized(async () => {
      if (this.deps.isPaused?.()) return 'NOT_DUE';
      try {
        if (!this.isAutomaticBackupDue()) return 'NOT_DUE';
      } catch (error) {
        this.deps.logger.error('backup.schedule_check_failed', { error });
        return 'NOT_DUE';
      }
      try {
        await this.runBackup({ kind: 'AUTO' }, null);
        return 'SUCCEEDED';
      } catch {
        return 'FAILED';
      }
    });
  }

  /** The folder the next backup is written to (configured or default). */
  backupDirectory(): string {
    return this.destination().dir;
  }

  // ---- internals ----

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private destination(): { dir: string; isDefault: boolean } {
    const configured = this.repo.configuredDirectory();
    return configured === null
      ? { dir: this.deps.defaultDir, isDefault: true }
      : { dir: configured, isDefault: false };
  }

  private async runBackup(
    input: CreateBackupInput,
    auditActorId: string | null,
  ): Promise<BackupSummary> {
    const { db, clock, logger } = this.deps;
    const { kind } = input;
    const startedAt = clock.now();
    const configured = this.destination();
    const dir = input.destinationDir ?? configured.dir;
    const createIfMissing =
      input.destinationDir === undefined && configured.isDefault;

    let summary: BackupSummary;
    try {
      const { timezone } = this.repo.shopContext();
      prepareDestination(dir, { create: createIfMissing });
      const fileName = availableBackupName(dir, kind, startedAt, timezone);
      const written = await writeValidatedBackup(db, path.join(dir, fileName), {
        ...(this.deps.hooks ? { hooks: this.deps.hooks } : {}),
        ...(this.deps.pagesPerStep
          ? { pagesPerStep: this.deps.pagesPerStep }
          : {}),
      });
      summary = {
        kind,
        fileName,
        size: written.size,
        createdAt: startedAt,
        schemaVersion: written.validation.schemaVersion as number,
        applicationId: written.validation.applicationId as number,
      };
    } catch (error) {
      const failure =
        error instanceof DomainError && BACKUP_ERROR_CODES.has(error.code)
          ? error
          : new DomainError('BACKUP_WRITE_FAILED');
      if (failure !== error) {
        logger.error('backup.unexpected_error', { kind, error });
      }
      logger.error('backup.failed', {
        kind,
        code: failure.code,
        ...(failure.params ? { reason: failure.params.reason } : {}),
      });
      this.record({
        kind,
        startedAt,
        finishedAt: clock.now(),
        outcome: 'FAILED',
        fileName: null,
        errorCode: failure.code,
        destinationDir: dir,
      });
      throw failure;
    }

    this.record(
      {
        kind,
        startedAt,
        finishedAt: clock.now(),
        outcome: 'SUCCEEDED',
        fileName: summary.fileName,
        errorCode: null,
        destinationDir: dir,
      },
      auditActorId,
      summary,
    );
    logger.info('backup.created', {
      kind,
      file: summary.fileName,
      size: summary.size,
    });
    if (kind === 'AUTO') this.prune(dir);
    return summary;
  }

  /**
   * Records the run (and audits a MANUAL success) in one short transaction.
   * A bookkeeping failure is logged, never turned into a backup failure:
   * the file on disk is valid either way.
   */
  private record(
    run: Parameters<BackupRepository['insertRun']>[0],
    auditActorId: string | null = null,
    summary?: BackupSummary,
  ): void {
    try {
      withWriteTransaction(this.deps.db, () => {
        this.repo.insertRun(run);
        if (auditActorId !== null && summary) {
          appendAudit(this.deps.db, this.deps.clock, {
            cashierId: auditActorId,
            action: 'DATABASE_BACKUP_CREATED',
            entityType: 'backup',
            entityId: summary.fileName,
            metadata: {
              kind: summary.kind,
              fileName: summary.fileName,
              size: summary.size,
              schemaVersion: summary.schemaVersion,
            },
          });
        }
      });
    } catch (error) {
      this.deps.logger.error('backup.record_failed', {
        kind: run.kind,
        outcome: run.outcome,
        error,
      });
    }
  }

  private prune(dir: string): void {
    try {
      const deleted = pruneAutoBackups(dir, AUTO_BACKUPS_KEPT);
      if (deleted.length > 0) {
        this.deps.logger.info('backup.pruned', { count: deleted.length });
      }
    } catch (error) {
      this.deps.logger.warn('backup.prune_failed', { error });
    }
  }

  private nextAutomaticAt(now: Instant, timezone: string): Instant {
    const lastSuccess = this.repo.lastRun('AUTO', 'SUCCEEDED');
    if (lastSuccess) {
      const day = businessDay(lastSuccess.startedAt, timezone);
      if (day >= businessDay(now, timezone)) {
        return businessDayRange(day, timezone).end;
      }
    }
    const last = this.repo.lastRun('AUTO');
    if (last?.outcome === 'FAILED') {
      const retryAt = toInstant(
        Date.parse(last.finishedAt) +
          (this.deps.retryAfterMs ?? DEFAULT_RETRY_MS),
      );
      if (retryAt > now) return retryAt;
    }
    return now;
  }

  private currentStatus(): BackupStatusDto {
    const { timezone } = this.repo.shopContext();
    const destination = this.destination();
    const failure = this.repo.unresolvedAutoFailure();
    return {
      destination: { path: destination.dir, isDefault: destination.isDefault },
      lastAutomatic: this.repo.lastRun('AUTO'),
      lastSuccessfulAutomatic: this.repo.lastRun('AUTO', 'SUCCEEDED'),
      recentRuns: this.repo.recentRuns(RECENT_RUNS),
      nextAutomaticAt: this.nextAutomaticAt(this.deps.clock.now(), timezone),
      notice: failure
        ? {
            errorCode: failure.errorCode as string,
            failedAt: failure.finishedAt,
          }
        : null,
    };
  }
}
