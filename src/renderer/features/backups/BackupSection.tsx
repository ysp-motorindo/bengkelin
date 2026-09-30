import { DatabaseBackup, FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/renderer/components/ui/card';
import { formatLocal } from '@/renderer/features/catalog/local-time';
import { useShopTimezone } from '@/renderer/features/history/use-shop-timezone';
import { useAction } from '@/renderer/lib/use-action';
import type { BackupRunDto } from '@/shared/contracts';
import { announceBackupChange, useBackupStatus } from './use-backup-status';

/**
 * "Cadangan / Backup" in the ADMIN Settings screen (spec 42): the backup
 * folder (chosen in a native dialog in main), "Backup now", the automatic
 * schedule and recent runs. A failed manual backup is shown inline.
 */
export function BackupSection() {
  const { t } = useTranslation();
  const timezone = useShopTimezone();
  const { status, setStatus } = useBackupStatus();
  const [notice, setNotice] = useState('');
  const { busy, error, run, check } = useAction();

  const time = (instant: string) =>
    timezone ? formatLocal(instant, timezone) : instant;

  function backupNow() {
    setNotice(t('backups.working'));
    void run(async () => {
      try {
        const result = await window.bengkelin.backups.create();
        if (check(result)) {
          setNotice(t('backups.created', { fileName: result.value.fileName }));
        } else {
          setNotice('');
        }
      } finally {
        announceBackupChange();
      }
    });
  }

  function chooseFolder() {
    setNotice('');
    void run(async () => {
      const result = await window.bengkelin.backups.chooseDestination();
      if (!check(result)) return;
      setStatus(result.value.status);
      if (result.value.outcome === 'UPDATED') {
        setNotice(t('backups.folderUpdated'));
        announceBackupChange();
      }
    });
  }

  const describeRun = (runDto: BackupRunDto | null) =>
    runDto
      ? `${time(runDto.startedAt)} (${t(`backups.outcome.${runDto.outcome}`)})`
      : t('backups.never');

  return (
    <Card data-testid="backup-section">
      <CardHeader>
        <CardTitle className="text-lg">{t('backups.title')}</CardTitle>
        <CardDescription>{t('backups.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">{t('backups.destination')}</dt>
          <dd
            data-testid="backup-destination"
            className="min-w-0 break-all font-mono text-xs leading-5"
          >
            {status ? status.destination.path : ''}
            {status?.destination.isDefault ? (
              <span className="ml-2 font-sans text-muted-foreground">
                {t('backups.defaultFolder')}
              </span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">
            {t('backups.lastAutomatic')}
          </dt>
          <dd>{status ? describeRun(status.lastAutomatic) : ''}</dd>
          <dt className="text-muted-foreground">
            {t('backups.nextAutomatic')}
          </dt>
          <dd>{status ? time(status.nextAutomaticAt) : ''}</dd>
        </dl>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={backupNow} disabled={busy}>
            <DatabaseBackup aria-hidden="true" />
            {t('backups.backupNow')}
          </Button>
          <Button variant="outline" onClick={chooseFolder} disabled={busy}>
            <FolderOpen aria-hidden="true" />
            {t('backups.chooseFolder')}
          </Button>
          <p
            role="status"
            data-testid="backup-notice"
            className="text-sm text-muted-foreground"
          >
            {notice}
          </p>
        </div>
        <section aria-labelledby="backup-history">
          <h3 id="backup-history" className="mb-1 text-sm font-medium">
            {t('backups.recent')}
          </h3>
          {status && status.recentRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('backups.none')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {status?.recentRuns.map((runDto, index) => (
                <li
                  key={`${runDto.startedAt}-${index}`}
                  className="flex flex-wrap gap-x-2"
                >
                  <span className="tabular-nums">{time(runDto.startedAt)}</span>
                  <span>{t(`backups.kind.${runDto.kind}`)}</span>
                  <span
                    className={
                      runDto.outcome === 'FAILED' ? 'text-destructive' : ''
                    }
                  >
                    {t(`backups.outcome.${runDto.outcome}`)}
                  </span>
                  <span className="min-w-0 break-all text-muted-foreground">
                    {runDto.fileName ??
                      (runDto.errorCode
                        ? t(`errors.${runDto.errorCode}`, {
                            defaultValue: runDto.errorCode,
                          })
                        : '')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
