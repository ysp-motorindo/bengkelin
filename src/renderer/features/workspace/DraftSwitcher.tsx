import { useNumberFormat } from '@/renderer/lib/number-format';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PencilLine, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog } from '@/renderer/components/ui/dialog';
import { formatLocal } from '@/renderer/features/catalog/local-time';
import { errorMessage } from '@/renderer/lib/errors';
import { watchSessionError } from '@/renderer/lib/session-events';
import type { DraftSummary } from '@/shared/contracts';

interface DraftSwitcherProps {
  currentId: string;
  timezone: string;
  /** Flushes the current draft, then opens this one. */
  onResume(id: string): Promise<void>;
  /** Discards a draft; resolves to an error message or null. */
  onDiscard(summary: DraftSummary): Promise<string | null>;
  onClose(): void;
}

/**
 * Shared shop drafts (spec 28): resume or discard any open draft. Shows the
 * creator, last editor, customer, amount and last update.
 */
export function DraftSwitcher({
  currentId,
  timezone,
  onResume,
  onDiscard,
  onClose,
}: DraftSwitcherProps) {
  const { numberOptions, formatIdr } = useNumberFormat();
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<DraftSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await window.bengkelin.drafts.list();
      if (!result.ok) {
        watchSessionError(result.error);
        setError(errorMessage(t, result.error));
        return;
      }
      setDrafts(result.value);
    } catch {
      setError(t('errors.INTERNAL_ERROR'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function discard(summary: DraftSummary) {
    setBusy(true);
    try {
      const failure = await onDiscard(summary);
      setError(failure);
      setConfirming(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={t('workspace.drafts.title')}
      onClose={onClose}
      closeLabel={t('workspace.common.close')}
      scrollBody
      contentPadding={false}
      footer={
        <div className="flex justify-start">
          <Button variant="outline" onClick={onClose}>
            <X aria-hidden="true" />
            {t('workspace.common.close')}
          </Button>
        </div>
      }
    >
      {error ? <Alert>{error}</Alert> : null}
      {drafts === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="sr-only">{t('workspace.drafts.title')}</caption>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 pr-2">
                  {t('workspace.drafts.customer')}
                </th>
                <th scope="col" className="py-1 pr-2 text-right">
                  {t('workspace.drafts.amount')}
                </th>
                <th scope="col" className="py-1 pr-2">
                  {t('workspace.drafts.createdBy')}
                </th>
                <th scope="col" className="py-1 pr-2">
                  {t('workspace.drafts.lastEditedBy')}
                </th>
                <th scope="col" className="py-1 pr-2">
                  {t('workspace.drafts.updatedAt')}
                </th>
                <th scope="col" className="py-1">
                  <span className="sr-only">
                    {t('workspace.lines.actions')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((draft) => {
                const current = draft.id === currentId;
                const customer =
                  draft.customerLabel ?? t('workspace.header.anonymous');
                return (
                  <tr
                    key={draft.id}
                    data-testid="draft-row"
                    aria-current={current ? 'true' : undefined}
                    className="border-t border-border"
                  >
                    <td className="py-1.5 pr-2">
                      <span className="font-medium">
                        {draft.customerLabel ?? t('workspace.header.anonymous')}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {[
                          draft.plateNumber,
                          draft.channelLabel,
                          t('workspace.drafts.lineCount', {
                            ...numberOptions,
                            count: draft.lineCount,
                          }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        {current ? ` · ${t('workspace.drafts.current')}` : ''}
                      </span>
                    </td>
                    <td className="tabular py-1.5 pr-2 text-right">
                      {formatIdr(draft.amount)}
                    </td>
                    <td className="py-1.5 pr-2">
                      {draft.createdBy.displayName}
                    </td>
                    <td className="py-1.5 pr-2">
                      {draft.lastEditedBy.displayName}
                    </td>
                    <td className="tabular py-1.5 pr-2">
                      {formatLocal(draft.updatedAt, timezone).slice(0, 16)}
                    </td>
                    <td className="whitespace-nowrap py-1 text-right">
                      <button
                        type="button"
                        aria-label={`${t('workspace.drafts.resume')}: ${customer}`}
                        title={t('workspace.drafts.resume')}
                        disabled={busy || current}
                        onClick={() => void onResume(draft.id)}
                        className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                      >
                        <PencilLine aria-hidden="true" className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`${t('workspace.drafts.discard')}: ${customer}`}
                        title={t('workspace.drafts.discard')}
                        disabled={busy}
                        onClick={() => setConfirming(draft)}
                        className="inline-flex size-9 items-center justify-center rounded-md text-destructive hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {drafts.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              {t('workspace.drafts.none')}
            </p>
          ) : null}
        </div>
      )}

      {confirming ? (
        <Dialog
          role="alertdialog"
          title={t('workspace.drafts.confirmTitle')}
          description={t('workspace.drafts.confirmBody', {
            customer:
              confirming.customerLabel ?? t('workspace.header.anonymous'),
            amount: formatIdr(confirming.amount),
          })}
          initialFocus={cancelRef}
          onClose={() => setConfirming(null)}
          footer={
            <div className="flex justify-between">
              <Button
                ref={cancelRef}
                variant="outline"
                disabled={busy}
                onClick={() => setConfirming(null)}
              >
                <X aria-hidden="true" />
                {t('workspace.common.cancel')}
              </Button>
              <Button disabled={busy} onClick={() => void discard(confirming)}>
                <Trash2 aria-hidden="true" />
                {t('workspace.drafts.confirmDiscard')}
              </Button>
            </div>
          }
        >
          {null}
        </Dialog>
      ) : null}
    </Dialog>
  );
}
