import { Check, X } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog } from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { parseRupiahInput } from '@/renderer/lib/money';

interface ManualPriceDialogProps {
  /** Item title (or the scanned code when the title is unknown). */
  itemLabel: string;
  /** Resolves to an error message, or null when the line was added. */
  onSubmit(unitPrice: string, reason: string): Promise<string | null>;
  onClose(): void;
  returnFocus(): void;
}

/**
 * PRICE_REQUIRED: no price is configured for this item at the draft's
 * channel and pricing time. The cashier enters one; main records it as an
 * audited MISSING_PRICE_ENTRY.
 */
export function ManualPriceDialog({
  itemLabel,
  onSubmit,
  onClose,
  returnFocus,
}: ManualPriceDialogProps) {
  const { t } = useTranslation();
  const priceRef = useRef<HTMLInputElement>(null);
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const parsed = parseRupiahInput(price);
    if (parsed === null) {
      setFieldError('workspace.validation.money');
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    try {
      const failure = await onSubmit(parsed, reason.trim());
      if (failure) setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={t('workspace.manualPrice.title')}
      description={t('workspace.manualPrice.description', {
        item: itemLabel,
      })}
      onClose={onClose}
      initialFocus={priceRef}
      returnFocus={returnFocus}
      closeLabel={t('workspace.common.close')}
      footer={
        <div className="flex justify-between">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            <X aria-hidden="true" />
            {t('workspace.common.cancel')}
          </Button>
          <Button type="submit" form="manual-price-form" disabled={busy}>
            <Check aria-hidden="true" />
            {t('workspace.manualPrice.submit')}
          </Button>
        </div>
      }
    >
      <form
        id="manual-price-form"
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-3"
      >
        {error ? <Alert>{error}</Alert> : null}
        <FormField label={t('workspace.manualPrice.price')} error={fieldError}>
          <NumericInput
            ref={priceRef}
            autoComplete="off"
            className="tabular"
            value={price}
            onValueChange={setPrice}
          />
        </FormField>
        <FormField label={t('workspace.manualPrice.reason')}>
          <Input
            autoComplete="off"
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </FormField>
      </form>
    </Dialog>
  );
}
