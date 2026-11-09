import { useNumberFormat } from '@/renderer/lib/number-format';
import { FileUp, Upload, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { useAction } from '@/renderer/lib/use-action';
import { errorMessage } from '@/renderer/lib/errors';
import type {
  SupplierImportReadyDto,
  SupplierImportSummaryDto,
} from '@/shared/contracts';
export function SupplierImportDialog({
  onClose,
  onImported,
}: {
  onClose(): void;
  onImported(): void;
}) {
  const { numberOptions, formatNumber, formatIdr } = useNumberFormat();
  const { t } = useTranslation();
  const { busy, error, run, check } = useAction();
  const [preview, setPreview] = useState<SupplierImportReadyDto | null>(null);
  const [summary, setSummary] = useState<SupplierImportSummaryDto | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  function choose() {
    void run(async () => {
      setPreview(null);
      setSummary(null);
      setAcknowledged(false);
      const result = await window.bengkelin.supplierTransfer.previewImport();
      if (check(result) && result.value.outcome === 'READY')
        setPreview(result.value);
    });
  }
  function commit() {
    if (!preview) return;
    void run(async () => {
      const result = await window.bengkelin.supplierTransfer.commitImport({
        token: preview.token,
        ...(acknowledged ? { acknowledgeDuplicatePhones: true } : {}),
      });
      if (check(result)) {
        setPreview(null);
        setSummary(result.value);
        onImported();
      }
    });
  }
  return (
    <Dialog
      title={t('purchases.supplierImport.title')}
      onClose={() => {
        if (!busy) onClose();
      }}
      closeLabel={t('purchases.cancel')}
      footer={
        <DialogActions
          secondary={
            <Button variant="outline" disabled={busy} onClick={onClose}>
              <X aria-hidden="true" />
              {t('purchases.cancel')}
            </Button>
          }
        >
          <Button variant="outline" disabled={busy} onClick={choose}>
            <FileUp aria-hidden="true" />
            {t('purchases.supplierImport.choose')}
          </Button>
          {preview ? (
            <Button
              disabled={
                busy ||
                !preview.canCommit ||
                (preview.requiresDuplicatePhoneAcknowledgement && !acknowledged)
              }
              onClick={commit}
            >
              <Upload aria-hidden="true" />
              {t('catalogTransfer.preview.commit')}
            </Button>
          ) : null}
        </DialogActions>
      }
    >
      {error ? <Alert>{error}</Alert> : null}
      <p>{t('purchases.supplierImport.description')}</p>
      {preview ? (
        <section
          data-testid="supplier-import-preview"
          className="flex flex-col gap-3"
        >
          <p>
            {preview.fileName} ·{' '}
            {t('purchases.supplierImport.total', {
              ...numberOptions,
              count: preview.totalRows,
            })}
          </p>
          <dl className="flex flex-wrap gap-6">
            {(['creates', 'updates', 'unchanged'] as const).map((key) => (
              <div key={key}>
                <dt>{t(`purchases.supplierImport.${key}`)}</dt>
                <dd>{formatNumber(preview.summary.suppliers[key])}</dd>
              </div>
            ))}
          </dl>
          <p>
            {t('purchases.opening.original')}:{' '}
            {formatIdr(preview.totalOpeningAmount)}
          </p>
          <p>
            {t('catalogTransfer.preview.errors', {
              ...numberOptions,
              count: preview.errorCount,
            })}{' '}
            ·{' '}
            {t('catalogTransfer.preview.warnings', {
              ...numberOptions,
              count: preview.warningCount,
            })}
          </p>
          {[...preview.errors, ...preview.warnings].length ? (
            <ul className="max-h-48 overflow-auto text-sm">
              {[...preview.errors, ...preview.warnings].map((issue, index) => (
                <li key={index}>
                  {issue.row ?? '—'} · {issue.externalId} · {issue.column} ·{' '}
                  {errorMessage(t, issue.error)}
                </li>
              ))}
            </ul>
          ) : null}
          {preview.errorCount > preview.errors.length ||
          preview.warningCount > preview.warnings.length ? (
            <p>{t('purchases.supplierImport.truncated')}</p>
          ) : null}
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>{t('purchases.supplierImport.externalId')}</th>
                  <th>{t('purchases.name')}</th>
                  <th>{t('purchases.supplierImport.action')}</th>
                  <th>{t('purchases.opening.asOfDate')}</th>
                  <th>{t('purchases.opening.original')}</th>
                  <th>{t('purchases.opening.action')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.row}>
                    <td>{row.externalId}</td>
                    <td>{row.name}</td>
                    <td>{t(`catalogTransfer.action.${row.action}`)}</td>
                    <td>{row.asOfDate ?? '—'}</td>
                    <td>
                      {row.openingBalance === null
                        ? '—'
                        : formatIdr(row.openingBalance)}
                    </td>
                    <td>
                      {t(`purchases.opening.actions.${row.openingAction}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rowsTruncated ? (
            <p>{t('purchases.supplierImport.truncated')}</p>
          ) : null}
          {preview.requiresDuplicatePhoneAcknowledgement ? (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              {t('purchases.supplierImport.acknowledge')}
            </label>
          ) : null}
          <p>{t('catalogTransfer.preview.backupNote')}</p>
        </section>
      ) : null}
      {summary ? (
        <div role="status" data-testid="supplier-import-result">
          <p>
            {t('purchases.supplierImport.done', {
              ...numberOptions,
              count: summary.suppliers.creates + summary.suppliers.updates,
            })}
          </p>
          <p>{summary.backupFileName}</p>
          <p>
            {t('purchases.opening.original')}:{' '}
            {formatIdr(summary.totalOpeningAmount)}
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}
