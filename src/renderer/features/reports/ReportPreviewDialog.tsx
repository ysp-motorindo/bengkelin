import { useNumberFormat } from '@/renderer/lib/number-format';
import { Printer, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { errorMessage } from '@/renderer/lib/errors';
import { ShadowDocument } from '@/renderer/features/printing/ShadowDocument';
import type { DailyReportInput, ReportPreviewDto } from '@/shared/contracts';
import type { ReportClient } from './report-client';

/**
 * In-app preview of exactly the A4 document main prints (the T12 Shadow DOM
 * preview, CSP unchanged). Print sends the same report input.
 */
export function ReportPreviewDialog({
  input,
  client,
  busy,
  notice,
  onPrint,
  onClose,
}: {
  input: DailyReportInput;
  client: ReportClient;
  busy: boolean;
  /** The latest print outcome, repeated here while the dialog covers it. */
  notice: string | null;
  onPrint(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { locale } = useNumberFormat();
  const [preview, setPreview] = useState<ReportPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    client.preview(input).then(
      (result) => {
        if (!current) return;
        if (result.ok) setPreview(result.value);
        else setError(errorMessage(t, result.error));
      },
      () => current && setError(t('errors.INTERNAL_ERROR')),
    );
    return () => {
      current = false;
    };
  }, [client, input, t, locale]);

  return (
    <Dialog
      title={t('reports.preview.title')}
      onClose={onClose}
      closeLabel={t('reports.preview.close')}
      scrollBody
      footer={
        <DialogActions
          secondary={
            <Button variant="outline" onClick={onClose}>
              <X aria-hidden="true" />
              {t('reports.preview.close')}
            </Button>
          }
        >
          <Button onClick={onPrint} disabled={busy || !preview}>
            <Printer aria-hidden="true" />
            {t('reports.preview.print')}
          </Button>
        </DialogActions>
      }
    >
      {notice ? (
        <p className="text-sm" data-testid="report-preview-notice">
          {notice}
        </p>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      {preview ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <ShadowDocument
            html={preview.html}
            label={t('reports.preview.documentLabel')}
          />
        </div>
      ) : error ? null : (
        <p className="text-sm text-muted-foreground" role="status">
          {t('reports.preview.loading')}
        </p>
      )}
    </Dialog>
  );
}
