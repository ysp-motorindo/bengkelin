import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { parseRupiahInput } from '@/renderer/lib/money';
import { errorMessage } from '@/renderer/lib/errors';
import { parseStageTexts } from '../discount-inputs';
import { useSyncedValue } from '../synced-field';
import type { DraftCommands } from '../use-draft-commands';

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
  const [cash, setCash] = useSyncedValue(view.cashReceived ?? '', () =>
    isDirty('cashPayment'),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const received = parseRupiahInput(cash);
  const total = BigInt(view.totals.amount);
  const difference = received === null ? 0n : BigInt(received) - total;
  const change = difference > 0n ? difference : 0n;
  const legacyDiscount = view.invoiceDiscounts.length > 1;
  const legacyPayment = view.cashReceived === null;
  async function replace(kind: 'discount' | 'payment') {
    const result = await commands.send(
      kind === 'discount'
        ? { kind: 'setInvoiceDiscounts', stages: [] }
        : { kind: 'setCashPayment', amount: view.totals.allocatedAmount },
    );
    if (!result.ok) onError(errorMessage(t, result.error));
  }
  function changeCash(text: string) {
    setCash(text);
    const amount = parseRupiahInput(text);
    setErrors((old) => ({
      ...old,
      cash: amount === null ? 'workspace.validation.money' : '',
    }));
    if (amount === null) markInvalid('cashPayment', true);
    else edit('cashPayment', { kind: 'setCashPayment', amount });
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
  return (
    <aside
      aria-label={t('workspace.checkout.label')}
      className="min-w-0 bg-card text-sm"
    >
      <table className="w-full border-collapse tabular [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-normal [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:text-right">
        <tbody>
          <tr>
            <th scope="row">{t('workspace.checkout.subtotal')}</th>
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
              <div className="flex items-center justify-end gap-2">
                {legacyDiscount ? (
                  <span>
                    {view.invoiceDiscounts
                      .map((stage) => `${stage.percentageBps / 100}%`)
                      .join(' · ')}{' '}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void replace('discount')}
                    >
                      {t('workspace.checkout.replaceDiscount')}
                    </Button>
                  </span>
                ) : (
                  <NumericInput
                    aria-label={t('workspace.checkout.singleDiscount')}
                    decimal
                    value={discount}
                    onValueChange={changeDiscount}
                    aria-invalid={!!errors.discount}
                    className="h-7 w-20 text-right"
                  />
                )}
                <span data-testid="invoice-discount-amount">
                  {formatIdr(view.totals.invoiceDiscountAmount)}
                </span>
              </div>
            </td>
          </tr>
          {view.topDays > 0 && (
            <tr>
              <th scope="row">{t('workspace.checkout.downPayment')}</th>
              <td>{formatIdr(view.totals.allocatedAmount)}</td>
            </tr>
          )}
          <tr className="bg-amber-50 font-semibold dark:bg-amber-950/40">
            <th scope="row">{t('workspace.checkout.total')}</th>
            <td data-testid="total-amount">{formatIdr(view.totals.amount)}</td>
          </tr>
          <tr>
            <th scope="row">
              <label htmlFor="invoice-cash-payment">
                {t('workspace.checkout.payments')}
              </label>
            </th>
            <td>
              {legacyPayment ? (
                <div>
                  {view.checkoutAllocations
                    .map(
                      (allocation) =>
                        `${t(`workspace.paymentMethod.${allocation.method}`)} ${formatIdr(allocation.amount)}`,
                    )
                    .join(' · ')}{' '}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void replace('payment')}
                  >
                    {t('workspace.checkout.replacePayment')}
                  </Button>
                </div>
              ) : (
                <NumericInput
                  id="invoice-cash-payment"
                  className="h-7 text-right"
                  value={cash}
                  onValueChange={changeCash}
                  aria-invalid={!!errors.cash}
                />
              )}
            </td>
          </tr>
          <tr>
            <th scope="row">{t('workspace.checkout.change')}</th>
            <td data-testid="cash-change">{formatIdr(change.toString())}</td>
          </tr>
          {difference < 0n && !legacyPayment && (
            <tr>
              <th scope="row">
                {t(
                  view.topDays > 0
                    ? 'workspace.checkout.unallocated'
                    : 'workspace.checkout.short',
                )}
              </th>
              <td>{formatIdr((-difference).toString())}</td>
            </tr>
          )}
        </tbody>
      </table>
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
