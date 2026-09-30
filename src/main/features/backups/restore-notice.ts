import fs from 'node:fs';
import path from 'node:path';
import { requireAdmin } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type { Logger } from '@/main/platform/logger';
import {
  RESTORE_NOTICE_OUTCOMES,
  type RestoreNoticeDto,
  type RestoreNoticeOutcome,
} from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';
import { isInstant } from '@/shared/time';
import type { RecoveryOutcome } from './restore-recovery';

/**
 * One-time notice of how the last restore ended (T16 concern, T17 ruling).
 * Startup recovery runs before the database opens, so the notice lives in
 * a small JSON file in userData (not in the database, which may just have
 * been replaced). The next ADMIN to sign in takes it: it is shown once and
 * deleted.
 */

export function restoreNoticePath(dataDir: string): string {
  return path.join(dataDir, 'restore-notice.json');
}

/** How a recovery outcome is reported; null when there is nothing to say. */
export function noticeOutcomeFor(
  recovery: RecoveryOutcome,
): RestoreNoticeOutcome | null {
  switch (recovery.outcome) {
    case 'RESTORED':
      // An interrupted swap finished at startup vs. the normal restart
      // after a completed swap.
      return recovery.stage === 'MOVED_ASIDE' || recovery.stage === 'PREPARED'
        ? 'ROLLED_FORWARD'
        : 'COMPLETED';
    case 'ROLLED_BACK':
    case 'KEPT_CURRENT':
      return 'ROLLED_BACK';
    default:
      return null;
  }
}

/** Written after startup recovery; never throws (logs instead). */
export function recordRestoreNotice(input: {
  dataDir: string;
  recovery: RecoveryOutcome;
  at: Instant;
  logger?: Logger;
}): RestoreNoticeDto | null {
  const outcome = noticeOutcomeFor(input.recovery);
  if (!outcome) return null;
  const notice: RestoreNoticeDto = { outcome, at: input.at };
  const target = restoreNoticePath(input.dataDir);
  const temp = `${target}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(notice));
    fs.renameSync(temp, target);
    return notice;
  } catch (error) {
    input.logger?.warn('restore.notice_write_failed', { error });
    return null;
  }
}

function parse(text: string): RestoreNoticeDto | null {
  try {
    const raw = JSON.parse(text) as Partial<RestoreNoticeDto> | null;
    if (
      raw &&
      RESTORE_NOTICE_OUTCOMES.includes(raw.outcome as RestoreNoticeOutcome) &&
      typeof raw.at === 'string' &&
      isInstant(raw.at)
    ) {
      return { outcome: raw.outcome as RestoreNoticeOutcome, at: raw.at };
    }
  } catch {
    // Unreadable: dropped below.
  }
  return null;
}

export class RestoreNoticeService {
  constructor(
    private readonly deps: { dataDir: string; logger?: Logger | undefined },
  ) {}

  /** ADMIN: the pending notice (once), or null. A CASHIER never consumes it. */
  take(session: Session | undefined): RestoreNoticeDto | null {
    requireAdmin(session);
    const file = restoreNoticePath(this.deps.dataDir);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      this.deps.logger?.warn('restore.notice_clear_failed', { error });
    }
    return parse(text);
  }
}
