import { Check, X } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog } from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { Select } from '@/renderer/components/ui/select';
import { formatIdr, parseRupiahInput } from '@/renderer/lib/money';
import { useAction } from '@/renderer/lib/use-action';
import {
  PAYMENT_METHODS,
  type InvoiceView,
  type PaymentMethod,
  type RecordPaymentInput,
} from '@/shared/contracts';

interface PaymentDialogProps {
  invoice: InvoiceView;
  onClose(): void;
  onRecorded(view: InvoiceView): void;
}

/** `45.000` (no currency prefix), the editable form of an amount. */
function grouped(amount: string): string {
  return formatIdr(amount).replace(/^Rp /, '');
}

/**
 * Later payment (spec 22). The amount defaults to the outstanding balance.
 * One requestId per submission: a retry of the same payment (for example
 * after a lost response) reuses it, so main records it at most once; any
 * change to the form starts a new submission.
 */
export function PaymentDialog({
  invoice,
  onClose,
  onRecorded,
}: PaymentDialogProps) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [amountText, setAmountText] = useState(
    grouped(invoice.outstandingAmount),
  );
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [amountError, setAmountError] = useState<string | undefined>();
  const pending = useRef<{ key: string; requestId: string } | null>(null);
  const action = useAction();

  function submit(event: FormEvent) {
    event.preventDefault();
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
    const payload = {
      invoiceId: invoice.id,
      method,
      amount,
      reference,
      note,
    };
    const key = JSON.stringify(payload);
    if (pending.current?.key !== key) {
      pending.current = { key, requestId: crypto.randomUUID() };
    }
    const input: RecordPaymentInput = {
      requestId: pending.current.requestId,
      ...payload,
    };
    void action.run(async () => {
      const result = await window.bengkelin.invoices.recordPayment(input);
      if (action.check(result)) {
        pending.current = null;
        onRecorded(result.value);
      }
    });
  }

  return (
    <Dialog
      title={t('history.payment.title', { number: invoice.invoiceNumber })}
      description={t('history.payment.outstanding', {
        amount: formatIdr(invoice.outstandingAmount),
      })}
      onClose={onClose}
      closeLabel={t('history.payment.cancel')}
      footer={
        <div className="flex justify-between">
          <Button type="button" variant="outline" onClick={onClose}>
            <X aria-hidden="true" />
            {t('history.payment.cancel')}
          </Button>
          <Button type="submit" form="payment-form" disabled={action.busy}>
            <Check aria-hidden="true" />
            {action.busy
              ? t('history.payment.saving')
              : t('history.payment.submit')}
          </Button>
        </div>
      }
    >
      <form
        id="payment-form"
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-3"
      >
        <FormField label={t('history.payment.method')}>
          <Select
            value={method}
            onChange={(event) => setMethod(event.target.value as PaymentMethod)}
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
        {action.error ? <Alert>{action.error}</Alert> : null}
      </form>
    </Dialog>
  );
}
