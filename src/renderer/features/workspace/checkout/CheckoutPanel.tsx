import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { errorMessage } from '@/renderer/lib/errors';
import { parseStageTexts } from '../discount-inputs';
import { useSyncedValue } from '../synced-field';
import type { DraftCommands } from '../use-draft-commands';
import { CheckoutPaymentsDialog } from './CheckoutPaymentsDialog';

interface CheckoutPanelProps {
  commands: DraftCommands;
  onReview(): void;
  onError(message: string | null): void;
}

export function CheckoutPanel({
  commands,
  onReview,
  onError,
}: CheckoutPanelProps) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const { view, edit, isDirty, markInvalid } = commands;
  const serverDiscount = view.invoiceDiscounts[0]
    ? String(view.invoiceDiscounts[0].percentageBps / 100)
    : '';
  const [discount, setDiscount] = useSyncedValue(serverDiscount, () =>
    isDirty('invoiceDiscounts'),
  );
  const [vatRate, setVatRate] = useSyncedValue(
    String(view.totals.vatRateBps / 100),
    () => isDirty('vatRate'),
  );
  const [paymentsOpen, setPaymentsOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const difference = BigInt(view.totals.unallocatedAmount);
  const legacyDiscount = view.invoiceDiscounts.length > 1;
  async function replaceDiscount() {
    const result = await commands.send({
      kind: 'setInvoiceDiscounts',
      stages: [],
    });
    if (!result.ok) onError(errorMessage(t, result.error));
  }
  async function openPayments() {
    if (await commands.flush()) setPaymentsOpen(true);
  }
  function changeDiscount(text: string) {
    setDiscount(text);
    const parsed = parseStageTexts([text]);
    setErrors((old) => ({
      ...old,
      discount: parsed.ok ? '' : 'workspace.validation.percentage',
    }));
    if (!parsed.ok) markInvalid('invoiceDiscounts', true);
    else
      edit('invoiceDiscounts', {
        kind: 'setInvoiceDiscounts',
        stages: parsed.stages,
      });
  }
  function changeVatRate(text: string) {
    setVatRate(text);
    const parsed = parseStageTexts([text]);
    setErrors((old) => ({
      ...old,
      vatRate: parsed.ok ? '' : 'workspace.validation.percentage',
    }));
    if (!parsed.ok) markInvalid('vatRate', true);
    else
      edit('vatRate', {
        kind: 'setVatRate',
        vatRateBps: parsed.stages[0] ?? 0,
      });
  }
  return (
    <aside
      aria-label={t('workspace.checkout.label')}
      className="min-w-0 bg-card text-sm"
    >
      <table className="w-full border-collapse tabular [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-normal [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:text-right">
        <tbody>
          <tr>
            <th scope="row">{t('workspace.checkout.itemsTotal')}</th>
            <td data-testid="subtotal-amount">
              {formatIdr(
                (
                  BigInt(view.totals.subtotal) -
                  BigInt(view.totals.itemDiscountAmount)
                ).toString(),
              )}
            </td>
          </tr>
          <tr>
            <th scope="row">{t('workspace.checkout.singleDiscount')}</th>
            <td>
              <div className="flex items-center justify-between gap-2">
                {legacyDiscount ? (
                  <span>
                    {view.invoiceDiscounts
                      .map((stage) => `${stage.percentageBps / 100}%`)
                      .join(' · ')}{' '}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void replaceDiscount()}
                    >
                      {t('workspace.checkout.replaceDiscount')}
                    </Button>
                  </span>
                ) : (
                  <div className="flex items-center gap-1">
                    <NumericInput
                      aria-label={t('workspace.checkout.singleDiscount')}
                      aria-describedby="invoice-discount-unit"
                      decimal
                      value={discount}
                      onValueChange={changeDiscount}
                      aria-invalid={!!errors.discount}
                      className="h-5 w-20 rounded-none border-0 border-b border-dashed border-input bg-transparent p-0 text-right"
                    />
                    <span id="invoice-discount-unit">%</span>
                  </div>
                )}
                <span data-testid="invoice-discount-amount">
                  {formatIdr(view.totals.invoiceDiscountAmount)}
                </span>
              </div>
            </td>
          </tr>
          <tr>
            <th scope="row">{t('workspace.checkout.subtotal')}</th>
            <td data-testid="tax-subtotal-amount">
              {formatIdr(view.totals.taxSubtotal)}
            </td>
          </tr>
          <tr>
            <th scope="row">{t('workspace.checkout.vat')}</th>
            <td>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <NumericInput
                    aria-label={t('workspace.checkout.vat')}
                    aria-describedby="invoice-vat-unit"
                    decimal
                    value={vatRate}
                    onValueChange={changeVatRate}
                    aria-invalid={!!errors.vatRate}
                    className="h-5 w-20 rounded-none border-0 border-b border-dashed border-input bg-transparent p-0 text-right"
                  />
                  <span id="invoice-vat-unit">%</span>
                </div>
                <span data-testid="vat-amount">
                  {formatIdr(view.totals.vatAmount)}
                </span>
              </div>
            </td>
          </tr>
          <tr className="bg-amber-50 font-semibold dark:bg-amber-950/40">
            <th scope="row">{t('workspace.checkout.total')}</th>
            <td data-testid="total-amount">{formatIdr(view.totals.amount)}</td>
          </tr>
          {view.topDays > 0 && (
            <tr>
              <th scope="row">{t('workspace.checkout.downPayment')}</th>
              <td>{formatIdr(view.totals.allocatedAmount)}</td>
            </tr>
          )}
          <tr>
            <th scope="row">{t('workspace.checkout.payments')}</th>
            <td>
              <button
                type="button"
                aria-label={t('workspace.checkout.payments')}
                aria-haspopup="dialog"
                className="h-5 w-full rounded-none border-0 border-b border-dashed border-input bg-transparent p-0 text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void openPayments()}
              >
                {formatIdr(view.paymentSummary.receivedAmount)}
              </button>
            </td>
          </tr>
          <tr>
            <th scope="row">{t('workspace.checkout.change')}</th>
            <td data-testid="cash-change">
              {view.paymentSummary.changeAmount === null
                ? '—'
                : formatIdr(view.paymentSummary.changeAmount)}
            </td>
          </tr>
          {difference > 0n && (
            <tr>
              <th scope="row">
                {t(
                  view.topDays > 0
                    ? 'workspace.checkout.unallocated'
                    : 'workspace.checkout.short',
                )}
              </th>
              <td>{formatIdr(difference.toString())}</td>
            </tr>
          )}
        </tbody>
      </table>
      {BigInt(view.paymentSummary.nonCashExcess) > 0n ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.NON_CASH_PAYMENT_EXCEEDS_AMOUNT', {
            excessAmount: view.paymentSummary.nonCashExcess,
          })}
        </p>
      ) : null}
      {paymentsOpen ? (
        <CheckoutPaymentsDialog
          commands={commands}
          onClose={() => setPaymentsOpen(false)}
        />
      ) : null}
      {Object.entries(errors)
        .filter(([, key]) => key)
        .map(([field, key]) => (
          <p key={field} role="alert" className="text-xs text-destructive">
            {t(key)}
          </p>
        ))}
      <Button className="mt-2 w-full" onClick={onReview}>
        {t('workspace.checkout.review')}
      </Button>
    </aside>
  );
}
