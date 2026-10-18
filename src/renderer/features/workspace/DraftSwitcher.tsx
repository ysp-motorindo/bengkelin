import { useNumberFormat } from '@/renderer/lib/number-format';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PencilLine, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button, IconButton } from '@/renderer/components/ui/button';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { formatDisplayDateTime } from '@/renderer/lib/date-format';
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
        <DialogActions
          secondary={
            <Button variant="outline" onClick={onClose}>
              <X aria-hidden="true" />
              {t('workspace.common.close')}
            </Button>
          }
        />
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
                <th scope="col" className="px-2 py-2">
                  {t('workspace.drafts.customer')}
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  {t('workspace.drafts.amount')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('workspace.drafts.createdBy')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('workspace.drafts.lastEditedBy')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('workspace.drafts.updatedAt')}
                </th>
                <th scope="col" className="px-2 py-2">
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
                    <td className="px-2 py-2">
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
                    <td className="tabular px-2 py-2 text-right">
                      {formatIdr(draft.amount)}
                    </td>
                    <td className="px-2 py-2">{draft.createdBy.displayName}</td>
                    <td className="px-2 py-2">
                      {draft.lastEditedBy.displayName}
                    </td>
                    <td className="tabular px-2 py-2">
                      {formatDisplayDateTime(draft.updatedAt, timezone).slice(
                        0,
                        16,
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right">
                      <IconButton
                        type="button"
                        label={`${t('workspace.drafts.resume')}: ${customer}`}
                        disabled={busy || current}
                        onClick={() => void onResume(draft.id)}
                      >
                        <PencilLine aria-hidden="true" className="size-4" />
                      </IconButton>
                      <IconButton
                        destructive
                        type="button"
                        label={`${t('workspace.drafts.discard')}: ${customer}`}
                        disabled={busy}
                        onClick={() => setConfirming(draft)}
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                      </IconButton>
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
            <DialogActions
              secondary={
                <Button
                  ref={cancelRef}
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirming(null)}
                >
                  <X aria-hidden="true" />
                  {t('workspace.common.cancel')}
                </Button>
              }
            >
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => void discard(confirming)}
              >
                <Trash2 aria-hidden="true" />
                {t('workspace.drafts.confirmDiscard')}
              </Button>
            </DialogActions>
          }
        >
          {null}
        </Dialog>
      ) : null}
    </Dialog>
  );
}
