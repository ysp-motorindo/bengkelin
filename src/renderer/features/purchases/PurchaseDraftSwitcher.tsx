import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { Button } from '@/renderer/components/ui/button';
import { Alert } from '@/renderer/components/ui/alert';
import {
  formatDisplayDate,
  formatDisplayDateTime,
} from '@/renderer/lib/date-format';
import { useNumberFormat } from '@/renderer/lib/number-format';
import type { PurchaseDraftView } from '@/shared/contracts';

export function PurchaseDraftSwitcher({
  drafts,
  currentId,
  timezone,
  onResume,
  onDiscard,
  onClose,
}: {
  drafts: PurchaseDraftView[];
  currentId: string | null;
  timezone: string;
  onResume(id: string): Promise<boolean>;
  onDiscard(draft: PurchaseDraftView): Promise<string | null>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const [confirm, setConfirm] = useState<PurchaseDraftView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      title={t('purchases.drafts')}
      onClose={() => {
        if (!busy) onClose();
      }}
      closeLabel={busy ? undefined : t('purchases.close')}
      footer={
        <DialogActions>
          <Button disabled={busy} onClick={onClose}>
            {t('purchases.close')}
          </Button>
        </DialogActions>
      }
    >
      {error ? <Alert>{error}</Alert> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr>
              {[
                'supplier',
                'billReference',
                'billDate',
                'item',
                'total',
                'updatedAt',
              ].map((k) => (
                <th key={k} className="p-2 text-left">
                  {t('purchases.' + k)}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {drafts.map((d) => (
              <tr
                key={d.id}
                aria-current={d.id === currentId ? 'true' : undefined}
                className="border-t"
              >
                <td className="p-2">
                  {d.supplier?.name ?? t('purchases.chooseSupplier')}
                </td>
                <td>{d.supplierBillReference}</td>
                <td>{formatDisplayDate(d.billDate)}</td>
                <td>{d.lines.length}</td>
                <td>{d.totals ? formatIdr(d.totals.amount) : '—'}</td>
                <td>{formatDisplayDateTime(d.updatedAt, timezone)}</td>
                <td className="whitespace-nowrap">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || d.id === currentId}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        if (await onResume(d.id)) onClose();
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {t('workspace.drafts.resume')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={
                      t('purchases.discard') + ' ' + (d.supplier?.name ?? '')
                    }
                    onClick={() => setConfirm(d)}
                  >
                    {t('purchases.discard')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirm ? (
        <Dialog
          title={t('purchases.discard')}
          initialFocus={cancel}
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
          footer={
            <DialogActions
              secondary={
                <Button
                  ref={cancel}
                  disabled={busy}
                  variant="outline"
                  onClick={() => setConfirm(null)}
                >
                  {t('purchases.cancel')}
                </Button>
              }
            >
              <Button
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const e = await onDiscard(confirm);
                    setError(e);
                    if (!e) setConfirm(null);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('purchases.discard')}
              </Button>
            </DialogActions>
          }
        >
          <p>{t('purchases.discardNotice')}</p>
        </Dialog>
      ) : null}
    </Dialog>
  );
}
