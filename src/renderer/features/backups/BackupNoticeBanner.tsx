import { DatabaseBackup, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { formatLocal } from '@/renderer/features/catalog/local-time';
import { useShopTimezone } from '@/renderer/features/history/use-shop-timezone';
import { useAction } from '@/renderer/lib/use-action';
import type { BackupNoticeDto } from '@/shared/contracts';
import { announceBackupChange, useBackupStatus } from './use-backup-status';

/**
 * ADMIN shell banner (spec 42 "Admin should be notified if automatic backup
 * fails"). Main derives the notice from `backup_runs`, so it persists across
 * restarts until a later backup succeeds; "Backup now" retries in place.
 */
export function BackupNoticeBanner() {
  const { status } = useBackupStatus({ poll: true });
  return status?.notice ? <FailureNotice notice={status.notice} /> : null;
}

function FailureNotice({ notice }: { notice: BackupNoticeDto }) {
  const { t } = useTranslation();
  const timezone = useShopTimezone();
  const { busy, error, run, check } = useAction();

  function backupNow() {
    void run(async () => {
      try {
        check(await window.bengkelin.backups.create());
      } finally {
        announceBackupChange();
      }
    });
  }

  const reason = t(`errors.${notice.errorCode}`, {
    defaultValue: t('errors.INTERNAL_ERROR'),
  });
  return (
    <div
      role="alert"
      data-testid="backup-failure-banner"
      className="flex flex-wrap items-center gap-3 border-b border-destructive/50 bg-destructive/10 px-4 py-2 text-sm text-destructive sm:px-6"
    >
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{t('backups.notice.title')}</p>
        <p>
          {t('backups.notice.detail', {
            time: timezone
              ? formatLocal(notice.failedAt, timezone)
              : notice.failedAt,
            reason,
          })}
        </p>
        {error ? <p className="mt-1 font-medium">{error}</p> : null}
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={backupNow}>
        <DatabaseBackup aria-hidden="true" />
        {t('backups.notice.action')}
      </Button>
    </div>
  );
}
