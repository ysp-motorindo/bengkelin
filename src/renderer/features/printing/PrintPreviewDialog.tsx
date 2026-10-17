import { Printer, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog } from '@/renderer/components/ui/dialog';
import { Label } from '@/renderer/components/ui/label';
import { Select } from '@/renderer/components/ui/select';
import { errorMessage } from '@/renderer/lib/errors';
import type { PrintFormat, PrintPreviewDto } from '@/shared/contracts';
import { PRINT_FORMATS } from '@/shared/contracts';
import type { PrintClient } from './print-client';
import { ShadowDocument } from './ShadowDocument';

/**
 * In-app preview of exactly the document main prints (spec 30). The format
 * can be switched; Print sends the shown format.
 */
export function PrintPreviewDialog({
  invoiceId,
  initialFormat,
  client,
  busy,
  notice,
  onPrint,
  onClose,
}: {
  invoiceId: string;
  initialFormat: PrintFormat;
  client: PrintClient;
  busy: boolean;
  /** The latest print outcome, repeated here while the dialog covers it. */
  notice: string | null;
  onPrint(format: PrintFormat): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<PrintFormat>(initialFormat);
  const [preview, setPreview] = useState<PrintPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const formatId = useId();

  useEffect(() => {
    let current = true;
    setError(null);
    client.preview({ invoiceId, format }).then(
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
  }, [client, invoiceId, format, t]);

  const shown = preview?.format === format ? preview : null;

  return (
    <Dialog
      title={t('printing.preview.title')}
      onClose={onClose}
      closeLabel={t('printing.preview.close')}
      className="max-w-[min(96vw,64rem)]"
      footer={
        <div className="flex justify-between border-t border-border pt-3">
          <Button variant="outline" onClick={onClose}>
            <X aria-hidden="true" />
            {t('printing.preview.close')}
          </Button>
          <Button onClick={() => onPrint(format)} disabled={busy}>
            <Printer aria-hidden="true" />
            {t('printing.preview.print')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={formatId}>{t('printing.preview.format')}</Label>
          <Select
            id={formatId}
            value={format}
            onChange={(event) => setFormat(event.target.value as PrintFormat)}
          >
            {PRINT_FORMATS.map((value) => (
              <option key={value} value={value}>
                {t(`printing.format.${value}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {notice ? (
        <p className="text-sm" data-testid="preview-print-notice">
          {notice}
        </p>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      {shown ? (
        <div className="max-h-[70vh] overflow-auto rounded-md border border-border">
          <ShadowDocument
            html={shown.html}
            label={t('printing.preview.documentLabel', {
              format: t(`printing.format.${format}`),
            })}
          />
        </div>
      ) : error ? null : (
        <p className="text-sm text-muted-foreground" role="status">
          {t('printing.preview.loading')}
        </p>
      )}
    </Dialog>
  );
}
