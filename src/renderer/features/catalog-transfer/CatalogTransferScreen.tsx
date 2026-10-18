import { useNumberFormat } from '@/renderer/lib/number-format';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
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
import { useAction } from '@/renderer/lib/use-action';
import type {
  CatalogFileOutcomeDto,
  ImportReadyDto,
  ImportSummaryDto,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
import { ImportPreview } from './ImportPreview';

/**
 * ADMIN "Impor/Ekspor Katalog" (spec 37-41). Every file is chosen in a
 * native dialog shown by main; this screen never handles a path. An import
 * shows its preview (errors and warnings by row) and is committed only when
 * the preview allows it; main takes a safety backup first.
 */
export function CatalogTransferScreen() {
  const { numberOptions } = useNumberFormat();
  const { t } = useTranslation();
  const { busy, error, setError, run, check } = useAction();
  const [notices, setNotices] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImportReadyDto | null>(null);
  const [result, setResult] = useState<ImportSummaryDto | null>(null);

  function saveFile(call: () => Promise<Result<CatalogFileOutcomeDto>>) {
    setNotices([]);
    void run(async () => {
      const outcome = await call();
      if (!check(outcome)) return;
      const value = outcome.value;
      if (value.outcome === 'CANCELLED') return;
      if (value.outcome === 'FAILED') {
        setError(t('catalogTransfer.exportFailed'));
        return;
      }
      setNotices([
        t('catalogTransfer.saved', {
          ...numberOptions,
          fileName: value.fileName,
          count: value.itemCount,
        }),
        ...(value.skuMissingCount > 0
          ? [
              t('catalogTransfer.skuMissing', {
                ...numberOptions,
                count: value.skuMissingCount,
              }),
            ]
          : []),
      ]);
    });
  }

  function chooseImport() {
    setNotices([]);
    setResult(null);
    void run(async () => {
      const outcome = await window.bengkelin.catalogTransfer.previewImport();
      if (!check(outcome)) return;
      if (outcome.value.outcome === 'READY') setPreview(outcome.value);
    });
  }

  function commit() {
    if (!preview) return;
    const { token } = preview;
    void run(async () => {
      const outcome = await window.bengkelin.catalogTransfer.commitImport({
        token,
      });
      if (!check(outcome)) return;
      setPreview(null);
      setResult(outcome.value);
    });
  }

  return (
    <div className="flex min-w-0 max-w-6xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle level={1}>{t('catalogTransfer.title')}</CardTitle>
          <CardDescription>{t('catalogTransfer.description')}</CardDescription>
          <p
            className="text-sm text-muted-foreground"
            data-testid="csv-separator-note"
          >
            {t('catalogTransfer.spreadsheetNote')}
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                saveFile(() =>
                  window.bengkelin.catalogTransfer.downloadTemplate(),
                )
              }
            >
              <FileSpreadsheet aria-hidden="true" />
              {t('catalogTransfer.downloadTemplate')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                saveFile(() => window.bengkelin.catalogTransfer.exportCatalog())
              }
            >
              <Download aria-hidden="true" />
              {t('catalogTransfer.export')}
            </Button>
            <Button disabled={busy} onClick={chooseImport}>
              <Upload aria-hidden="true" />
              {t('catalogTransfer.import')}
            </Button>
          </div>
          <div
            role="status"
            data-testid="catalog-transfer-notice"
            className="flex flex-col gap-1 text-sm text-muted-foreground"
          >
            {busy ? <p>{t('catalogTransfer.working')}</p> : null}
            {notices.map((notice) => (
              <p key={notice}>{notice}</p>
            ))}
            {result ? (
              <p
                data-testid="catalog-import-result"
                className="font-medium text-foreground"
              >
                {t('catalogTransfer.result', { ...numberOptions, ...result })}
              </p>
            ) : null}
          </div>
          {error ? <Alert>{error}</Alert> : null}
        </CardContent>
      </Card>
      {preview ? (
        <ImportPreview
          preview={preview}
          busy={busy}
          onCommit={commit}
          onCancel={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}
