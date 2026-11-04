import { useNumberFormat } from '@/renderer/lib/number-format';
import { ArrowLeft, Ban, Wallet } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import {
  formatDisplayDate,
  formatDisplayDateTime,
} from '@/renderer/lib/date-format';
import { PrintActions } from '@/renderer/features/printing/PrintActions';
import type { PrintClient } from '@/renderer/features/printing/print-client';
import { useAction } from '@/renderer/lib/use-action';
import type { DiscountStageDto, InvoiceView } from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';
import { PaymentDialog } from './PaymentDialog';
import { StatusBadges } from './StatusBadges';
import { VoidDialog } from './VoidDialog';

interface InvoiceDetailProps {
  invoiceId: string;
  timezone: string;
  onBack(): void;
  /** After a payment or void, so lists can refresh. */
  onChanged?(): void;
  /** Printing (default: the bridge). */
  printer?: PrintClient;
}

type Dialog = 'payment' | 'void' | null;

/**
 * Read-only issued invoice (spec 34): everything in InvoiceView, from its
 * snapshots. The only actions are the permitted ones: record a payment,
 * void (only while unpaid), and print, preview, reprint or export the PDF.
 */
export function InvoiceDetail({
  invoiceId,
  timezone,
  onBack,
  onChanged,
  printer,
}: InvoiceDetailProps) {
  const { numberOptions, formatIdr, formatPercent, formatNumber } =
    useNumberFormat();
  const { t } = useTranslation();
  const [invoice, setInvoice] = useState<InvoiceView | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const load = useAction();
  const { run, check } = load;
  const voidNoteId = useId();
  const paymentNoteId = useId();

  const reload = useCallback(
    () =>
      run(async () => {
        const result = await window.bengkelin.invoices.get({ invoiceId });
        if (check(result)) setInvoice(result.value);
      }),
    [run, check, invoiceId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // Focus the heading once, when the invoice first appears.
  const shownId = invoice?.id;
  useEffect(() => {
    if (shownId) heading.current?.focus();
  }, [shownId]);

  const time = (instant: Instant) =>
    formatDisplayDateTime(instant, timezone).slice(0, 16);
  const stages = (list: DiscountStageDto[]) =>
    list
      .map((s) =>
        t('history.detail.stage', {
          percent: formatPercent(s.percentageBps),
          amount: formatIdr(s.amount),
        }),
      )
      .join(' → ');

  if (!invoice) {
    return (
      <div className="flex flex-col gap-3">
        <div>
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
            {t('history.detail.back')}
          </Button>
        </div>
        {load.error ? (
          <Alert>{load.error}</Alert>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('history.detail.loading')}
          </p>
        )}
      </div>
    );
  }

  const isVoid = invoice.status === 'VOID';
  const hasPayments = BigInt(invoice.paidAmount) > 0n;
  const isPaid = BigInt(invoice.outstandingAmount) <= 0n;
  const canPay = !isVoid && !isPaid;
  const canVoid = !isVoid && !hasPayments;
  const none = t('history.detail.none');

  function updated(view: InvoiceView, message: string) {
    setInvoice(view);
    setDialog(null);
    setNotice(message);
    onChanged?.();
  }

  const fields: [string, string][] = [
    [t('history.detail.taxInvoiceNumber'), invoice.taxInvoiceNumber ?? none],
    [t('history.detail.invoiceDate'), formatDisplayDate(invoice.invoiceDate)],
    [t('history.detail.topDays'), formatNumber(invoice.topDays)],
    [t('history.detail.dueDate'), formatDisplayDate(invoice.dueDate)],
    [t('history.detail.finalizedAt'), time(invoice.finalizedAt)],
    [t('history.detail.cashier'), invoice.cashier.displayName],
    [t('history.detail.createdBy'), invoice.createdBy.displayName],
    [t('history.detail.channel'), invoice.channel.label],
    [
      t('references.entities.stockLocation'),
      `${invoice.stockLocation.code} · ${invoice.stockLocation.label}`,
    ],
    ...(invoice.sales
      ? [
          [t('references.entities.sales'), invoice.sales.name] as [
            string,
            string,
          ],
        ]
      : []),
    ...(invoice.expedition
      ? [
          [t('references.entities.expedition'), invoice.expedition.name] as [
            string,
            string,
          ],
        ]
      : []),
    [t('history.detail.customer'), invoice.customer?.name ?? none],
    [t('history.detail.phone'), invoice.customer?.phoneNumber ?? none],
    [t('history.detail.plate'), invoice.vehicle?.plateNumber ?? none],
    [t('history.detail.vehicle'), invoice.vehicle?.description ?? none],
    [
      t('history.detail.odometer'),
      invoice.odometerKm === null
        ? none
        : t('history.detail.odometerValue', {
            ...numberOptions,
            km: invoice.odometerKm,
          }),
    ],
    [t('history.detail.note'), invoice.note ?? none],
    [t('history.detail.shop'), invoice.shop.name],
  ];

  return (
    <article
      className="flex min-w-0 flex-col gap-6"
      data-testid="invoice-detail"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {t('history.detail.back')}
        </Button>
        <h1
          ref={heading}
          tabIndex={-1}
          className="wrap-anywhere font-mono text-xl font-semibold leading-tight tracking-tight outline-none"
        >
          {t('history.detail.title', { number: invoice.invoiceNumber })}
        </h1>
        <StatusBadges
          status={invoice.status}
          paymentStatus={invoice.paymentStatus}
        />
      </div>

      {isVoid && invoice.void ? (
        <section
          data-testid="void-marking"
          aria-label={t('history.detail.voidTitle')}
          className="rounded-md border-2 border-destructive px-4 py-3 text-sm"
        >
          <p className="text-base font-semibold text-destructive">
            {t('history.detail.voidTitle')}
          </p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">
              {t('history.detail.voidReason')}
            </dt>
            <dd data-testid="void-reason">{invoice.void.reason}</dd>
            <dt className="text-muted-foreground">
              {t('history.detail.voidedBy')}
            </dt>
            <dd>{invoice.void.voidedBy.displayName}</dd>
            <dt className="text-muted-foreground">
              {t('history.detail.voidedAt')}
            </dt>
            <dd>{time(invoice.void.voidedAt)}</dd>
          </dl>
        </section>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="rounded-md border border-primary/50 px-3 py-2 text-sm"
        >
          {notice}
        </p>
      ) : null}

      <section aria-label={t('history.detail.actions')}>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => setDialog('payment')}
            disabled={!canPay}
            aria-describedby={canPay ? undefined : paymentNoteId}
          >
            <Wallet aria-hidden="true" />
            {t('history.detail.recordPayment')}
          </Button>
          <Button
            variant="destructive-outline"
            onClick={() => setDialog('void')}
            disabled={!canVoid}
            aria-describedby={canVoid ? undefined : voidNoteId}
          >
            <Ban aria-hidden="true" />
            {t('history.detail.void')}
          </Button>
        </div>
        <div className="mt-2">
          {/* Reprints use the same actions; VOID invoices print marked VOID. */}
          <PrintActions
            invoiceId={invoice.id}
            size="sm"
            {...(printer ? { client: printer } : {})}
          />
        </div>
        <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
          {!canPay ? (
            <p id={paymentNoteId}>
              {isVoid
                ? t('history.detail.paymentBlockedVoid')
                : t('history.detail.paymentBlockedPaid')}
            </p>
          ) : null}
          {!canVoid ? (
            <p id={voidNoteId} data-testid="void-blocked">
              {isVoid
                ? t('history.detail.voidBlockedVoid')
                : t('history.detail.voidBlockedPaid')}
            </p>
          ) : null}
          <p>{t('history.detail.readOnly')}</p>
        </div>
      </section>

      <section aria-label={t('history.detail.header')}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {fields.map(([label, text]) => (
            <div key={label} className="flex gap-2">
              <dt className="min-w-32 text-muted-foreground">{label}</dt>
              <dd className="break-words">{text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">
          {t('history.detail.lines')}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="px-2 py-2">
                  {t('history.detail.position')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('history.detail.item')}
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  {t('history.detail.quantity')}
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  {t('history.detail.unitPrice')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('history.detail.discounts')}
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  {t('history.detail.lineAmount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line, index) => (
                <tr key={line.id} className="border-t border-border align-top">
                  <td className="px-2 py-2">{index + 1}</td>
                  <td className="px-2 py-2">
                    {line.title}
                    {line.mechanicName ? (
                      <span className="block text-xs text-muted-foreground">
                        {t('history.detail.mechanic')}: {line.mechanicName}
                      </span>
                    ) : null}
                    {line.manualPriceOverride ? (
                      <span className="block text-xs text-muted-foreground">
                        {t('history.detail.manualPrice')}
                        {line.listedUnitPrice
                          ? ` · ${t('history.detail.listedPrice', { price: formatIdr(line.listedUnitPrice) })}`
                          : ''}
                      </span>
                    ) : null}
                  </td>
                  <td className="tabular px-2 py-2 text-right whitespace-nowrap">
                    {formatNumber(line.quantity)} {line.unitLabel ?? ''}
                  </td>
                  <td className="px-2 py-2 text-right tabular whitespace-nowrap">
                    {formatIdr(line.unitPrice)}
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {line.discounts.length > 0 ? stages(line.discounts) : ''}
                  </td>
                  <td className="px-2 py-2 text-right tabular whitespace-nowrap">
                    {formatIdr(line.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-1 text-sm sm:max-w-md">
        {invoice.invoiceDiscounts.length > 0 ? (
          <p>
            <span className="text-muted-foreground">
              {t('history.detail.invoiceDiscounts')}:{' '}
            </span>
            {stages(invoice.invoiceDiscounts)}
          </p>
        ) : null}
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          <dt>{t('history.detail.itemsTotal')}</dt>
          <dd className="text-right tabular">
            {formatIdr(invoice.totals.subtotal)}
          </dd>
          <dt>{t('history.detail.itemDiscounts')}</dt>
          <dd className="text-right tabular">
            {formatIdr(invoice.totals.itemDiscountAmount)}
          </dd>
          <dt>{t('history.detail.invoiceDiscountTotal')}</dt>
          <dd className="text-right tabular">
            {formatIdr(invoice.totals.invoiceDiscountAmount)}
          </dd>
          <dt>{t('history.detail.subtotal')}</dt>
          <dd className="text-right tabular" data-testid="detail-tax-subtotal">
            {formatIdr(invoice.totals.taxSubtotal)}
          </dd>
          <dt>
            {t('history.detail.vat')} {invoice.totals.vatRateBps / 100}%
          </dt>
          <dd className="text-right tabular" data-testid="detail-vat">
            {formatIdr(invoice.totals.vatAmount)}
          </dd>
          <dt className="font-semibold">{t('history.detail.total')}</dt>
          <dd
            className="text-right tabular font-semibold"
            data-testid="detail-total"
          >
            {formatIdr(invoice.totals.amount)}
          </dd>
          <dt>{t('history.detail.paid')}</dt>
          <dd className="text-right tabular" data-testid="detail-paid">
            {formatIdr(invoice.paidAmount)}
          </dd>
          <dt>{t('history.detail.outstanding')}</dt>
          <dd className="text-right tabular" data-testid="detail-outstanding">
            {formatIdr(invoice.outstandingAmount)}
          </dd>
        </dl>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">
          {t('history.detail.payments')}
        </h2>
        {invoice.payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('history.detail.noPayments')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th scope="col" className="px-2 py-2">
                    {t('history.detail.paidAt')}
                  </th>
                  <th scope="col" className="px-2 py-2">
                    {t('history.detail.method')}
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    {t('history.detail.amount')}
                  </th>
                  <th scope="col" className="px-2 py-2">
                    {t('history.detail.reference')}
                  </th>
                  <th scope="col" className="px-2 py-2">
                    {t('history.detail.receivedBy')}
                  </th>
                  <th scope="col" className="px-2 py-2">
                    {t('history.detail.source')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoice.payments.map((payment) => (
                  <tr
                    key={payment.id}
                    data-testid="payment-row"
                    className="border-t border-border align-top"
                  >
                    <td className="px-2 py-2 whitespace-nowrap">
                      {time(payment.paidAt)}
                    </td>
                    <td className="px-2 py-2">
                      {t(`workspace.paymentMethod.${payment.method}`)}
                    </td>
                    <td className="px-2 py-2 text-right tabular whitespace-nowrap">
                      {formatIdr(payment.amount)}
                    </td>
                    <td className="px-2 py-2">
                      {payment.reference ?? ''}
                      {payment.note ? (
                        <span className="block text-xs text-muted-foreground">
                          {payment.note}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">
                      {payment.receivedBy.displayName}
                    </td>
                    <td className="px-2 py-2">
                      {t(`history.detail.sources.${payment.source}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dialog === 'payment' ? (
        <PaymentDialog
          invoice={invoice}
          onClose={() => setDialog(null)}
          onRecorded={(view) => {
            const newest = view.payments[view.payments.length - 1];
            updated(
              view,
              t('history.detail.paymentRecorded', {
                amount: newest ? formatIdr(newest.amount) : '',
              }),
            );
          }}
        />
      ) : null}
      {dialog === 'void' ? (
        <VoidDialog
          invoice={invoice}
          onClose={() => setDialog(null)}
          onVoided={(view) =>
            updated(
              view,
              t('history.detail.voided', { number: view.invoiceNumber }),
            )
          }
        />
      ) : null}
    </article>
  );
}
