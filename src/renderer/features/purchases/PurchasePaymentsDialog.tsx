import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { Dialog } from '@/renderer/components/ui/dialog';
import { Alert } from '@/renderer/components/ui/alert';
import { FormField } from '@/renderer/components/form-field';
import { SaveIndicator } from '@/renderer/features/workspace/SaveIndicator';
import { useSyncedValue } from '@/renderer/features/workspace/synced-field';
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
  const close = () =>
    void action.run(async () => {
      if (await commands.flush()) onClose();
      else action.setError(t('workspace.notices.unsaved'));
    });
  return (
    <Dialog
      title={t('purchases.outgoingPayments')}
      onClose={close}
      closeLabel={action.busy ? undefined : t('purchases.close')}
      footer={
        <div className="flex items-center justify-between gap-2">
          <SaveIndicator state={commands.saveState} onRetry={commands.retry} />
          <Button disabled={action.busy} onClick={close}>
            {t(action.busy ? 'common.saving' : 'purchases.close')}
          </Button>
        </div>
      }
    >
      {action.error ? <Alert>{action.error}</Alert> : null}
      <fieldset disabled={action.busy} aria-busy={action.busy}>
        <DraftPayments commands={commands} />
      </fieldset>
    </Dialog>
  );
}

function DraftPayments({ commands }: { commands: PurchaseCommands }) {
  const { t } = useTranslation();
  const key = 'payments';
  const [rows, setRows] = useSyncedValue(
    commands.view.payments,
    () => commands.dirty(key),
    JSON.stringify(commands.view.payments),
  );
  const change = (next: PurchaseAllocation[]) => {
    setRows(next);
    const valid = next.every(
      (p) => priceSchema.safeParse(p.amount).success && BigInt(p.amount) > 0n,
    );
    commands.invalid(key, !valid);
    if (valid) commands.edit(key, { kind: 'setPayments', payments: next });
  };
  useEffect(() => () => commands.invalid(key, false), [commands.invalid]);
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
              priceSchema.safeParse(p.amount).success && BigInt(p.amount) > 0n
                ? undefined
                : 'validation.invalidMoney'
            }
          >
            <NumericInput
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
