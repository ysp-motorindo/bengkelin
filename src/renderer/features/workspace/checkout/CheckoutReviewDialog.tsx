import { formatDisplayDate } from '@/renderer/lib/date-format';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { AlertTriangle, CheckCircle2, FilePlus2, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { customerLabel } from '@/renderer/features/customers/labels';
import { PrintActions } from '@/renderer/features/printing/PrintActions';
import {
  bridgePrintClient,
  type PrintClient,
} from '@/renderer/features/printing/print-client';
import { errorMessage } from '@/renderer/lib/errors';
import { watchSessionError } from '@/renderer/lib/session-events';
import type {
  DraftView,
  FinalizePreviewDto,
  FinalizeWarning,
  InvoiceView,
} from '@/shared/contracts';
import type { FinalizeClient } from './finalize-client';
import { trackFinalize } from './finalize-pending';
import { formatDueDate } from '../format-due-date';

interface CheckoutReviewDialogProps {
  /** The flushed, acknowledged draft view. */
  view: DraftView;
  finalizer: FinalizeClient;
  /** Printing of the finalized invoice (default: the bridge). */
  printer?: PrintClient;
  onClose(): void;
  /** After a successful finalization: leave the draft for a new one. */
  onNewTransaction(): void;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; preview: FinalizePreviewDto }
  | { kind: 'done'; invoice: InvoiceView };

/** Codes after which the review must be shown again and re-acknowledged. */
const REVIEW_AGAIN = new Set([
  'FINALIZE_WARNINGS_CHANGED',
  'DRAFT_VERSION_CONFLICT',
]);

/**
 * "Review checkout" (F8 in T17) and finalization (spec 26, 52). The ONLY way
 * to finalize: it previews in main (read-only), shows blocking errors and
 * warnings (negative stock needs an explicit acknowledgement), and sends
 * exactly the warnings it showed. If they changed meanwhile, it previews
 * again and asks again. On success it shows the invoice number, the print
 * actions (auto-print when enabled, only once the result is received) and
 * New Transaction.
 */
export function CheckoutReviewDialog({
  view,
  finalizer,
  printer = bridgePrintClient,
  onClose,
  onNewTransaction,
}: CheckoutReviewDialogProps) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pricesAcknowledged, setPricesAcknowledged] = useState(false);
  const [stockAcknowledged, setStockAcknowledged] = useState(false);
  /** One requestId per submission of the same payload, reused on retry. */
  const submission = useRef<{ key: string; requestId: string } | null>(null);
  const newTransactionRef = useRef<HTMLButtonElement>(null);

  const loadPreview = useCallback(async () => {
    try {
      const result = await finalizer.previewFinalize({ invoiceId: view.id });
      if (!result.ok) {
        watchSessionError(result.error);
        setPhase({ kind: 'failed', message: errorMessage(t, result.error) });
        return;
      }
      setStockAcknowledged(false);
      setPricesAcknowledged(false);
      setPhase({ kind: 'ready', preview: result.value });
    } catch {
      setPhase({ kind: 'failed', message: t('errors.INTERNAL_ERROR') });
    }
  }, [finalizer, t, view.id]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  async function finalize(preview: FinalizePreviewDto) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const payload = {
      invoiceId: preview.invoiceId,
      expectedVersion: preview.draftVersion,
      acknowledgedWarnings: preview.warnings,
    };
    const key = JSON.stringify(payload);
    if (submission.current?.key !== key) {
      submission.current = { key, requestId: crypto.randomUUID() };
    }
    try {
      const result = await trackFinalize(
        finalizer.finalize({
          requestId: submission.current.requestId,
          ...payload,
        }),
      );
      if (result.ok) {
        setPhase({ kind: 'done', invoice: result.value });
        return;
      }
      watchSessionError(result.error);
      if (REVIEW_AGAIN.has(result.error.code)) {
        setNotice(t('workspace.finalize.reviewAgain'));
        await loadPreview();
      } else {
        setError(errorMessage(t, result.error));
      }
    } catch {
      // Transport failure: the same requestId is reused on the next attempt.
      setError(t('errors.INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  }

  // ONE dialog for review and result: swapping dialogs would let the closing
  // one restore focus to the opener after the new one took it.
  if (phase.kind === 'done') {
    return (
      <Dialog
        title={t('workspace.finalize.doneTitle')}
        onClose={onNewTransaction}
        // Ctrl+N from the finalized view starts the next transaction.
        allowNewTransaction
        closeLabel={t('workspace.common.close')}
        footer={
          <DialogActions>
            <Button ref={newTransactionRef} onClick={onNewTransaction}>
              <FilePlus2 aria-hidden="true" />
              {t('workspace.finalize.newTransaction')}
            </Button>
          </DialogActions>
        }
      >
        <FinalizedContent
          invoice={phase.invoice}
          printer={printer}
          newTransactionRef={newTransactionRef}
        />
      </Dialog>
    );
  }

  const priceWarning =
    phase.kind === 'ready' && phase.preview.errors.length === 0
      ? phase.preview.warnings.find(
          (warning) =>
            warning.code === 'ZERO_UNIT_PRICE' ||
            warning.code === 'PRICE_DIFFERS_FROM_STORED',
        )
      : undefined;
  const priceLines = new Map<
    string,
    {
      lineId: string;
      title: string;
      quantity: number;
      unitPrice: string;
      storedUnitPrice: string | null;
      zero: boolean;
      differs: boolean;
    }
  >();
  if (phase.kind === 'ready') {
    for (const warning of phase.preview.warnings) {
      if (
        warning.code !== 'ZERO_UNIT_PRICE' &&
        warning.code !== 'PRICE_DIFFERS_FROM_STORED'
      )
        continue;
      for (const line of warning.params.lines) {
        const draftLine = view.lines.find((item) => item.id === line.lineId);
        const entry = priceLines.get(line.lineId) ?? {
          ...line,
          unitPrice: '0',
          storedUnitPrice: draftLine?.pricing.currentListedPrice ?? null,
          zero: false,
          differs: false,
        };
        if (warning.code === 'ZERO_UNIT_PRICE') entry.zero = true;
        if ('storedUnitPrice' in line) {
          entry.storedUnitPrice = line.storedUnitPrice ?? null;
        }
        if ('unitPrice' in line) {
          entry.unitPrice = line.unitPrice;
          entry.differs = true;
        }
        priceLines.set(line.lineId, entry);
      }
    }
  }
  const orderedPriceLines = [...priceLines.values()].sort(
    (a, b) =>
      view.lines.findIndex((l) => l.id === a.lineId) -
      view.lines.findIndex((l) => l.id === b.lineId),
  );
  const confirmingPrices = !!priceWarning && !pricesAcknowledged;

  return (
    <Dialog
      title={t(
        confirmingPrices
          ? 'workspace.review.zeroTitle'
          : 'workspace.review.title',
      )}
      onClose={onClose}
      closeLabel={t('workspace.common.close')}
      footer={
        <DialogActions
          secondary={
            <Button variant="outline" onClick={onClose}>
              <X aria-hidden="true" />
              {t('workspace.review.back')}
            </Button>
          }
        >
          {confirmingPrices ? (
            <Button onClick={() => setPricesAcknowledged(true)}>
              {t('workspace.review.zeroContinue')}
            </Button>
          ) : (
            <Button
              data-testid="finalize-button"
              disabled={
                busy ||
                phase.kind !== 'ready' ||
                phase.preview.errors.length > 0 ||
                (hasNegativeStock(phase.preview.warnings) && !stockAcknowledged)
              }
              onClick={() => {
                if (phase.kind === 'ready') void finalize(phase.preview);
              }}
            >
              <CheckCircle2 aria-hidden="true" />
              {busy
                ? t('workspace.finalize.finalizing')
                : t('workspace.review.finalize')}
            </Button>
          )}
        </DialogActions>
      }
    >
      {notice ? (
        <p
          role="status"
          data-testid="review-notice"
          className="rounded-md border border-warning/50 bg-warning-surface px-3 py-2 text-sm"
        >
          {notice}
        </p>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      {phase.kind === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : null}
      {phase.kind === 'failed' ? <Alert>{phase.message}</Alert> : null}
      {confirmingPrices ? (
        <div>
          <p>{t('workspace.review.zeroDescription')}</p>
          <table className="mt-3 w-full text-left text-sm">
            <thead>
              <tr>
                <th>{t('workspace.lines.item')}</th>
                <th>{t('workspace.review.storedPrice')}</th>
                <th>{t('workspace.lines.unitPrice')}</th>
                <th>{t('workspace.review.priceReason')}</th>
              </tr>
            </thead>
            <tbody>
              {orderedPriceLines.map((line) => (
                <tr key={line.lineId}>
                  <td>
                    <span>{line.title}</span> · {line.quantity}
                  </td>
                  <td>
                    {line.storedUnitPrice === null
                      ? '—'
                      : formatIdr(line.storedUnitPrice)}
                  </td>
                  <td>{formatIdr(line.unitPrice)}</td>
                  <td>
                    {[
                      line.zero ? t('workspace.review.zeroReason') : '',
                      line.differs ? t('workspace.review.differentReason') : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {phase.kind === 'ready' && !confirmingPrices ? (
        <ReviewBody
          view={view}
          preview={phase.preview}
          stockAcknowledged={stockAcknowledged}
          onStockAcknowledged={setStockAcknowledged}
        />
      ) : null}
    </Dialog>
  );
}

function hasNegativeStock(warnings: FinalizeWarning[]): boolean {
  return warnings.some((w) => w.code === 'NEGATIVE_STOCK');
}

function ReviewBody({
  view,
  preview,
  stockAcknowledged,
  onStockAcknowledged,
}: {
  view: DraftView;
  preview: FinalizePreviewDto;
  stockAcknowledged: boolean;
  onStockAcknowledged(value: boolean): void;
}) {
  const { numberOptions, formatNumber, formatIdr } = useNumberFormat();
  const { t, i18n } = useTranslation();
  const { totals } = preview;
  const credit = BigInt(totals.outstandingAmount) > 0n;
  const negative = preview.warnings.filter((w) => w.code === 'NEGATIVE_STOCK');
  const other = preview.warnings.filter(
    (w) =>
      w.code !== 'NEGATIVE_STOCK' &&
      w.code !== 'ZERO_UNIT_PRICE' &&
      w.code !== 'PRICE_DIFFERS_FROM_STORED',
  );

  return (
    <>
      {preview.errors.length > 0 ? (
        <div
          role="alert"
          data-testid="finalize-errors"
          className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive"
        >
          <p className="font-medium">{t('workspace.finalize.errorsTitle')}</p>
          <ul className="list-disc pl-5">
            {preview.errors.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                {/* A finalize-specific text (naming the item) when there is one. */}
                {t(
                  [
                    `workspace.finalize.issues.${issue.code}`,
                    `errors.${issue.code}`,
                  ],
                  { ...numberOptions, ...issue.params },
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {negative.length > 0 ? (
        <div
          role="alert"
          data-testid="negative-stock-warning"
          className="rounded-md border-2 border-warning bg-warning-surface px-3 py-2 text-sm"
        >
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle aria-hidden="true" className="size-4 text-warning" />
            {t('workspace.finalize.negativeStockTitle')}
          </p>
          <ul className="tabular list-disc pl-5">
            {negative.map((w) =>
              w.code === 'NEGATIVE_STOCK' ? (
                <li key={w.params.catalogItemId}>
                  {t('workspace.finalize.negativeStockItem', {
                    ...numberOptions,
                    title: w.params.title,
                    observed: w.params.observedStock,
                    demand: w.params.demand,
                    result: w.params.resultingStock,
                  })}
                </li>
              ) : null,
            )}
          </ul>
          <label className="mt-2 flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={stockAcknowledged}
              onChange={(event) => onStockAcknowledged(event.target.checked)}
            />
            {t('workspace.finalize.acknowledgeNegative')}
          </label>
        </div>
      ) : null}

      {other.length > 0 ? (
        <ul
          data-testid="finalize-warnings"
          className="rounded-md border border-warning/50 bg-warning-surface px-3 py-2 text-sm"
        >
          {other.map((w) => (
            <li key={w.code}>
              {w.code === 'ODOMETER_LOWER_THAN_PREVIOUS'
                ? t('workspace.finalize.odometerLower', {
                    ...numberOptions,
                    previous: w.params.previousOdometer,
                  })
                : t('workspace.finalize.ownerMismatch')}
            </li>
          ))}
        </ul>
      ) : null}

      <dl className="tabular grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">
          {t('workspace.header.channel')}
        </dt>
        <dd>{view.channelLabel}</dd>
        <dt className="text-muted-foreground">
          {t('references.entities.stockLocation')}
        </dt>
        <dd>
          {view.stockLocation.code} · {view.stockLocation.label}
        </dd>
        <dt className="text-muted-foreground">
          {t('workspace.header.invoiceDate')}
        </dt>
        <dd>{formatDisplayDate(view.invoiceDate)}</dd>
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
        <dd>{formatNumber(view.lines.length)}</dd>
        <dt className="text-muted-foreground">
          {t('workspace.checkout.itemsTotal')}
        </dt>
        <dd>{formatIdr(totals.subtotal)}</dd>
        <dt className="text-muted-foreground">
          {t('workspace.review.discounts')}
        </dt>
        <dd>-{formatIdr(totals.discountAmount)}</dd>
        <dt className="text-muted-foreground">
          {t('workspace.checkout.subtotal')}
        </dt>
        <dd data-testid="review-tax-subtotal">
          {formatIdr(totals.taxSubtotal)}
        </dd>
        <dt className="text-muted-foreground">
          {t('workspace.checkout.vat')} {totals.vatRateBps / 100}%
        </dt>
        <dd data-testid="review-vat">{formatIdr(totals.vatAmount)}</dd>
        <dt className="font-semibold">{t('workspace.checkout.total')}</dt>
        <dd className="text-lg font-semibold" data-testid="review-total">
          {formatIdr(totals.amount)}
        </dd>
      </dl>

      <section aria-label={t('workspace.checkout.payments')}>
        <h3 className="text-sm font-medium">
          {t('workspace.checkout.payments')}
        </h3>
        {preview.checkoutPayments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('workspace.review.noPayments')}
          </p>
        ) : (
          <ul className="tabular text-sm" data-testid="review-payments">
            {preview.checkoutPayments.map((payment, index) => (
              <li key={index}>
                {t(`workspace.paymentMethod.${payment.method}`)}:{' '}
                {formatIdr(payment.amount)}
                {payment.reference ? ` (${payment.reference})` : ''}
              </li>
            ))}
          </ul>
        )}
        {credit ? (
          <p className="mt-1 text-sm">
            {t('workspace.review.credit', {
              amount: formatIdr(totals.outstandingAmount),
              date: formatDueDate(view.dueDate, i18n.language),
            })}
          </p>
        ) : null}
        {preview.paymentStatusAfterCheckout ? (
          <p className="mt-1 text-sm">
            {t('workspace.finalize.statusAfter')}{' '}
            <span className="font-semibold" data-testid="review-payment-status">
              {t(
                `workspace.paymentStatus.${preview.paymentStatusAfterCheckout}`,
              )}
            </span>
          </p>
        ) : null}
      </section>
    </>
  );
}

function FinalizedContent({
  invoice,
  printer,
  newTransactionRef,
}: {
  invoice: InvoiceView;
  printer: PrintClient;
  newTransactionRef: RefObject<HTMLButtonElement | null>;
}) {
  const { formatIdr } = useNumberFormat();
  const { t } = useTranslation();
  // The Finalize button that had focus is gone: focus the next action.
  useEffect(() => {
    newTransactionRef.current?.focus();
  }, [newTransactionRef]);
  return (
    <>
      <div className="flex flex-col items-start gap-1" role="status">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
          {t('workspace.finalize.numberLabel')}
        </p>
        <p
          className="tabular text-2xl font-semibold"
          data-testid="finalized-invoice-number"
        >
          {invoice.invoiceNumber}
        </p>
        <p className="tabular text-sm">
          {formatIdr(invoice.totals.amount)} ·{' '}
          <span data-testid="finalized-payment-status">
            {t(`workspace.paymentStatus.${invoice.paymentStatus}`)}
          </span>
        </p>
      </div>
      {/* Mounted only after the finalize result: printing follows commit. */}
      <PrintActions invoiceId={invoice.id} client={printer} autoPrint />
    </>
  );
}
