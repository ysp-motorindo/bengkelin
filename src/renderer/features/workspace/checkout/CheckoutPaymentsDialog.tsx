import { Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { Button } from '@/renderer/components/ui/button';
import { Select } from '@/renderer/components/ui/select';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { errorMessage } from '@/renderer/lib/errors';
import { parseRupiahInput } from '@/renderer/lib/money';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { calculateCheckoutPayments } from '@/shared/checkout-payments';
import {
  MAX_CHECKOUT_ALLOCATIONS,
  PAYMENT_METHODS,
  type CheckoutAllocationDto,
  type PaymentMethod,
} from '@/shared/contracts';
import type { DraftCommands } from '../use-draft-commands';

const emptyCash = (): CheckoutAllocationDto => ({
  sequence: 1,
  method: 'CASH',
  amount: '',
  reference: null,
  note: null,
});

export function CheckoutPaymentsDialog({
  commands,
  onClose,
}: {
  commands: DraftCommands;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const firstAmount = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState(() =>
    commands.view.checkoutTenders.length
      ? commands.view.checkoutTenders.map((row) => ({ ...row }))
      : [emptyCash()],
  );
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = rows.map((row) => parseRupiahInput(row.amount));
  const invalid = parsed.some(
    (amount) => amount === null || BigInt(amount) <= 0n,
  );
  let summary = null;
  let overflow = false;
  try {
    summary = calculateCheckoutPayments(
      commands.view.totals.amount,
      rows.flatMap((row, index) => {
        const amount = parsed[index];
        return amount && BigInt(amount) > 0n ? [{ ...row, amount }] : [];
      }),
    ).summary;
  } catch {
    overflow = true;
  }
  function change(index: number, changes: Partial<CheckoutAllocationDto>) {
    setRows((previous) =>
      previous.map((row, i) => (i === index ? { ...row, ...changes } : row)),
    );
    setError(null);
  }
  async function apply() {
    if (saving) return;
    setSubmitted(true);
    if (invalid || overflow) return;
    setSaving(true);
    setError(null);
    try {
      const result = await commands.send({
        kind: 'setCheckoutAllocations',
        allocations: rows.map((row, index) => ({
          method: row.method,
          amount: parsed[index]!,
          reference: row.reference,
          note: row.note,
        })),
      });
      if (result.ok) onClose();
      else setError(errorMessage(t, result.error));
    } catch {
      setError(t('errors.INTERNAL_ERROR'));
    } finally {
      setSaving(false);
    }
  }
  const close = () => {
    if (!saving) onClose();
  };
  return (
    <Dialog
      title={t('workspace.checkout.payments')}
      onClose={close}
      initialFocus={firstAmount}
      closeLabel={saving ? undefined : t('workspace.common.close')}
      footer={
        <DialogActions
          secondary={
            <Button variant="outline" onClick={close} disabled={saving}>
              {t('workspace.common.cancel')}
            </Button>
          }
        >
          {saving && commands.saveState === 'failed' ? (
            <Button onClick={commands.retry}>
              {t('workspace.save.retry')}
            </Button>
          ) : null}
          <Button onClick={() => void apply()} disabled={saving}>
            {t(saving ? 'common.saving' : 'workspace.checkout.apply')}
          </Button>
        </DialogActions>
      }
    >
      <div className="flex flex-col gap-3" aria-busy={saving}>
        {rows.map((row, index) => (
          <div
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-2"
            data-testid="payment-row"
          >
            <FormField label={`${t('workspace.checkout.method')} ${index + 1}`}>
              <Select
                value={row.method}
                disabled={saving}
                onChange={(event) =>
                  change(index, { method: event.target.value as PaymentMethod })
                }
              >
                {PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {t(`workspace.paymentMethod.${method}`)}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label={`${t('workspace.checkout.amount')} ${index + 1}`}
              error={
                submitted &&
                (parsed[index] === null || BigInt(parsed[index]!) <= 0n)
                  ? 'workspace.validation.positiveMoney'
                  : undefined
              }
            >
              <NumericInput
                ref={index === 0 ? firstAmount : undefined}
                value={row.amount}
                disabled={saving}
                onValueChange={(amount) => change(index, { amount })}
              />
            </FormField>
            <Button
              variant="ghost"
              className="mt-[26px]"
              disabled={saving}
              aria-label={`${t('workspace.checkout.removePayment')} ${index + 1}`}
              onClick={() => {
                setRows((previous) => previous.filter((_, i) => i !== index));
                setError(null);
              }}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          className="self-start"
          disabled={saving || rows.length >= MAX_CHECKOUT_ALLOCATIONS}
          onClick={() => {
            setRows((previous) => [...previous, emptyCash()]);
            setError(null);
          }}
        >
          <Plus aria-hidden="true" />
          {t('workspace.checkout.addPayment')}
        </Button>
        {submitted && invalid ? (
          <p
            id="payment-amount-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {t('workspace.validation.positiveMoney')}
          </p>
        ) : null}
        {overflow ? (
          <p role="alert" className="text-sm text-destructive">
            {t('errors.MONEY_OVERFLOW')}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {summary && BigInt(summary.nonCashExcess) > 0n ? (
          <p role="alert" className="text-sm text-destructive">
            {t('errors.NON_CASH_PAYMENT_EXCEEDS_AMOUNT', {
              excessAmount: summary.nonCashExcess,
            })}
          </p>
        ) : null}
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 border-t border-border pt-3 text-sm tabular">
          <dt>{t('workspace.checkout.total')}</dt>
          <dd>{formatIdr(commands.view.totals.amount)}</dd>
          <dt>{t('workspace.checkout.received')}</dt>
          <dd data-testid="payments-received">
            {summary ? formatIdr(summary.receivedAmount) : '—'}
          </dd>
          <dt>{t('workspace.checkout.change')}</dt>
          <dd data-testid="payments-change">
            {summary?.changeAmount !== null &&
            summary?.changeAmount !== undefined
              ? formatIdr(summary.changeAmount)
              : '—'}
          </dd>
        </dl>
      </div>
    </Dialog>
  );
}
