import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { Button } from '@/renderer/components/ui/button';
import { Alert } from '@/renderer/components/ui/alert';
import { useAction } from '@/renderer/lib/use-action';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { formatDisplayDate } from '@/renderer/lib/date-format';
import { trackFinalize } from '@/renderer/features/workspace/checkout/finalize-pending';
import { registerWorkspaceActions } from '@/renderer/features/workspace/workspace-actions';
import type { PurchaseFinalizePreview, PurchaseView } from '@/shared/contracts';
import type { PurchaseCommands } from './DraftFields';
import { PurchasePrintActions } from './PurchasePrintActions';

export function PurchaseReviewDialog({
  initial,
  commands,
  active,
  onClose,
  onRecorded,
  onNew,
  onViewBill,
}: {
  initial: PurchaseFinalizePreview;
  commands: PurchaseCommands;
  active: boolean;
  onClose(): void;
  onRecorded(p: PurchaseView): void;
  onNew(): Promise<boolean>;
  onViewBill(p: PurchaseView): void;
}) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const action = useAction();
  const [preview, setPreview] = useState(initial);
  const [accepted, setAccepted] = useState(false);
  const [needsPreview, setNeedsPreview] = useState(false);
  const [recorded, setRecorded] = useState<PurchaseView | null>(null);
  const request = useRef(crypto.randomUUID());
  const [notice, setNotice] = useState<string | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const view = commands.view;
  async function next() {
    await action.run(async () => {
      if (!(await onNew())) action.setError(t('errors.INTERNAL_ERROR'));
    });
  }
  useEffect(() => {
    if (recorded) newButton.current?.focus();
  }, [recorded]);
  useEffect(() => {
    if (!recorded || !active) return;
    return registerWorkspaceActions({
      newTransaction: next,
      focusSearch: () => {},
      addCustomItem: () => {},
      saveDraft: async () => true,
      openCheckoutReview: async () => {},
    });
  }, [recorded, active, onNew]);
  async function refreshPreview() {
    const fresh = await window.bengkelin.purchases.previewFinalize({
      purchaseId: view.id,
    });
    if (action.check(fresh)) {
      setPreview(fresh.value);
      request.current = crypto.randomUUID();
      setNeedsPreview(false);
    }
  }
  async function finalize() {
    await action.run(async () => {
      const r = await trackFinalize(
        window.bengkelin.purchases.finalize({
          requestId: request.current,
          purchaseId: view.id,
          expectedVersion: preview.version,
          acknowledgedWarnings: preview.warnings,
        }),
      );
      if (action.check(r)) {
        setRecorded(r.value);
        onRecorded(r.value);
      } else if (
        !r.ok &&
        ['DRAFT_VERSION_CONFLICT', 'FINALIZE_WARNINGS_CHANGED'].includes(
          r.error.code,
        )
      ) {
        setAccepted(false);
        setNeedsPreview(true);
        setNotice(t('workspace.finalize.reviewAgain'));
        await commands.refresh();
        await refreshPreview();
      }
    });
  }
  const totals = preview.totals;
  const paid = view.payments.reduce((s, p) => s + BigInt(p.amount), 0n);
  const close = () => {
    if (action.busy) return;
    if (recorded) void next();
    else onClose();
  };
  return (
    <Dialog
      title={t(recorded ? 'purchases.recordedTitle' : 'purchases.review')}
      onClose={close}
      closeLabel={action.busy ? undefined : t('purchases.close')}
      allowNewTransaction={!!recorded}
      footer={
        <DialogActions
          secondary={
            recorded ? (
              <Button
                variant="outline"
                disabled={action.busy}
                onClick={() => onViewBill(recorded)}
              >
                {t('purchases.viewBill')}
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={action.busy}
                onClick={onClose}
              >
                {t('workspace.review.back')}
              </Button>
            )
          }
        >
          {recorded ? (
            <Button
              ref={newButton}
              disabled={action.busy}
              onClick={() => void next()}
            >
              {t(action.busy ? 'common.saving' : 'purchases.new')}
            </Button>
          ) : (
            <Button
              disabled={
                action.busy ||
                needsPreview ||
                preview.errors.length > 0 ||
                (preview.warnings.length > 0 && !accepted)
              }
              onClick={() => void finalize()}
            >
              {t(
                action.busy
                  ? 'workspace.finalize.finalizing'
                  : 'purchases.finalize',
              )}
            </Button>
          )}
        </DialogActions>
      }
    >
      {notice ? <p role="status">{notice}</p> : null}
      {needsPreview ? (
        <Button
          disabled={action.busy}
          onClick={() => void action.run(refreshPreview)}
        >
          {t('common.retry')}
        </Button>
      ) : null}
      {action.error ? <Alert>{action.error}</Alert> : null}
      {recorded ? (
        <>
          <div role="status">
            <p className="text-2xl font-semibold tabular-nums">
              {recorded.documentNumber}
            </p>
            <p>
              {recorded.supplier?.name} · {formatIdr(recorded.totals!.amount)}
            </p>
            <p>
              {t(`purchases.status.${recorded.settlementStatus}`)} ·{' '}
              {t(`purchases.status.${recorded.receivingStatus}`)}
            </p>
          </div>
          <PurchasePrintActions
            purchaseId={recorded.id}
            documentId={recorded.id}
            documentType="BILL"
            active={active}
            autoPrint
          />
          <p className="mt-3 text-sm">{t('purchases.finalizeNotice')}</p>
        </>
      ) : (
        <>
          {preview.errors.map((e, i) => (
            <Alert key={i}>{t('errors.' + e.code, e.params)}</Alert>
          ))}
          {preview.warnings.map((w, i) => (
            <Alert key={i}>{t('purchases.' + w.code, w.params)}</Alert>
          ))}
          {preview.warnings.length ? (
            <label className="my-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={accepted}
                disabled={action.busy}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              {t('purchases.acknowledge')}
            </label>
          ) : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm tabular-nums">
            {[
              ['supplier', view.supplier?.name ?? '—'],
              ['billReference', view.supplierBillReference ?? '—'],
              ['billDate', formatDisplayDate(view.billDate)],
              ['topDays', String(view.topDays)],
              ['dueDate', formatDisplayDate(view.dueDate)],
              ['item', String(view.lines.length)],
              ['subtotal', totals ? formatIdr(totals.subtotal) : '—'],
              [
                'discountAmount',
                totals ? formatIdr(totals.discountAmount) : '—',
              ],
              ['taxSubtotal', totals ? formatIdr(totals.taxSubtotal) : '—'],
              [
                'vat',
                formatIdr(totals?.vatAmount ?? '0') +
                  ' (' +
                  view.vatRateBps / 100 +
                  '%)',
              ],
              ['total', totals ? formatIdr(totals.amount) : '—'],
              ['outgoingPayments', formatIdr(paid.toString())],
              [
                'outstanding',
                totals
                  ? formatIdr(
                      (BigInt(totals.amount) > paid
                        ? BigInt(totals.amount) - paid
                        : 0n
                      ).toString(),
                    )
                  : '—',
              ],
            ].map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">
                  {t('purchases.' + key)}
                </dt>
                <dd className={key === 'total' ? 'font-semibold' : ''}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <ul className="mt-3 text-sm">
            {view.payments.map((p, i) => (
              <li key={i}>
                {t(`workspace.paymentMethod.${p.method}`)}:{' '}
                {formatIdr(p.amount)}
                {p.reference ? ' · ' + p.reference : ''}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm">{t('purchases.finalizeNotice')}</p>
        </>
      )}
    </Dialog>
  );
}
