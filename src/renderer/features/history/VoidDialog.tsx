import { Ban, X } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { Label } from '@/renderer/components/ui/label';
import { controlClass } from '@/renderer/components/ui/input';
import { useAction } from '@/renderer/lib/use-action';
import { cn } from '@/renderer/lib/utils';
import type { InvoiceView } from '@/shared/contracts';

interface VoidDialogProps {
  invoice: InvoiceView;
  onClose(): void;
  onVoided(view: InvoiceView): void;
}

/**
 * Void confirmation (spec 29): a reason is required and the cashier must
 * confirm, because VOID cannot be undone. One requestId per submission,
 * reused on a retry of the same reason.
 */
export function VoidDialog({ invoice, onClose, onVoided }: VoidDialogProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const pending = useRef<{ reason: string; requestId: string } | null>(null);
  const action = useAction();
  const reasonId = useId();
  const reasonError = action.fieldErrors.reason;

  const ready = reason.trim() !== '' && confirmed;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    const trimmed = reason.trim();
    if (pending.current?.reason !== trimmed) {
      pending.current = { reason: trimmed, requestId: crypto.randomUUID() };
    }
    const requestId = pending.current.requestId;
    void action.run(async () => {
      const result = await window.bengkelin.invoices.void({
        requestId,
        invoiceId: invoice.id,
        reason: trimmed,
      });
      if (action.check(result)) {
        pending.current = null;
        onVoided(result.value);
      }
    });
  }

  return (
    <Dialog
      role="alertdialog"
      title={t('history.void.title', { number: invoice.invoiceNumber })}
      description={t('history.void.description')}
      onClose={onClose}
      closeLabel={t('history.void.cancel')}
      footer={
        <DialogActions
          secondary={
            <Button type="button" variant="outline" onClick={onClose}>
              <X aria-hidden="true" />
              {t('history.void.cancel')}
            </Button>
          }
        >
          <Button
            type="submit"
            form="void-form"
            variant="destructive"
            disabled={!ready || action.busy}
          >
            <Ban aria-hidden="true" />
            {action.busy ? t('history.void.saving') : t('history.void.submit')}
          </Button>
        </DialogActions>
      }
    >
      <form
        id="void-form"
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-3"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={reasonId}>{t('history.void.reason')}</Label>
          <textarea
            id={reasonId}
            required
            rows={3}
            maxLength={500}
            value={reason}
            aria-invalid={reasonError ? true : undefined}
            onChange={(event) => setReason(event.target.value)}
            className={cn(controlClass, 'h-auto min-h-20 py-2')}
          />
          {reasonError ? (
            <p className="text-sm text-destructive">
              {t(reasonError, { defaultValue: t('validation.invalid') })}
            </p>
          ) : null}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {t('history.void.confirm', { number: invoice.invoiceNumber })}
        </label>
        {action.error ? <Alert>{action.error}</Alert> : null}
      </form>
    </Dialog>
  );
}
