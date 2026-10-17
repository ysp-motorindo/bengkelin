import { useNumberFormat } from '@/renderer/lib/number-format';
import {
  FileSearch,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
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
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { formatLocal } from '@/renderer/features/catalog/local-time';
import { useShopTimezone } from '@/renderer/features/history/use-shop-timezone';
import { flushAll } from '@/renderer/lib/flush-registry';
import { useAction } from '@/renderer/lib/use-action';
import {
  RESTORE_CONFIRMATION_PHRASES,
  type RestorePreviewDto,
} from '@/shared/contracts';

type Phase = 'idle' | 'restoring' | 'restarting';

/**
 * "Pulihkan / Restore" in the ADMIN Settings screen (spec 43): choose a
 * backup file (native dialog in main) -> preview of the staged copy ->
 * type the confirmation phrase -> Restore. Pending draft input is flushed
 * first; the application then restarts to the login screen.
 */
export function RestoreSection() {
  const { numberOptions, formatNumber } = useNumberFormat();
  const { t, i18n } = useTranslation();
  const timezone = useShopTimezone();
  const ids = { phrase: useId() };
  const [preview, setPreview] = useState<RestorePreviewDto | null>(null);
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const { busy, error, setError, run, check } = useAction();

  const phrase =
    RESTORE_CONFIRMATION_PHRASES[i18n.language === 'en' ? 'en' : 'id'];
  const confirmed = typed.trim() === phrase;
  const locked = busy || phase !== 'idle';
  const time = (instant: string) =>
    timezone ? formatLocal(instant, timezone) : instant;

  function reset() {
    setPreview(null);
    setTyped('');
  }

  function chooseFile() {
    void run(async () => {
      const result = await window.bengkelin.backups.inspectRestore();
      if (!check(result)) {
        reset();
        return;
      }
      if (result.value.outcome === 'READY') {
        setPreview(result.value.preview);
        setTyped('');
      }
    });
  }

  function cancel() {
    if (!preview) return;
    const { token } = preview;
    void run(async () => {
      reset();
      await window.bengkelin.backups.cancelRestore({ token });
    });
  }

  function restore() {
    if (!preview || !confirmed) return;
    const { token } = preview;
    void run(async () => {
      setPhase('restoring');
      // Pending draft input is saved before the database is replaced.
      if (!(await flushAll())) {
        setPhase('idle');
        setError(t('restore.flushFailed'));
        return;
      }
      const result = await window.bengkelin.backups.restore({
        token,
        confirmed: true,
      });
      if (!check(result)) {
        // The token is single use: choose the file again.
        setPhase('idle');
        reset();
        return;
      }
      setPhase('restarting');
    });
  }

  return (
    <Card data-testid="restore-section">
      <CardHeader>
        <CardTitle className="text-lg">{t('restore.title')}</CardTitle>
        <CardDescription>{t('restore.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? <Alert>{error}</Alert> : null}
        {phase === 'restarting' ? (
          <p
            role="status"
            data-testid="restore-restarting"
            className="flex items-center gap-2 text-sm font-medium"
          >
            <RotateCcw aria-hidden="true" className="size-4 animate-spin" />
            {t('restore.restarting')}
          </p>
        ) : null}
        {!preview && phase === 'idle' ? (
          <div>
            <Button variant="outline" onClick={chooseFile} disabled={locked}>
              <FileSearch aria-hidden="true" />
              {t('restore.chooseFile')}
            </Button>
          </div>
        ) : null}
        {preview && phase !== 'restarting' ? (
          <section
            data-testid="restore-preview"
            aria-labelledby="restore-preview-title"
            className="flex flex-col gap-3"
          >
            <h3 id="restore-preview-title" className="text-sm font-medium">
              {t('restore.preview.title', {
                fileName: preview.sourceFileName,
              })}
            </h3>
            <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
              <Row label={t('restore.preview.shop')}>{preview.shopName}</Row>
              <Row label={t('restore.preview.schema')} testId="restore-schema">
                {preview.originalSchemaVersion === preview.schemaVersion
                  ? String(preview.schemaVersion)
                  : t('restore.preview.schemaMigrated', {
                      from: preview.originalSchemaVersion,
                      to: preview.schemaVersion,
                    })}
              </Row>
              <Row
                label={t('restore.preview.invoices')}
                testId="restore-invoices"
              >
                {t('restore.preview.invoiceCounts', {
                  ...numberOptions,
                  ...preview.counts.invoices,
                })}
              </Row>
              <Row label={t('restore.preview.latestFinalized')}>
                {preview.latestFinalizedAt
                  ? time(preview.latestFinalizedAt)
                  : t('restore.preview.none')}
              </Row>
              <Row label={t('restore.preview.catalogItems')}>
                {formatNumber(preview.counts.catalogItems)}
              </Row>
              <Row label={t('restore.preview.customers')}>
                {formatNumber(preview.counts.customers)}
              </Row>
              <Row label={t('restore.preview.cashiers')}>
                {t('restore.preview.cashierCounts', {
                  ...numberOptions,
                  total: preview.counts.cashiers,
                  admins: preview.activeAdmins,
                })}
              </Row>
            </dl>
            <p
              data-testid="restore-warning"
              className="flex items-start gap-2 rounded-md border border-destructive/50 px-3 py-2 text-sm"
            >
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-destructive"
              />
              <span>{t('restore.preview.warning')}</span>
            </p>
            <p className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
              <ShieldCheck
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-primary"
              />
              <span>{t('restore.preview.safetyNote')}</span>
            </p>
            <div className="flex max-w-sm flex-col gap-1">
              <Label htmlFor={ids.phrase}>
                {t('restore.confirmLabel', { phrase })}
              </Label>
              <Input
                id={ids.phrase}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                disabled={locked}
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={restore}
                disabled={locked || !confirmed}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {phase === 'restoring'
                  ? t('restore.working')
                  : t('restore.restore')}
              </Button>
              <Button variant="outline" onClick={cancel} disabled={locked}>
                {t('restore.cancel')}
              </Button>
            </div>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="min-w-0 break-all">
        {children}
      </dd>
    </>
  );
}
