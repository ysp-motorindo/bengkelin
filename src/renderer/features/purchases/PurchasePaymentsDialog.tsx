import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { Alert } from '@/renderer/components/ui/alert';
import { FormField } from '@/renderer/components/form-field';
import { SaveIndicator } from '@/renderer/features/workspace/SaveIndicator';
import { useAction } from '@/renderer/lib/use-action';
import {
  priceSchema,
  PAYMENT_METHODS,
  type PurchaseAllocation,
} from '@/shared/contracts';
import type { PurchaseCommands } from './DraftFields';

export function PurchasePaymentsDialog({
  commands,
  onClose,
}: {
  commands: PurchaseCommands;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const action = useAction();
  const firstAmount = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<PurchaseAllocation[]>(() =>
    commands.view.payments.length
      ? commands.view.payments.map((p) => ({ ...p }))
      : [{ method: 'CASH', amount: '', reference: null, note: null }],
  );
  const [submitted, setSubmitted] = useState(false);
  const close = () => {
    if (!action.busy) onClose();
  };
  const apply = () =>
    void action.run(async () => {
      setSubmitted(true);
      if (
        rows.some(
          (p) =>
            !priceSchema.safeParse(p.amount).success || BigInt(p.amount) <= 0n,
        )
      )
        return;
      const r = await commands.send({ kind: 'setPayments', payments: rows });
      if (action.check(r)) onClose();
    });
  return (
    <Dialog
      title={t('purchases.outgoingPayments')}
      onClose={close}
      initialFocus={firstAmount}
      closeLabel={action.busy ? undefined : t('purchases.close')}
      footer={
        <DialogActions
          secondary={
            <Button variant="outline" disabled={action.busy} onClick={close}>
              {t('purchases.cancel')}
            </Button>
          }
        >
          {action.busy && commands.saveState === 'failed' ? (
            <SaveIndicator
              state={commands.saveState}
              onRetry={commands.retry}
            />
          ) : null}
          <Button disabled={action.busy} onClick={apply}>
            {t(action.busy ? 'common.saving' : 'workspace.checkout.apply')}
          </Button>
        </DialogActions>
      }
    >
      {action.error ? <Alert>{action.error}</Alert> : null}
      <fieldset disabled={action.busy} aria-busy={action.busy}>
        <DraftPayments
          rows={rows}
          change={setRows}
          submitted={submitted}
          firstAmount={firstAmount}
        />
      </fieldset>
    </Dialog>
  );
}

function DraftPayments({
  rows,
  change,
  submitted,
  firstAmount,
}: {
  rows: PurchaseAllocation[];
  change(rows: PurchaseAllocation[]): void;
  submitted: boolean;
  firstAmount: React.RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">
        {t('purchases.outgoingPayments')}
      </legend>
      {rows.map((p, i) => (
        <div
          key={i}
          className="grid grid-cols-2 items-end gap-2 xl:grid-cols-4"
        >
          <FormField label={t('purchases.method')}>
            <Select
              value={p.method}
              onChange={(e) =>
                change(
                  rows.map((r, j) =>
                    j === i
                      ? {
                          ...r,
                          method: e.target
                            .value as PurchaseAllocation['method'],
                        }
                      : r,
                  ),
                )
              }
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`workspace.paymentMethod.${m}`)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label={t('purchases.amount')}
            error={
              !submitted ||
              (priceSchema.safeParse(p.amount).success && BigInt(p.amount) > 0n)
                ? undefined
                : 'validation.invalidMoney'
            }
          >
            <NumericInput
              ref={i === 0 ? firstAmount : undefined}
              value={p.amount}
              onValueChange={(v) =>
                change(rows.map((r, j) => (j === i ? { ...r, amount: v } : r)))
              }
            />
          </FormField>
          <FormField label={t('purchases.reference')}>
            <Input
              value={p.reference ?? ''}
              maxLength={100}
              onChange={(e) =>
                change(
                  rows.map((r, j) =>
                    j === i ? { ...r, reference: e.target.value || null } : r,
                  ),
                )
              }
            />
          </FormField>
          <Button
            variant="outline"
            onClick={() => change(rows.filter((_, j) => j !== i))}
          >
            {t('purchases.remove')}
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        disabled={rows.length >= 10}
        onClick={() =>
          change([
            ...rows,
            { method: 'CASH', amount: '', reference: null, note: null },
          ])
        }
      >
        {t('purchases.addPayment')}
      </Button>
    </fieldset>
  );
}
