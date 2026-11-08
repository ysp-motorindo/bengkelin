import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { Alert } from '@/renderer/components/ui/alert';
import { FormField } from '@/renderer/components/form-field';
import { useAction } from '@/renderer/lib/use-action';
import { useNumberFormat } from '@/renderer/lib/number-format';
import {
  PAYMENT_METHODS,
  priceSchema,
  type PurchaseView,
  type PurchaseWarning,
  type ReferenceDto,
  type PurchaseAllocation,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
export type PurchaseActionKind =
  | 'receive'
  | 'credit'
  | 'recordPayment'
  | 'recordRefund'
  | 'void'
  | 'reverseReceipt';
export function PurchaseAction({
  purchase,
  kind,
  receiptId,
  locations,
  onSaved,
  onReload,
  onClose,
}: {
  purchase: PurchaseView;
  kind: PurchaseActionKind;
  receiptId?: string;
  locations: ReferenceDto[];
  onSaved: (p: PurchaseView) => void;
  onReload: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const action = useAction();
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<Record<string, string>>({});
  const [location, setLocation] = useState(locations[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [method, setMethod] = useState<PurchaseAllocation['method']>('CASH');
  const [amount, setAmount] = useState(
    kind === 'recordRefund' ? purchase.refundDue : purchase.outstandingAmount,
  );
  const [accepted, setAccepted] = useState(false);
  const [review, setReview] = useState<{
    warnings: PurchaseWarning[];
    amount: string | null;
    version: number;
    submit: () => Promise<Result<PurchaseView>>;
  } | null>(null);
  const title = t(
    'purchases.' +
      (kind === 'reverseReceipt'
        ? 'reverseReceipt'
        : kind === 'recordPayment'
          ? 'recordPayment'
          : kind === 'recordRefund'
            ? 'recordRefund'
            : kind),
  );
  const money = kind === 'recordPayment' || kind === 'recordRefund';
  const quantitative = kind === 'receive' || kind === 'credit';
  const availability = (line: PurchaseView['lines'][number]) => {
    const source = sources[line.id];
    if (kind === 'receive' || !source) return line.remainingQuantity;
    for (const r of purchase.receipts) {
      const item = r.lines.find((x) => x.id === source);
      if (item && !r.reversedAt) return item.quantity - item.creditedQuantity;
    }
    return 0;
  };
  const lines = purchase.lines
    .map((l) => ({
      purchaseLineId: l.id,
      receiptItemId: sources[l.id] || null,
      quantity: Number(quantities[l.id] || '0'),
    }))
    .filter((l) => l.quantity > 0);
  const validQuantities = purchase.lines.every(
    (l) =>
      !quantities[l.id] ||
      (/^\d+$/.test(quantities[l.id]!) &&
        Number(quantities[l.id]) <= availability(l) &&
        Number(quantities[l.id]) <= 1000000),
  );
  const bound =
    kind === 'recordRefund' ? purchase.refundDue : purchase.outstandingAmount;
  const valid = quantitative
    ? validQuantities &&
      lines.length > 0 &&
      (kind !== 'receive' || !!location) &&
      (kind !== 'credit' || !!reason.trim())
    : money
      ? priceSchema.safeParse(amount).success &&
        BigInt(amount) > 0n &&
        BigInt(amount) <= BigInt(bound)
      : !!reason.trim();
  const change = (work: () => void) => {
    work();
    setReview(null);
    setAccepted(false);
  };
  async function prepare() {
    void action.run(async () => {
      const base = {
        requestId: crypto.randomUUID(),
        purchaseId: purchase.id,
        expectedVersion: purchase.version,
      };
      let warnings: PurchaseWarning[] = [];
      let total: string | null = null;
      let submit: () => Promise<Result<PurchaseView>>;
      if (kind === 'credit') {
        const p = await window.bengkelin.purchases.previewCredit({
          purchaseId: purchase.id,
          lines,
        });
        if (!action.check(p)) return;
        warnings = p.value.warnings;
        total = p.value.totals.amount;
        base.expectedVersion = p.value.version;
        submit = () =>
          window.bengkelin.purchases.credit({
            ...base,
            lines,
            reason,
            acknowledgedWarnings: warnings,
          });
      } else if (kind === 'reverseReceipt') {
        const p = await window.bengkelin.purchases.previewReceiptReversal({
          purchaseId: purchase.id,
          receiptId: receiptId!,
        });
        if (!action.check(p)) return;
        warnings = p.value.warnings;
        base.expectedVersion = p.value.version;
        submit = () =>
          window.bengkelin.purchases.reverseReceipt({
            ...base,
            receiptId: receiptId!,
            reason,
            acknowledgedWarnings: warnings,
          });
      } else if (kind === 'receive')
        submit = () =>
          window.bengkelin.purchases.receive({
            ...base,
            stockLocationId: location,
            lines: lines.map(({ purchaseLineId, quantity }) => ({
              purchaseLineId,
              quantity,
            })),
            note: note || null,
          });
      else if (kind === 'void')
        submit = () => window.bengkelin.purchases.void({ ...base, reason });
      else {
        total = amount;
        const payload = {
          ...base,
          amount,
          method,
          reference: reference || null,
          note: note || null,
        };
        submit = () =>
          kind === 'recordRefund'
            ? window.bengkelin.purchases.recordRefund(payload)
            : window.bengkelin.purchases.recordPayment(payload);
      }
      setReview({
        warnings,
        amount: total,
        version: base.expectedVersion,
        submit,
      });
      setAccepted(false);
    });
  }
  return (
    <Dialog
      title={title}
      subtitle={purchase.documentNumber + ' · ' + purchase.supplier?.name}
      onClose={() => {
        if (!action.busy) onClose();
      }}
      closeLabel={t('purchases.close')}
      footer={
        <DialogActions
          secondary={
            <Button variant="outline" disabled={action.busy} onClick={onClose}>
              {t('purchases.cancel')}
            </Button>
          }
        >
          {review ? (
            <Button
              disabled={
                action.busy || (review.warnings.length > 0 && !accepted)
              }
              onClick={() =>
                void action.run(async () => {
                  const r = await review.submit();
                  if (action.check(r)) onSaved(r.value);
                  else if (
                    !r.ok &&
                    [
                      'DRAFT_VERSION_CONFLICT',
                      'FINALIZE_WARNINGS_CHANGED',
                    ].includes(r.error.code)
                  ) {
                    setReview(null);
                    await onReload();
                  }
                })
              }
            >
              {t('purchases.confirm')}
            </Button>
          ) : (
            <Button
              disabled={action.busy || !valid}
              onClick={() => void prepare()}
            >
              {t('purchases.reviewAction')}
            </Button>
          )}
        </DialogActions>
      }
    >
      <div className="space-y-4">
        {action.error ? <Alert>{action.error}</Alert> : null}
        <p className="text-sm text-muted-foreground">
          {t(
            'purchases.' +
              {
                receive: 'receiveNotice',
                credit: 'creditNotice',
                recordRefund: 'refundNotice',
                recordPayment: 'outgoingPayments',
                void: 'voidNotice',
                reverseReceipt: 'reverseNotice',
              }[kind],
          )}
        </p>
        <fieldset disabled={action.busy || !!review} className="space-y-4">
          {kind === 'receive' ? (
            <FormField label={t('purchases.location')}>
              <Select
                value={location}
                onChange={(e) => change(() => setLocation(e.target.value))}
              >
                <option value="">{t('purchases.location')}</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}
          {kind === 'receive' && !locations.length ? (
            <Alert>{t('purchases.noLocations')}</Alert>
          ) : null}
          {quantitative ? (
            <div className="space-y-3">
              {purchase.lines
                .filter((l) =>
                  kind === 'credit'
                    ? l.creditedQuantity < l.quantity
                    : l.remainingQuantity > 0,
                )
                .map((l) => (
                  <div
                    key={l.id}
                    className="grid gap-3 rounded-md border p-3 sm:grid-cols-2"
                  >
                    <div>
                      <p className="font-medium">{l.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('purchases.remaining')}: {availability(l)}{' '}
                        {l.unitLabel}
                      </p>
                      {kind === 'credit' ? (
                        <FormField label={t('purchases.creditSource')}>
                          <Select
                            value={sources[l.id] ?? ''}
                            onChange={(e) =>
                              change(() => {
                                setSources((s) => ({
                                  ...s,
                                  [l.id]: e.target.value,
                                }));
                                setQuantities((q) => ({ ...q, [l.id]: '' }));
                              })
                            }
                          >
                            <option value="">
                              {t('purchases.undelivered')} (
                              {l.remainingQuantity})
                            </option>
                            {purchase.receipts
                              .filter((r) => !r.reversedAt)
                              .flatMap((r) =>
                                r.lines
                                  .filter(
                                    (i) =>
                                      i.purchaseLineId === l.id &&
                                      i.quantity > i.creditedQuantity,
                                  )
                                  .map((i) => (
                                    <option key={i.id} value={i.id}>
                                      {r.documentNumber} · {r.locationLabel} (
                                      {i.quantity - i.creditedQuantity})
                                    </option>
                                  )),
                              )}
                          </Select>
                        </FormField>
                      ) : null}
                    </div>
                    <FormField
                      label={t('purchases.quantityLabel', { title: l.title })}
                      error={
                        quantities[l.id] &&
                        (!/^\d+$/.test(quantities[l.id]!) ||
                          Number(quantities[l.id]) > availability(l))
                          ? 'validation.invalid'
                          : undefined
                      }
                    >
                      <NumericInput
                        value={quantities[l.id] ?? ''}
                        onValueChange={(v) =>
                          change(() =>
                            setQuantities((q) => ({ ...q, [l.id]: v })),
                          )
                        }
                      />
                    </FormField>
                  </div>
                ))}
            </div>
          ) : null}
          {money ? (
            <>
              <p>
                {t(
                  kind === 'recordRefund'
                    ? 'purchases.refundDue'
                    : 'purchases.outstanding',
                )}
                : <strong>{formatIdr(bound)}</strong>
              </p>
              <FormField label={t('purchases.amount')}>
                <NumericInput
                  value={amount}
                  onValueChange={(v) => change(() => setAmount(v))}
                />
              </FormField>
              <FormField label={t('purchases.method')}>
                <Select
                  value={method}
                  onChange={(e) =>
                    change(() => setMethod(e.target.value as typeof method))
                  }
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`workspace.paymentMethod.${m}`)}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label={t('purchases.reference')}>
                <Input
                  value={reference}
                  maxLength={100}
                  onChange={(e) => change(() => setReference(e.target.value))}
                />
              </FormField>
            </>
          ) : null}
          {kind === 'credit' || kind === 'void' || kind === 'reverseReceipt' ? (
            <FormField label={t('purchases.reason')}>
              <Input
                value={reason}
                maxLength={500}
                onChange={(e) => change(() => setReason(e.target.value))}
              />
            </FormField>
          ) : (
            <FormField label={t('purchases.note')}>
              <Input
                value={note}
                maxLength={500}
                onChange={(e) => change(() => setNote(e.target.value))}
              />
            </FormField>
          )}
        </fieldset>
        {review ? (
          <div className="space-y-3 rounded-md border p-4">
            <h3 className="font-semibold">{t('purchases.reviewAction')}</h3>
            {review.amount !== null ? (
              <p className="text-lg font-semibold tabular-nums">
                {formatIdr(review.amount)}
              </p>
            ) : null}
            {lines.map((l) => (
              <p key={l.purchaseLineId} className="text-sm">
                {purchase.lines.find((x) => x.id === l.purchaseLineId)?.title}:{' '}
                {l.quantity}
              </p>
            ))}
            {review.warnings.map((w, i) => (
              <Alert key={i}>{t(`purchases.${w.code}`, w.params)}</Alert>
            ))}
            {review.warnings.length ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                {t('purchases.acknowledge')}
              </label>
            ) : null}
            <Button
              variant="outline"
              disabled={action.busy}
              onClick={() => setReview(null)}
            >
              {t('purchases.edit')}
            </Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
