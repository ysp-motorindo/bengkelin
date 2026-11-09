import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { Alert } from '@/renderer/components/ui/alert';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { useAction } from '@/renderer/lib/use-action';
import { useSyncedValue } from '@/renderer/features/workspace/synced-field';
import { parseStageTexts } from '@/renderer/features/workspace/discount-inputs';
import { formatBpsAsPercentage } from '@/shared/percentage';
import type { PurchaseCommands } from './DraftFields';

export function PurchaseSummary({
  commands,
  disabled,
  onReview,
  onPayments,
}: {
  commands: PurchaseCommands;
  disabled: boolean;
  onReview(): void;
  onPayments(): void;
}) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const action = useAction();
  const { view } = commands;
  const [disc, setDisc] = useSyncedValue(
    view.discountStages[0] === undefined
      ? ''
      : formatBpsAsPercentage(view.discountStages[0]),
    () => commands.dirty('billDiscount'),
  );
  const [vat, setVat] = useSyncedValue(
    formatBpsAsPercentage(view.vatRateBps),
    () => commands.dirty('vat'),
  );
  const [errors, setErrors] = useState({ disc: false, vat: false });
  const paid = view.payments.reduce((s, p) => s + BigInt(p.amount), 0n);
  function change(kind: 'disc' | 'vat', text: string) {
    (kind === 'disc' ? setDisc : setVat)(text);
    const p = parseStageTexts([text]);
    setErrors((old) => ({ ...old, [kind]: !p.ok }));
    commands.invalid(kind === 'disc' ? 'billDiscount' : 'vat', !p.ok);
    if (p.ok)
      commands.edit(
        kind === 'disc' ? 'billDiscount' : 'vat',
        kind === 'disc'
          ? { kind: 'setDiscounts', lineId: null, stages: p.stages }
          : { kind: 'setVatRate', vatRateBps: p.stages[0] ?? 0 },
      );
  }
  const total = view.totals;
  const money = (value: string | undefined) =>
    value === undefined ? '—' : formatIdr(value);
  const row = (label: string, value: string | undefined, highlight = false) => (
    <tr
      className={
        highlight ? 'bg-amber-50 font-semibold dark:bg-amber-950/40' : ''
      }
    >
      <th scope="row">{label}</th>
      <td>{money(value)}</td>
    </tr>
  );
  const inputClass =
    'h-5 w-20 rounded-none border-0 border-b border-dashed border-input bg-transparent p-0 text-right';
  return (
    <aside
      aria-label={t('workspace.checkout.label')}
      className="min-w-0 bg-card text-sm"
    >
      <table className="w-full border-collapse tabular [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-normal [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:text-right">
        <tbody>
          {row(
            t('workspace.checkout.itemsTotal'),
            total
              ? (
                  BigInt(total.subtotal) - BigInt(total.itemDiscountAmount)
                ).toString()
              : undefined,
          )}
          <tr>
            <th scope="row">{t('workspace.checkout.singleDiscount')}</th>
            <td>
              <div className="flex items-center justify-between gap-2">
                {view.discountStages.length > 1 ? (
                  <span>
                    {view.discountStages
                      .map((d) => formatBpsAsPercentage(d) + '%')
                      .join(' · ')}{' '}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled || action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          action.check(
                            await commands.send({
                              kind: 'setDiscounts',
                              lineId: null,
                              stages: [],
                            }),
                          );
                        })
                      }
                    >
                      {t('workspace.checkout.replaceDiscount')}
                    </Button>
                  </span>
                ) : (
                  <div className="flex items-center gap-1">
                    <NumericInput
                      disabled={disabled}
                      decimal
                      value={disc}
                      onValueChange={(v) => change('disc', v)}
                      aria-label={t('workspace.checkout.singleDiscount')}
                      aria-invalid={errors.disc}
                      aria-describedby="purchase-discount-unit"
                      className={inputClass}
                    />
                    <span id="purchase-discount-unit">%</span>
                  </div>
                )}
                <span>{money(total?.billDiscountAmount)}</span>
              </div>
            </td>
          </tr>
          {row(t('purchases.taxSubtotal'), total?.taxSubtotal)}
          <tr>
            <th scope="row">{t('purchases.vat')}</th>
            <td>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <NumericInput
                    disabled={disabled}
                    decimal
                    value={vat}
                    onValueChange={(v) => change('vat', v)}
                    aria-label={t('purchases.vat')}
                    aria-invalid={errors.vat}
                    aria-describedby="purchase-vat-unit"
                    className={inputClass}
                  />
                  <span id="purchase-vat-unit">%</span>
                </div>
                <span>{money(total?.vatAmount)}</span>
              </div>
            </td>
          </tr>
          {row(t('purchases.total'), total?.amount, true)}
          <tr>
            <th scope="row">{t('purchases.outgoingPayments')}</th>
            <td>
              <button
                type="button"
                disabled={disabled}
                aria-label={t('purchases.outgoingPayments')}
                aria-haspopup="dialog"
                className="h-5 w-full border-b border-dashed border-input bg-transparent text-right focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onPayments}
              >
                {formatIdr(paid.toString())}
              </button>
            </td>
          </tr>
          {row(
            t('purchases.outstanding'),
            total
              ? (BigInt(total.amount) > paid
                  ? BigInt(total.amount) - paid
                  : 0n
                ).toString()
              : undefined,
          )}
        </tbody>
      </table>
      {total && paid > BigInt(total.amount) ? (
        <Alert>{t('errors.PAYMENT_EXCEEDS_AMOUNT')}</Alert>
      ) : null}
      {!total ? <p role="status">{t('purchases.missingPrices')}</p> : null}
      {errors.disc || errors.vat ? (
        <p role="alert">{t('validation.invalid')}</p>
      ) : null}
      {action.error ? <Alert>{action.error}</Alert> : null}
      <Button
        className="mt-2 w-full"
        disabled={
          disabled ||
          !total ||
          !view.supplier ||
          !view.lines.length ||
          commands.saveState === 'failed' ||
          commands.saveState === 'unsaved'
        }
        onClick={onReview}
      >
        {t('purchases.review')}
      </Button>
      <p className="mt-2 text-xs text-muted-foreground">
        {t('purchases.finalizeNotice')}
      </p>
    </aside>
  );
}
