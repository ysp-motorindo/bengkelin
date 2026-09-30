import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog } from '@/renderer/components/ui/dialog';
import { errorMessage } from '@/renderer/lib/errors';
import { formatIdr } from '@/renderer/lib/money';
import { watchSessionError } from '@/renderer/lib/session-events';
import type { PriceRefreshPreviewDto } from '@/shared/contracts';
import type { DraftCommands } from './use-draft-commands';

interface RepricingDialogProps {
  commands: DraftCommands;
  timezoneLabel: string;
  onClose(): void;
}

const STALE_CODES = ['DRAFT_PRICE_REFRESH_STALE', 'DRAFT_VERSION_CONFLICT'];

/**
 * Reviewed repricing (Part A "Draft repricing"): preview what the draft's
 * current channel and pricingAt resolve to, let the cashier pick lines, then
 * apply exactly those proposals. A stale preview is re-previewed, never
 * applied.
 */
export function RepricingDialog({
  commands,
  timezoneLabel,
  onClose,
}: RepricingDialogProps) {
  const { t } = useTranslation();
  const { view, send, flush } = commands;
  const [preview, setPreview] = useState<PriceRefreshPreviewDto | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      await flush();
      const result = await window.bengkelin.drafts.previewPriceRefresh({
        invoiceId: view.id,
      });
      if (!result.ok) {
        watchSessionError(result.error);
        setError(errorMessage(t, result.error));
        return;
      }
      setPreview(result.value);
      setSelected(
        new Set(
          result.value.proposals
            .filter((p) => !p.manualPriceOverride)
            .map((p) => p.lineId),
        ),
      );
    } catch {
      setError(t('errors.INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  }, [flush, t, view.id]);

  useEffect(() => {
    void load();
    // Once on open; re-previews are explicit.
  }, []);

  async function apply() {
    if (!preview || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await send(
        {
          kind: 'applyPriceRefresh',
          lines: preview.proposals
            .filter((p) => selected.has(p.lineId))
            .map((p) => ({
              lineId: p.lineId,
              resolvedPriceId: p.resolvedPriceId,
              proposedUnitPrice: p.proposedUnitPrice,
            })),
        },
        { expectedVersion: preview.version },
      );
      if (result.ok) {
        onClose();
        return;
      }
      if (STALE_CODES.includes(result.error.code)) {
        setNotice(t('workspace.repricing.stale'));
        await load();
        return;
      }
      setError(errorMessage(t, result.error));
    } finally {
      setBusy(false);
    }
  }

  const proposals = preview?.proposals ?? [];
  return (
    <Dialog
      title={t('workspace.repricing.title')}
      description={t('workspace.repricing.description', {
        channel: view.channelLabel,
        time: timezoneLabel,
      })}
      onClose={onClose}
      closeLabel={t('workspace.common.close')}
      className="max-w-2xl"
    >
      {notice ? (
        <p role="status" className="text-sm text-warning">
          {notice}
        </p>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      {preview && proposals.length === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="repricing-none"
        >
          {t('workspace.repricing.none')}
        </p>
      ) : null}
      {proposals.length > 0 ? (
        <div className="relative overflow-x-auto">
          <table className="tabular w-full text-sm">
            <caption className="sr-only">
              {t('workspace.repricing.title')}
            </caption>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 pr-2">
                  <span className="sr-only">
                    {t('workspace.repricing.select')}
                  </span>
                </th>
                <th scope="col" className="py-1 pr-2">
                  {t('workspace.lines.item')}
                </th>
                <th scope="col" className="py-1 pr-2 text-right">
                  {t('workspace.repricing.current')}
                </th>
                <th scope="col" className="py-1 text-right">
                  {t('workspace.repricing.proposed')}
                </th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((proposal) => (
                <tr
                  key={proposal.lineId}
                  data-testid="repricing-row"
                  className="border-t border-border"
                >
                  <td className="py-1.5 pr-2">
                    <input
                      type="checkbox"
                      aria-label={`${t('workspace.repricing.select')}: ${proposal.title}`}
                      checked={selected.has(proposal.lineId)}
                      onChange={(event) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(proposal.lineId);
                          else next.delete(proposal.lineId);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    {proposal.title}
                    {proposal.manualPriceOverride ? (
                      <span className="block text-xs text-muted-foreground">
                        {t('workspace.repricing.overridden')}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    {formatIdr(proposal.currentUnitPrice)}
                  </td>
                  <td className="py-1.5 text-right font-medium">
                    {formatIdr(proposal.proposedUnitPrice)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          disabled={busy || selected.size === 0}
          onClick={() => void apply()}
        >
          {t('workspace.repricing.apply', { count: selected.size })}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          {t('workspace.repricing.refresh')}
        </Button>
        <Button variant="outline" onClick={onClose}>
          {t('workspace.common.close')}
        </Button>
      </div>
    </Dialog>
  );
}
