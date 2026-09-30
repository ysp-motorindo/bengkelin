import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog } from '@/renderer/components/ui/dialog';
import { customerLabel } from '@/renderer/features/customers/labels';
import { formatIdr } from '@/renderer/lib/money';
import type { DraftView } from '@/shared/contracts';

/**
 * T10 hook: finalization receives the flushed, acknowledged view (use its
 * `version` as expectedVersion). Resolve to close the review; throw or
 * return an error message to keep it open and show the message.
 */
export type FinalizeHandler = (view: DraftView) => Promise<string | null>;

interface CheckoutReviewDialogProps {
  view: DraftView;
  /** Absent until T10 wires finalization: the button is shown disabled. */
  onFinalize?: FinalizeHandler | undefined;
  onClose(): void;
}

/**
 * "Review checkout" (F8 in T17): a read-only summary of what finalization
 * will commit. Opened only after pending draft input is flushed.
 */
export function CheckoutReviewDialog({
  view,
  onFinalize,
  onClose,
}: CheckoutReviewDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { totals } = view;
  const credit = BigInt(totals.unallocatedAmount) > 0n;

  async function finalize() {
    if (!onFinalize || busy) return;
    setBusy(true);
    setError(null);
    try {
      const failure = await onFinalize(view);
      if (failure) setError(failure);
    } catch {
      setError(t('errors.INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={t('workspace.review.title')}
      onClose={onClose}
      closeLabel={t('workspace.common.close')}
      className="max-w-xl"
    >
      {error ? <Alert>{error}</Alert> : null}
      <dl className="tabular grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">
          {t('workspace.header.channel')}
        </dt>
        <dd>{view.channelLabel}</dd>
        <dt className="text-muted-foreground">
          {t('workspace.header.invoiceDate')}
        </dt>
        <dd>{view.invoiceDate}</dd>
        <dt className="text-muted-foreground">
          {t('workspace.review.customer')}
        </dt>
        <dd>
          {view.customer
            ? customerLabel(t, view.customer)
            : t('workspace.header.anonymous')}
          {view.vehicle ? ` · ${view.vehicle.plateNumber}` : ''}
        </dd>
        <dt className="text-muted-foreground">{t('workspace.review.lines')}</dt>
        <dd>{view.lines.length}</dd>
        <dt className="text-muted-foreground">
          {t('workspace.checkout.subtotal')}
        </dt>
        <dd>{formatIdr(totals.subtotal)}</dd>
        <dt className="text-muted-foreground">
          {t('workspace.review.discounts')}
        </dt>
        <dd>-{formatIdr(totals.discountAmount)}</dd>
        <dt className="font-semibold">{t('workspace.checkout.total')}</dt>
        <dd className="text-lg font-semibold" data-testid="review-total">
          {formatIdr(totals.amount)}
        </dd>
      </dl>

      <section aria-label={t('workspace.checkout.payments')}>
        <h3 className="text-sm font-medium">
          {t('workspace.checkout.payments')}
        </h3>
        {view.checkoutAllocations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('workspace.review.noPayments')}
          </p>
        ) : (
          <ul className="tabular text-sm">
            {view.checkoutAllocations.map((allocation) => (
              <li key={allocation.sequence}>
                {t(`workspace.paymentMethod.${allocation.method}`)}:{' '}
                {formatIdr(allocation.amount)}
                {allocation.reference ? ` (${allocation.reference})` : ''}
              </li>
            ))}
          </ul>
        )}
        {credit ? (
          <p className="mt-1 text-sm">
            {t('workspace.review.credit', {
              amount: formatIdr(totals.unallocatedAmount),
              date: view.dueDate,
            })}
          </p>
        ) : null}
      </section>

      {view.allocationsExceedAmount ? (
        <Alert>{t('workspace.checkout.exceeds')}</Alert>
      ) : null}
      {view.lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('workspace.review.empty')}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          disabled={!onFinalize || busy || view.lines.length === 0}
          onClick={() => void finalize()}
        >
          <CheckCircle2 aria-hidden="true" />
          {t('workspace.review.finalize')}
        </Button>
        <Button variant="outline" onClick={onClose}>
          {t('workspace.review.back')}
        </Button>
        {!onFinalize ? (
          <p className="text-xs text-muted-foreground">
            {t('workspace.review.finalizeUnavailable')}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
