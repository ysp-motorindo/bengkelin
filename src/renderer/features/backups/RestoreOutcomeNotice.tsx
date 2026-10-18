import { formatDisplayDateTime } from '@/renderer/lib/date-format';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import type { RestoreNoticeDto } from '@/shared/contracts';

/**
 * The one-time outcome of the last restore (T17 ruling): taken from main
 * after an ADMIN signs in (taking it clears it) and shown until dismissed.
 * A rollback is announced as an alert, a completed restore as a status.
 */
export function RestoreOutcomeNotice() {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<RestoreNoticeDto | null>(null);

  useEffect(() => {
    let live = true;
    const backups = window.bengkelin?.backups;
    if (typeof backups?.takeRestoreNotice !== 'function') return undefined;
    backups.takeRestoreNotice().then(
      (result) => {
        if (live && result.ok) setNotice(result.value);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  if (!notice) return null;
  const rolledBack = notice.outcome === 'ROLLED_BACK';
  const time = formatDisplayDateTime(
    notice.at,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ).slice(0, 16);

  return (
    <div
      role={rolledBack ? 'alert' : 'status'}
      data-testid="restore-notice"
      className={
        rolledBack
          ? 'flex items-start justify-between gap-3 border-b border-destructive/50 bg-destructive/10 px-4 py-2 text-sm text-destructive sm:px-6'
          : 'flex items-start justify-between gap-3 border-b border-border bg-card px-4 py-2 text-sm sm:px-6'
      }
    >
      <p>
        <span className="font-medium">{t('shell.restoreNotice.title')}: </span>
        {t(`shell.restoreNotice.${notice.outcome}`)}{' '}
        <span className="text-muted-foreground">
          {t('shell.restoreNotice.at', { time })}
        </span>
      </p>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('shell.restoreNotice.dismiss')}
        onClick={() => setNotice(null)}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
