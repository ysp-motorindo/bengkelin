import path from 'node:path';
import type { Instant } from '@/shared/primitives';
import {
  DATABASE_FILES,
  SIDECARS,
  writeMarker,
  type RestoreFs,
  type RestoreStage,
} from './restore-fs';

/**
 * The file swap of a restore (T16), as a pure function over `RestoreFs`.
 * The durable marker is written BEFORE each change it describes becomes
 * visible, so startup recovery (restore-recovery.ts) can always tell what
 * happened:
 *
 *   markPrepared         marker PREPARED (nothing moved yet)
 *   closeLive            stop background work, close the live connection
 *   moveAsideMain/Wal/Shm  live db, -wal, -shm -> <db>.pre-restore-<ts>[-wal|-shm]
 *   markMovedAside       marker MOVED_ASIDE (the target is empty)
 *   removeStaleSidecars  delete any -wal/-shm left at the target
 *   swapIn               staged file -> target, fsync the folder
 *   markReplaced         marker REPLACED
 *
 * No step cleans up after a failure: an exception leaves the files exactly
 * as a crash at that point would, and recovery decides (one code path for
 * crashes and errors). `beforeStep` lets tests fail before any step.
 */

export const SWAP_STEPS = [
  'markPrepared',
  'closeLive',
  'moveAsideMain',
  'moveAsideWal',
  'moveAsideShm',
  'markMovedAside',
  'removeStaleSidecars',
  'swapIn',
  'markReplaced',
] as const;
export type SwapStep = (typeof SWAP_STEPS)[number];

export interface SwapPlan {
  dataDir: string;
  targetPath: string;
  stagedPath: string;
  asidePath: string;
  safetyBackup: string;
  startedAt: Instant;
}

export interface SwapDeps {
  fs: RestoreFs;
  /** Stops background work and closes the live connection. */
  closeLive: () => void;
  beforeStep?: (step: SwapStep) => void;
}

const MOVE_STEPS: Record<(typeof DATABASE_FILES)[number], SwapStep> = {
  '': 'moveAsideMain',
  '-wal': 'moveAsideWal',
  '-shm': 'moveAsideShm',
};

/** `<target>.pre-restore-<compact UTC instant>` next to the live database. */
export function asidePathFor(targetPath: string, startedAt: Instant): string {
  return `${targetPath}.pre-restore-${startedAt.replace(/[-:.]/g, '')}`;
}

/**
 * Runs the swap. Throws whatever a step throws, leaving the files as they
 * are; `onClosed` tells the caller whether the live connection is closed.
 */
export function performSwap(
  plan: SwapPlan,
  deps: SwapDeps,
  onClosed: () => void = () => undefined,
): void {
  const { fs } = deps;
  const step = (name: SwapStep) => deps.beforeStep?.(name);
  const mark = (stage: RestoreStage) =>
    writeMarker(fs, plan.dataDir, { ...plan, stage });
  const dir = path.dirname(plan.targetPath);

  step('markPrepared');
  mark('PREPARED');

  step('closeLive');
  deps.closeLive();
  onClosed();

  for (const suffix of DATABASE_FILES) {
    step(MOVE_STEPS[suffix]);
    if (fs.exists(plan.targetPath + suffix)) {
      fs.rename(plan.targetPath + suffix, plan.asidePath + suffix);
    }
  }
  fs.fsyncDir(dir);

  step('markMovedAside');
  mark('MOVED_ASIDE');

  step('removeStaleSidecars');
  for (const suffix of SIDECARS) fs.remove(plan.targetPath + suffix);
  fs.fsyncDir(dir);

  step('swapIn');
  fs.rename(plan.stagedPath, plan.targetPath);
  fs.fsyncDir(dir);

  step('markReplaced');
  mark('REPLACED');
}
