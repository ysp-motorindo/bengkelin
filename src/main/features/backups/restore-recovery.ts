import path from 'node:path';
import type { Logger } from '@/main/platform/logger';
import {
  DATABASE_FILES,
  nodeRestoreFs,
  readMarker,
  removeMarker,
  restoreLayout,
  SIDECARS,
  writeMarker,
  type RestoreFs,
  type RestoreMarker,
  type RestoreStage,
} from './restore-fs';
import { validateBackup } from './validation';

/**
 * Startup recovery for an interrupted restore (T16). Runs in main.ts BEFORE
 * the database is opened. Whatever the marker says, it ends with either the
 * complete old database or the complete restored one at the target path,
 * validated, or it reports FATAL (the caller shows an error naming the
 * safety backup and the aside files, then quits) and never creates a fresh
 * database over them.
 *
 *   no marker     remove orphaned staging                      -> NO_MARKER
 *   PREPARED      nothing moved: keep the live database         -> KEPT_CURRENT
 *                 (moved partly: move it back)                  -> ROLLED_BACK
 *                 (no database at all)                          -> FATAL
 *   MOVED_ASIDE   staged file valid: finish the swap            -> RESTORED
 *                 staged already swapped in and valid           -> RESTORED
 *                 otherwise move the old files back             -> ROLLED_BACK
 *   REPLACED      target valid                                  -> RESTORED
 *                 target invalid: move the old files back       -> ROLLED_BACK
 *   ROLLING_BACK  finish moving the old files back              -> ROLLED_BACK
 *   DONE          only the clean-up was left                    -> RESTORED
 *
 * Every decision is logged without personal data or paths (file names only).
 */

export type RecoveryOutcome =
  | { outcome: 'NO_MARKER' }
  | { outcome: 'KEPT_CURRENT' }
  | { outcome: 'ROLLED_BACK'; stage: RestoreStage }
  | { outcome: 'RESTORED'; stage: RestoreStage; asideFiles: string[] }
  | {
      outcome: 'FATAL';
      stage: RestoreStage | null;
      /** Full path of the safety backup, when known. */
      safetyBackup: string | null;
      /** Full paths of the moved-aside files that still exist. */
      asideFiles: string[];
    };

