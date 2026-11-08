import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AppDatabase } from '@/main/database/connection';
import { latestBundledVersion } from '@/main/database/migrate';
import { requireAdmin } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type { FileDialogs } from '@/main/features/printing/driver';
import type { Logger } from '@/main/platform/logger';
import type { MaintenanceGate } from '@/main/platform/maintenance';
import type {
  BackupSummary,
  CancelRestoreInput,
  RestoreInput,
  RestoreInspectionDto,
  RestorePreviewDto,
  RestoreStartedDto,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import { toInstant, type Clock } from '@/shared/time';
import { readIssuedSequences } from './restore-counters';
import {
  nodeRestoreFs,
  removeMarker,
  restoreLayout,
  type RestoreFs,
} from './restore-fs';
import {
  applyStagedSafeguards,
  stageCandidate,
  type StagedCandidate,
} from './restore-staging';
import {
  asidePathFor,
  performSwap,
  type SwapPlan,
  type SwapStep,
} from './restore-swap';
import type { BackupService } from './service';
import { validateBackup } from './validation';

/**
 * Restore (spec 43; T16 rulings). ADMIN only.
 *
 * `inspect`: native open dialog in main -> copy into
 * `userData/restore-staging/<token>/` -> validate -> migrate the copy ->
 * preview. The token lives in memory with a TTL; expiry, cancellation or a
 * newer inspection deletes its staging folder.
 *
 * `restore` (after the renderer flushed pending draft input and the ADMIN
 * typed the confirmation phrase):
 *  1. maintenance flag: new mutating commands get RESTORE_IN_PROGRESS,
 *     reads continue; running writes are drained;
 *  2. SAFETY backup of the current database (failure: nothing changed);
 *  3. staged copy: invoice counters raised to max(current, staged) per
 *     date and a DATABASE_RESTORED audit row (actor names in metadata,
 *     no actor id), checkpointed, closed, validated again;
 *  4. the marker-driven swap (restore-swap.ts), with the live connection
 *     closed;
 *  5. relaunch. Startup recovery (restore-recovery.ts) finishes the job.
 * A failure before the live connection closes clears the flag and changes
 * nothing; after it, the app restarts and recovery decides.
 */

export const RESTORE_TOKEN_TTL_MS = 15 * 60_000;
export const RESTORE_DRAIN_TIMEOUT_MS = 30_000;

export const PRE_SWAP_STEPS = [
  'drain',
  'safetyBackup',
  'stageSafeguards',
  'closeStaged',
  'revalidate',
] as const;
export type RestoreStep =
  | (typeof PRE_SWAP_STEPS)[number]
  | SwapStep
  | 'relaunch';

/** Test seam: runs (and may throw) before each step. */
export interface RestoreHooks {
  beforeStep?(step: RestoreStep): void | Promise<void>;
}

export interface RestoreServiceDeps {
  db: AppDatabase;
  clock: Clock;
  logger: Logger;
  dialogs: FileDialogs;
  backups: Pick<BackupService, 'createValidatedBackup' | 'backupDirectory'>;
  maintenance: MaintenanceGate;
  /** userData: staging folder and recovery marker. */
  dataDir: string;
  /** The live database file. */
  databasePath: string;
  /** Stops background work that uses the database (backup scheduler). */
  onDatabaseClosing?: () => void;
  /** Restarts the application (app.relaunch + app.exit in main). */
  relaunch: () => void;
  fs?: RestoreFs;
  hooks?: RestoreHooks;
  tokenTtlMs?: number;
  drainTimeoutMs?: number;
  newId?: () => string;
}

interface PendingRestore {
  token: string;
  candidate: StagedCandidate;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Failures that are reported as they are; anything else is RESTORE_FAILED. */
const PASS_THROUGH = new Set([
  'RESTORE_SAFETY_BACKUP_FAILED',
  'RESTORE_VALIDATION_FAILED',
  'RESTORE_BUSY',
]);

export class RestoreService {
  private pending: PendingRestore | null = null;
  private readonly fs: RestoreFs;
  private readonly stagingRoot: string;

  constructor(private readonly deps: RestoreServiceDeps) {
    this.fs = deps.fs ?? nodeRestoreFs;
    this.stagingRoot = restoreLayout(deps.dataDir).stagingRoot;
  }

  /** `backups.inspectRestore()`: choose, stage, validate, migrate, preview. */
  async inspect(session: Session | undefined): Promise<RestoreInspectionDto> {
    requireAdmin(session);
    const chosen = await this.deps.dialogs.chooseRestoreFile();
    if (chosen === null) return { outcome: 'CANCELLED' };
    // The dialog awaited: re-check the role and the maintenance flag.
    requireAdmin(session);
    this.deps.maintenance.assertWritable();
    this.discardPending('replaced');

    const token = (this.deps.newId ?? randomUUID)();
    const candidate = stageCandidate({
      source: path.resolve(chosen),
      stagingDir: path.join(this.stagingRoot, token),
      fs: this.fs,
    });
    const ttl = this.deps.tokenTtlMs ?? RESTORE_TOKEN_TTL_MS;
    const expiresAtMs = Date.parse(this.deps.clock.now()) + ttl;
    const timer = setTimeout(() => this.sweep(), ttl + 1_000);
    timer.unref?.();
    this.pending = { token, candidate, expiresAtMs, timer };
    this.deps.logger.info('restore.inspected', {
      from: candidate.originalSchemaVersion,
      to: candidate.schemaVersion,
    });
    return {
      outcome: 'READY',
      preview: toPreview(token, candidate, expiresAtMs),
    };
  }

  /** `backups.cancelRestore()`: forget the token, delete its staging. */
  cancel(session: Session | undefined, input: CancelRestoreInput): void {
    requireAdmin(session);
    if (this.pending?.token === input.token) this.discardPending('cancelled');
  }

  /** `backups.restore({ token, confirmed: true })`. */
  async restore(
    session: Session | undefined,
    input: RestoreInput,
  ): Promise<RestoreStartedDto> {
    const actor = requireAdmin(session);
    if (input.confirmed !== true) {
      throw new DomainError('RESTORE_NOT_CONFIRMED');
    }
    const { maintenance, logger } = this.deps;
    // A restore already running wins over a token check.
    maintenance.assertWritable();
    this.sweep();
    const pending = this.pending;
    if (!pending || pending.token !== input.token) {
      throw new DomainError('RESTORE_TOKEN_EXPIRED');
    }
    // Throws RESTORE_IN_PROGRESS when a restore is already running.
    maintenance.blockWrites();
    clearTimeout(pending.timer);
    this.pending = null;
    const { candidate } = pending;
    logger.info('restore.started', {});

    let safety: BackupSummary;
    let safetyPath: string;
    try {
      await this.step('drain');
      const drained = await maintenance.drain(
        this.deps.drainTimeoutMs ?? RESTORE_DRAIN_TIMEOUT_MS,
      );
      if (!drained) throw new DomainError('RESTORE_BUSY');

      await this.step('safetyBackup');
      try {
        safety = await this.deps.backups.createValidatedBackup({
          kind: 'SAFETY',
        });
      } catch (error) {
        const code = error instanceof DomainError ? error.code : 'UNKNOWN';
        throw new DomainError(
          'RESTORE_SAFETY_BACKUP_FAILED',
          'The safety backup failed',
          { reason: code },
        );
      }
      safetyPath = path.join(
        this.deps.backups.backupDirectory(),
        safety.fileName,
      );

      await this.step('stageSafeguards');
      applyStagedSafeguards(
        {
          stagedPath: candidate.stagedPath,
          clock: this.deps.clock,
          currentSequences: readIssuedSequences(this.deps.db),
          audit: {
            actorUsername: actor.username,
            actorDisplayName: actor.displayName,
            sourceFileName: candidate.sourceFileName,
            safetyBackupFileName: safety.fileName,
            originalSchemaVersion: candidate.originalSchemaVersion,
          },
          beforeClose: () => void this.deps.hooks?.beforeStep?.('closeStaged'),
        },
        this.fs,
      );

      await this.step('revalidate');
      const validation = validateBackup(candidate.stagedPath);
      if (!validation.ok || validation.schemaVersion !== latestBundledVersion) {
        throw new DomainError('RESTORE_VALIDATION_FAILED', undefined, {
          reason: validation.error ?? 'SCHEMA_VERSION',
        });
      }
    } catch (error) {
      throw this.abortBeforeSwap(candidate, error);
    }

    const startedAt = this.deps.clock.now();
    const plan: SwapPlan = {
      dataDir: this.deps.dataDir,
      targetPath: this.deps.databasePath,
      stagedPath: candidate.stagedPath,
      asidePath: asidePathFor(this.deps.databasePath, startedAt),
      safetyBackup: safetyPath,
      startedAt,
    };
    let closed = false;
    try {
      performSwap(
        plan,
        {
          fs: this.fs,
          closeLive: () => this.closeLive(),
          beforeStep: (step) => void this.deps.hooks?.beforeStep?.(step),
        },
        () => {
          closed = true;
        },
      );
      await this.step('relaunch');
    } catch (error) {
      if (!closed) {
        try {
          removeMarker(this.fs, this.deps.dataDir);
        } catch (markerError) {
          // Startup treats a PREPARED marker as "nothing moved".
          logger.error('restore.marker_cleanup_failed', { error: markerError });
        }
        throw this.abortBeforeSwap(candidate, error);
      }
      // The live connection is closed: restart; startup recovery finishes
      // or undoes the swap from the marker.
      logger.error('restore.swap_failed', { error });
      this.relaunch();
      throw new DomainError('RESTORE_FAILED');
    }

    logger.info('restore.replaced', { safety: safety.fileName });
    this.relaunch();
    return { restarting: true, safetyBackupFileName: safety.fileName };
  }

  // ---- internals ----

  private async step(step: RestoreStep): Promise<void> {
    await this.deps.hooks?.beforeStep?.(step);
  }

  private closeLive(): void {
    this.deps.maintenance.close();
    this.deps.onDatabaseClosing?.();
    this.deps.db.close();
  }

  private relaunch(): void {
    try {
      this.deps.relaunch();
    } catch (error) {
      this.deps.logger.error('restore.relaunch_failed', { error });
    }
  }

  /** Nothing was swapped: delete the staging, clear the flag, map the error. */
  private abortBeforeSwap(
    candidate: StagedCandidate,
    error: unknown,
  ): DomainError {
    try {
      this.fs.removeTree(candidate.stagingDir);
    } catch (cleanupError) {
      this.deps.logger.warn('restore.staging_cleanup_failed', {
        error: cleanupError,
      });
    }
    this.deps.maintenance.reopen();
    const failure =
      error instanceof DomainError && PASS_THROUGH.has(error.code)
        ? error
        : new DomainError('RESTORE_FAILED');
    if (failure !== error) {
      this.deps.logger.error('restore.unexpected_error', { error });
    }
    this.deps.logger.warn('restore.aborted', {
      code: failure.code,
      ...(failure.params ? { reason: failure.params.reason } : {}),
    });
    return failure;
  }

  private sweep(): void {
    const pending = this.pending;
    if (!pending) return;
    if (Date.parse(this.deps.clock.now()) > pending.expiresAtMs) {
      this.discardPending('expired');
    }
  }

  private discardPending(reason: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    try {
      this.fs.removeTree(pending.candidate.stagingDir);
    } catch (error) {
      this.deps.logger.warn('restore.staging_cleanup_failed', { error });
    }
    this.deps.logger.info('restore.discarded', { reason });
  }
}

function toPreview(
  token: string,
  candidate: StagedCandidate,
  expiresAtMs: number,
): RestorePreviewDto {
  return {
    token,
    expiresAt: toInstant(expiresAtMs),
    sourceFileName: candidate.sourceFileName,
    sourceSize: candidate.sourceSize,
    originalSchemaVersion: candidate.originalSchemaVersion,
    schemaVersion: candidate.schemaVersion,
    shopName: candidate.summary.shopName,
    counts: candidate.summary.counts,
    latestFinalizedAt: candidate.summary.latestFinalizedAt,
    latestPurchaseFinalizedAt: candidate.summary.latestPurchaseFinalizedAt,
    activeAdmins: candidate.summary.activeAdmins,
  };
}
