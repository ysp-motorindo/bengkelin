import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { Button } from '@/renderer/components/ui/button';
import { Alert } from '@/renderer/components/ui/alert';
import { useAction } from '@/renderer/lib/use-action';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { errorMessage } from '@/renderer/lib/errors';
import type {
  OpeningImportPreview,
  OpeningImportSummary,
} from '@/shared/contracts';
export function OpeningImportDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const action = useAction();
  const [preview, setPreview] = useState<Extract<
    OpeningImportPreview,
    { outcome: 'READY' }
  > | null>(null);
  const [summary, setSummary] = useState<OpeningImportSummary | null>(null);
  function choose() {
    void action.run(async () => {
      setPreview(null);
      setSummary(null);
      const result = await window.bengkelin.customerReceivables.previewImport();
      if (action.check(result) && result.value.outcome === 'READY')
        setPreview(result.value);
    });
  }
  function commit() {
    if (!preview) return;
    void action.run(async () => {
      const result = await window.bengkelin.customerReceivables.commitImport({
        token: preview.token,
      });
      if (action.check(result)) {
        setSummary(result.value);
        setPreview(null);
      }
    });
  }
  return (
    <Dialog
      title={t('history.opening.importTitle')}
      onClose={() => {
        if (!action.busy) onClose();
      }}
      closeLabel={t('customers.edit.cancel')}
      footer={
        <DialogActions
          secondary={
            <Button variant="outline" disabled={action.busy} onClick={onClose}>
              {t('customers.edit.cancel')}
            </Button>
          }
        >
          <Button variant="outline" disabled={action.busy} onClick={choose}>
            {t('customers.import.choose')}
          </Button>
          {preview && (
            <Button
              disabled={action.busy || !preview.canCommit}
              onClick={commit}
            >
              {t('catalogTransfer.preview.commit')}
            </Button>
          )}
        </DialogActions>
      }
    >
      <p>{t('history.opening.importDescription')}</p>
      {action.error && <Alert>{action.error}</Alert>}
      {preview && (
        <section
          className="flex flex-col gap-3"
          data-testid="opening-import-preview"
        >
          <p>
            {preview.fileName} ·{' '}
            {t('customers.import.total', { count: preview.totalRows })}
          </p>
          <p>
            {t('history.opening.creates')}: {preview.summary.creates} ·{' '}
            {t('catalogTransfer.preview.unchanged')}:{' '}
            {preview.summary.unchanged}
          </p>
          <p className="font-semibold">{formatIdr(preview.totalAmount)}</p>
          {preview.errors.length > 0 && (
            <ul className="max-h-48 overflow-auto text-sm">
              {preview.errors.map((issue, i) => (
                <li key={i}>
                  {issue.row ?? '—'} · {issue.externalId} ·{' '}
                  {errorMessage(t, issue.error)}
                </li>
              ))}
            </ul>
          )}
          {preview.errorCount > preview.errors.length && (
            <p>{t('customers.import.truncated')}</p>
          )}
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  {[
                    'externalId',
                    'customer',
                    'asOfDate',
                    'original',
                    'action',
                  ].map((key) => (
                    <th key={key} scope="col" className="px-2 py-2">
                      {t(`history.opening.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.row}>
                    <td className="px-2 py-2">{row.externalId}</td>
                    <td className="px-2 py-2">{row.customerName}</td>
                    <td className="px-2 py-2">{row.asOfDate}</td>
                    <td className="px-2 py-2 tabular-nums">
                      {row.amount === null ? '—' : formatIdr(row.amount)}
                    </td>
                    <td className="px-2 py-2">
                      {t(`catalogTransfer.action.${row.action}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rowsTruncated && <p>{t('customers.import.truncated')}</p>}
        </section>
      )}
      {summary && (
        <section role="status">
          <p>{t('history.opening.imported', { count: summary.creates })}</p>
          <p>{formatIdr(summary.totalAmount)}</p>
          <p>{summary.backupFileName}</p>
        </section>
      )}
    </Dialog>
  );
}
