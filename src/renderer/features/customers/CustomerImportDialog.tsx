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
  CustomerImportReadyDto,
  CustomerImportSummaryDto,
} from '@/shared/contracts';
export function CustomerImportDialog({
  onClose,
  onImported,
}: {
  onClose(): void;
  onImported(): void;
}) {
  const { numberOptions, formatNumber } = useNumberFormat();
  const { t } = useTranslation();
  const { busy, error, run, check } = useAction();
  const [preview, setPreview] = useState<CustomerImportReadyDto | null>(null);
  const [summary, setSummary] = useState<CustomerImportSummaryDto | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  function choose() {
    void run(async () => {
      setPreview(null);
      setSummary(null);
      setAcknowledged(false);
      const result = await window.bengkelin.customerTransfer.previewImport();
      if (check(result) && result.value.outcome === 'READY')
        setPreview(result.value);
    });
  }
  function commit() {
    if (!preview) return;
    void run(async () => {
      const result = await window.bengkelin.customerTransfer.commitImport({
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
      title={t('customers.import.title')}
      onClose={() => {
        if (!busy) onClose();
      }}
      closeLabel={t('customers.edit.cancel')}
      footer={
        <DialogActions
          secondary={
            <Button variant="outline" disabled={busy} onClick={onClose}>
              <X aria-hidden="true" />
              {t('customers.edit.cancel')}
            </Button>
          }
        >
          <Button variant="outline" disabled={busy} onClick={choose}>
            <FileUp aria-hidden="true" />
            {t('customers.import.choose')}
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
      <p>{t('customers.import.description')}</p>
      {preview ? (
        <section
          data-testid="customer-import-preview"
          className="flex flex-col gap-3"
        >
          <p>
            {preview.fileName} ·{' '}
            {t('customers.import.total', {
              ...numberOptions,
              count: preview.totalRows,
            })}
          </p>
          <dl className="flex flex-wrap gap-6">
            {(['creates', 'updates', 'unchanged'] as const).map((key) => (
              <div key={key}>
                <dt>{t(`catalogTransfer.preview.${key}`)}</dt>
                <dd>{formatNumber(preview.summary[key])}</dd>
              </div>
            ))}
          </dl>
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
            <p>{t('customers.import.truncated')}</p>
          ) : null}
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>{t('customers.import.externalId')}</th>
                  <th>{t('customers.edit.name')}</th>
                  <th>{t('customers.import.action')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.row}>
                    <td>{row.externalId}</td>
                    <td>{row.name}</td>
                    <td>{t(`catalogTransfer.action.${row.action}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rowsTruncated ? (
            <p>{t('customers.import.truncated')}</p>
          ) : null}
          {preview.requiresDuplicatePhoneAcknowledgement ? (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              {t('customers.import.acknowledge')}
            </label>
          ) : null}
          <p>{t('catalogTransfer.preview.backupNote')}</p>
        </section>
      ) : null}
      {summary ? (
        <div role="status" data-testid="customer-import-result">
          <p>
            {t('customers.import.done', {
              ...numberOptions,
              count: summary.creates + summary.updates,
            })}
          </p>
          <p>{summary.backupFileName}</p>
        </div>
      ) : null}
    </Dialog>
  );
}
