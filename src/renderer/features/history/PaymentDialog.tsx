import { useNumberFormat } from '@/renderer/lib/number-format';
import { Check, X } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { Select } from '@/renderer/components/ui/select';
import { parseRupiahInput } from '@/renderer/lib/money';
import { useAction } from '@/renderer/lib/use-action';
import {
  PAYMENT_METHODS,
  type CustomerOpeningDetail,
  type InvoiceView,
  type PaymentMethod,
  type RecordPaymentInput,
} from '@/shared/contracts';

type PaymentDialogProps = { onClose(): void } & (
  | { invoice: InvoiceView; onRecorded(view: InvoiceView): void }
  | {
      opening: CustomerOpeningDetail;
      onRecorded(view: CustomerOpeningDetail): void;
    }
);

/**
 * Later payment (spec 22). The amount defaults to the outstanding balance.
 * One requestId per submission: a retry of the same payment (for example
 * after a lost response) reuses the exact payload and ID. Until resolved,
 * editing and closing are blocked so recovery cannot become a new payment.
 */
export function PaymentDialog(props: PaymentDialogProps) {
  const { onClose } = props;
  const invoice =
    'opening' in props
      ? {
          id: props.opening.customerId,
          invoiceNumber:
            props.opening.customerName ?? props.opening.externalId ?? '',
          outstandingAmount: props.opening.outstandingAmount,
        }
      : props.invoice;
  const { formatIdr } = useNumberFormat();
  const { t } = useTranslation();
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [amountText, setAmountText] = useState(invoice.outstandingAmount);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [amountError, setAmountError] = useState<string | undefined>();
  const pending = useRef<Omit<RecordPaymentInput, 'invoiceId'> | null>(null);
  const [uncertain, setUncertain] = useState(false);

  const action = useAction();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!pending.current) {
      const amount = parseRupiahInput(amountText);
      if (
        amount === null ||
        BigInt(amount) <= 0n ||
        BigInt(amount) > BigInt(invoice.outstandingAmount)
      ) {
        setAmountError('history.payment.amountInvalid');
        return;
      }
      setAmountError(undefined);
      pending.current = {
        requestId: crypto.randomUUID(),
        method,
        amount,
        reference,
        note,
      };
    }
    const input = pending.current;
    void action.run(async () => {
      try {
        if ('opening' in props) {
          const result =
            await window.bengkelin.customerReceivables.recordPayment({
              ...input,
              customerId: props.opening.customerId,
            });
          if (!result.ok && result.error.code === 'INTERNAL_ERROR')
            setUncertain(true);
          else {
            setUncertain(false);
            pending.current = null;
          }
          if (action.check(result)) props.onRecorded(result.value);
        } else {
          const result = await window.bengkelin.invoices.recordPayment({
            ...input,
            invoiceId: props.invoice.id,
          });
          if (!result.ok && result.error.code === 'INTERNAL_ERROR')
            setUncertain(true);
          else {
            setUncertain(false);
            pending.current = null;
          }
          if (action.check(result)) props.onRecorded(result.value);
        }
      } catch (error) {
        setUncertain(true);
        throw error;
      }
    });
  }

  return (
    <Dialog
      title={t(
        'opening' in props
          ? 'history.opening.paymentTitle'
          : 'history.payment.title',
        { number: invoice.invoiceNumber },
      )}
      description={t('history.payment.outstanding', {
        amount: formatIdr(invoice.outstandingAmount),
      })}
      onClose={() => {
        if (!action.busy && !uncertain) onClose();
      }}
      closeLabel={t('history.payment.cancel')}
      footer={
        <DialogActions
          secondary={
            <Button
              type="button"
              variant="outline"
              disabled={action.busy || uncertain}
              onClick={onClose}
            >
              <X aria-hidden="true" />
              {t('history.payment.cancel')}
            </Button>
          }
        >
          <Button type="submit" form="payment-form" disabled={action.busy}>
            <Check aria-hidden="true" />
            {action.busy
              ? t('history.payment.saving')
              : t('history.payment.submit')}
          </Button>
        </DialogActions>
      }
    >
      <form
        id="payment-form"
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-3"
      >
        <fieldset
          disabled={action.busy || uncertain}
          className="flex flex-col gap-3"
        >
          <FormField label={t('history.payment.method')}>
            <Select
              value={method}
              onChange={(event) =>
                setMethod(event.target.value as PaymentMethod)
              }
            >
              {PAYMENT_METHODS.map((value) => (
                <option key={value} value={value}>
                  {t(`workspace.paymentMethod.${value}`)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label={t('history.payment.amount')}
            error={amountError ?? action.fieldErrors.amount}
          >
            <NumericInput
              autoComplete="off"
              value={amountText}
              onValueChange={setAmountText}
            />
          </FormField>
          <FormField
            label={t('history.payment.reference')}
            error={action.fieldErrors.reference}
          >
            <Input
              autoComplete="off"
              value={reference}
              maxLength={100}
              onChange={(event) => setReference(event.target.value)}
            />
          </FormField>
          <FormField
            label={t('history.payment.note')}
            error={action.fieldErrors.note}
          >
            <Input
              autoComplete="off"
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
            />
          </FormField>
          <p className="text-xs text-muted-foreground">
            {t('history.payment.paidAtNote')}
          </p>
        </fieldset>
        {uncertain && (
          <p role="status" className="text-sm">
            {t('history.payment.uncertain')}
          </p>
        )}
        {action.error ? <Alert>{action.error}</Alert> : null}
      </form>
    </Dialog>
  );
}