export interface RecoveryInput {
  /** userData. */
  dataDir: string;
  /** The live database path. */
  databasePath: string;
  logger: Logger;
  fs?: RestoreFs;
  /** Default: `validateBackup(file).ok`. */
  validate?: (file: string) => boolean;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

export function recoverInterruptedRestore(
  input: RecoveryInput,
): RecoveryOutcome {
  const { dataDir, databasePath, logger } = input;
  const fs = input.fs ?? nodeRestoreFs;
  const validate = input.validate ?? ((file) => validateBackup(file).ok);
  const layout = restoreLayout(dataDir);
  const target = path.resolve(databasePath);

  const cleanupStaging = () => {
    try {
      if (fs.exists(layout.stagingRoot)) {
        fs.removeTree(layout.stagingRoot);
        logger.info('restore.recovery.staging_removed', {});
      }
    } catch (error) {
      logger.warn('restore.recovery.staging_cleanup_failed', { error });
    }
  };

  const existingAside = (marker: RestoreMarker | null) =>
    marker
      ? DATABASE_FILES.map((suffix) => marker.asidePath + suffix).filter(
          (file) => fs.exists(file),
        )
      : [];

  const fatal = (
    marker: RestoreMarker | null,
    reason: string,
  ): RecoveryOutcome => {
    const asideFiles = existingAside(marker);
    logger.error('restore.recovery.fatal', {
      stage: marker?.stage ?? null,
      reason,
      asideCount: asideFiles.length,
    });
    return {
      outcome: 'FATAL',
      stage: marker?.stage ?? null,
      safetyBackup: marker?.safetyBackup ?? null,
      asideFiles,
    };
  };

  const removeTargetSidecars = () => {
    for (const suffix of SIDECARS) fs.remove(target + suffix);
    fs.fsyncDir(path.dirname(target));
  };

  const pathsMatch = (marker: RestoreMarker) =>
    path.resolve(marker.dataDir) === path.resolve(dataDir) &&
    path.resolve(marker.targetPath) === target &&
    inside(layout.stagingRoot, path.resolve(marker.stagedPath)) &&
    path.dirname(path.resolve(marker.asidePath)) === path.dirname(target) &&
    path
      .basename(marker.asidePath)
      .startsWith(`${path.basename(target)}.pre-restore-`);

  // ---- outcomes ----

  const keepCurrent = (): RecoveryOutcome => {
    removeMarker(fs, dataDir);
    cleanupStaging();
    logger.info('restore.recovery.kept_current', {});
    return { outcome: 'KEPT_CURRENT' };
  };

  const finishRestored = (marker: RestoreMarker): RecoveryOutcome => {
    writeMarker(fs, dataDir, { ...marker, stage: 'DONE' });
    removeMarker(fs, dataDir);
    cleanupStaging();
    const asideFiles = existingAside(marker);
    logger.info('restore.recovery.aside_kept', {
      files: asideFiles.map((file) => path.basename(file)),
    });
    return { outcome: 'RESTORED', stage: marker.stage, asideFiles };
  };

  /** Moves the aside files back over the target (resumable). */
  const rollBack = (marker: RestoreMarker, reason: string): RecoveryOutcome => {
    const from = marker.stage;
    if (from !== 'ROLLING_BACK') {
      if (!fs.exists(marker.asidePath) || !validate(marker.asidePath)) {
        return fatal(marker, `${reason}; aside_invalid`);
      }
      // After MOVED_ASIDE every old sidecar is aside: anything at the target
      // is stale and must not be applied to the old database. Before that
      // (PREPARED) a sidecar still at the target is the old database's own.
      if (from !== 'PREPARED') removeTargetSidecars();
      writeMarker(fs, dataDir, { ...marker, stage: 'ROLLING_BACK' });
    }
    for (const suffix of DATABASE_FILES) {
      if (fs.exists(marker.asidePath + suffix)) {
        fs.rename(marker.asidePath + suffix, target + suffix);
      }
    }
    fs.fsyncDir(path.dirname(target));
    if (!validate(target)) return fatal(marker, `${reason}; rollback_invalid`);
    removeMarker(fs, dataDir);
    cleanupStaging();
    logger.warn('restore.recovery.rolled_back', { from, reason });
    return { outcome: 'ROLLED_BACK', stage: from };
  };

  const fromReplaced = (marker: RestoreMarker): RecoveryOutcome => {
    // The restored file has never been opened: any sidecar is stale.
    removeTargetSidecars();
    if (validate(target)) return finishRestored(marker);
    return rollBack(marker, 'target_invalid');
  };

  const fromMovedAside = (marker: RestoreMarker): RecoveryOutcome => {
    if (fs.exists(marker.stagedPath) && validate(marker.stagedPath)) {
      try {
        removeTargetSidecars();
        fs.rename(marker.stagedPath, target);
        fs.fsyncDir(path.dirname(target));
        writeMarker(fs, dataDir, { ...marker, stage: 'REPLACED' });
      } catch (error) {
        logger.warn('restore.recovery.roll_forward_failed', { error });
        return rollBack(marker, 'roll_forward_failed');
      }
      logger.info('restore.recovery.rolled_forward', { via: 'staged' });
      return fromReplaced({ ...marker, stage: 'REPLACED' });
    }
    if (fs.exists(target)) {
      // Only the swapped-in file can be at the target once the old one was
      // moved aside (crash between the rename and the REPLACED marker).
      removeTargetSidecars();
      if (validate(target)) {
        logger.info('restore.recovery.rolled_forward', { via: 'target' });
        return finishRestored(marker);
      }
    }
    return rollBack(marker, 'staged_invalid');
  };

  // ---- decision ----

  const read = readMarker(fs, dataDir);
  if (read.kind === 'NONE') {
    fs.remove(`${layout.markerPath}.tmp`);
    cleanupStaging();
    return { outcome: 'NO_MARKER' };
  }
  if (read.kind === 'UNREADABLE' || !pathsMatch(read.marker)) {
    logger.warn('restore.recovery.marker_unreadable', {});
    if (!validate(target)) return fatal(null, 'marker_unreadable');
    // Either database at the target is complete: keep it, keep the marker
    // for inspection under another name.
    try {
      fs.rename(layout.markerPath, `${layout.markerPath}.unreadable`);
    } catch (error) {
      logger.error('restore.recovery.marker_unremovable', { error });
      return fatal(null, 'marker_unremovable');
    }
    cleanupStaging();
    logger.info('restore.recovery.kept_current', {});
    return { outcome: 'KEPT_CURRENT' };
  }

  const { marker } = read;
  logger.info('restore.recovery.marker', { stage: marker.stage });
  try {
    switch (marker.stage) {
      case 'PREPARED':
        if (fs.exists(marker.asidePath)) {
          return rollBack(marker, 'interrupted_move');
        }
        // Never let the normal open create an empty database here.
        return fs.exists(target)
          ? keepCurrent()
          : fatal(marker, 'target_missing');
      case 'MOVED_ASIDE':
        return fromMovedAside(marker);
      case 'REPLACED':
        return fromReplaced(marker);
      case 'ROLLING_BACK':
        return rollBack(marker, 'resumed');
      case 'DONE':
        return finishRestored(marker);
    }
  } catch (error) {
    logger.error('restore.recovery.failed', { stage: marker.stage, error });
    return fatal(marker, 'unexpected_error');
  }
}
