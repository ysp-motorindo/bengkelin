import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { Alert } from '@/renderer/components/ui/alert';
import { useNumberFormat } from '@/renderer/lib/number-format';
import {
  formatDisplayDate,
  formatDisplayDateTime,
} from '@/renderer/lib/date-format';
import type { PurchaseView, ReferenceDto } from '@/shared/contracts';
import { PurchaseAction, type PurchaseActionKind } from './PurchaseAction';
export function PurchaseDetail({
  purchase,
  locations,
  timezone,
  onChange,
  onBack,
  onReload,
}: {
  purchase: PurchaseView;
  locations: ReferenceDto[];
  timezone: string;
  onChange: (p: PurchaseView) => void;
  onBack: () => void;
  onReload: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const [action, setAction] = useState<{
    kind: PurchaseActionKind;
    receiptId?: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const p = purchase;
  const money = p.outgoingPayments
    .reduce((sum, r) => sum + BigInt(r.amount), 0n)
    .toString();
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button variant="ghost" onClick={onBack}>
            {t('purchases.back')}
          </Button>
          <h2 className="mt-2 text-xl font-semibold">{p.documentNumber}</h2>
          <p className="text-muted-foreground">
            {p.supplier?.name} · {formatDisplayDate(p.billDate)}
          </p>
          <p className="mt-1 text-sm">{p.supplierBillReference}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {[p.status, p.settlementStatus, p.receivingStatus].map((s) => (
            <span key={s} className="rounded-md border px-3 py-1 text-sm">
              {t(`purchases.status.${s}`)}
            </span>
          ))}
        </div>
      </div>
      {notice ? (
        <p
          role="status"
          className="rounded-md border border-success/40 bg-success/5 p-3"
        >
          {notice}
        </p>
      ) : null}
      {p.void ? (
        <Alert>
          {p.void.reason} · {formatDisplayDateTime(p.void.at, timezone)}
        </Alert>
      ) : null}
      <dl className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['total', p.totals!.amount],
          ['paid', money],
          ['outstanding', p.outstandingAmount],
          ['refundDue', p.refundDue],
        ].map(([key, value]) => (
          <div key={key}>
            <dt className="text-sm text-muted-foreground">
              {t(`purchases.${key}`)}
            </dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">
              {formatIdr(value!)}
            </dd>
          </div>
        ))}
      </dl>
      {p.status === 'FINALIZED' ? (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => setAction({ kind: 'receive' })}
            disabled={p.receivingStatus === 'COMPLETE'}
          >
            {t('purchases.receive')}
          </Button>
          <Button
            variant="outline"
            onClick={() => setAction({ kind: 'credit' })}
            disabled={p.lines.every((l) => l.creditedQuantity === l.quantity)}
          >
            {t('purchases.credit')}
          </Button>
          <Button
            variant="outline"
            onClick={() => setAction({ kind: 'recordPayment' })}
            disabled={p.outstandingAmount === '0'}
          >
            {t('purchases.recordPayment')}
          </Button>
          <Button
            variant="outline"
            onClick={() => setAction({ kind: 'recordRefund' })}
            disabled={p.refundDue === '0'}
          >
            {t('purchases.recordRefund')}
          </Button>
          {!p.outgoingPayments.length &&
          p.receipts.every((r) => r.reversedAt) ? (
            <Button
              variant="outline"
              onClick={() => setAction({ kind: 'void' })}
            >
              {t('purchases.void')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[720px] text-sm">
          <caption className="sr-only">{t('purchases.item')}</caption>
          <thead className="bg-muted/40">
            <tr>
              {[
                'item',
                'billed',
                'unitPrice',
                'received',
                'credited',
                'remaining',
                'lineAmount',
              ].map((k) => (
                <th key={k} className="p-3 text-left">
                  {t(`purchases.${k}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l) => (
              <tr key={l.id} className="border-t">
                <td className="p-3 font-medium">
                  {l.title}
                  <p className="text-xs font-normal text-muted-foreground">
                    {l.unitLabel}
                  </p>
                </td>
                <td className="p-3 tabular-nums">{l.quantity}</td>
                <td className="p-3 tabular-nums">{formatIdr(l.unitPrice!)}</td>
                <td className="p-3 tabular-nums">{l.receivedQuantity}</td>
                <td className="p-3 tabular-nums">{l.creditedQuantity}</td>
                <td className="p-3 tabular-nums">{l.remainingQuantity}</td>
                <td className="p-3 tabular-nums">{formatIdr(l.amount!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="space-y-3 rounded-md border bg-card p-4">
          <h3 className="font-semibold">{t('purchases.receipts')}</h3>
          {p.receipts.map((r) => (
            <article key={r.id} className="space-y-2 border-t pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {r.documentNumber} · {r.locationLabel}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDisplayDateTime(r.createdAt, timezone)} ·{' '}
                    {r.cashierName}
                  </p>
                </div>
                {r.reversedAt ? (
                  <span>{t('purchases.reversed')}</span>
                ) : p.status === 'FINALIZED' &&
                  r.lines.every((l) => l.creditedQuantity === 0) ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setAction({ kind: 'reverseReceipt', receiptId: r.id })
                    }
                  >
                    {t('purchases.reverseReceipt')}
                  </Button>
                ) : null}
              </div>
              {r.lines.map((l) => (
                <p key={l.id} className="text-sm">
                  {p.lines.find((x) => x.id === l.purchaseLineId)?.title}:{' '}
                  {l.quantity}
                </p>
              ))}
              {r.note ? <p className="text-sm">{r.note}</p> : null}
            </article>
          ))}
        </section>
        <section className="space-y-3 rounded-md border bg-card p-4">
          <h3 className="font-semibold">{t('purchases.credits')}</h3>
          {p.credits.map((c) => (
            <article key={c.id} className="space-y-1 border-t pt-3">
              <p className="font-medium">
                {c.documentNumber} · {formatIdr(c.amount)}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDisplayDateTime(c.createdAt, timezone)} · {c.cashierName}
              </p>
              <p className="text-sm">{c.reason}</p>
              {c.lines.map((l, i) => (
                <p key={i} className="text-sm">
                  {p.lines.find((x) => x.id === l.purchaseLineId)?.title}:{' '}
                  {l.quantity} ·{' '}
                  {l.receiptItemId
                    ? t('purchases.received')
                    : t('purchases.undelivered')}
                </p>
              ))}
            </article>
          ))}
        </section>
        {(['outgoingPayments', 'refunds'] as const).map((kind) => (
          <section key={kind} className="rounded-md border bg-card p-4">
            <h3 className="mb-3 font-semibold">
              {t(
                kind === 'refunds'
                  ? 'purchases.recordRefund'
                  : 'purchases.outgoingPayments',
              )}
            </h3>
            {p[kind].map((m) => (
              <div
                key={m.id}
                className="flex flex-wrap justify-between gap-2 border-t py-3 text-sm"
              >
                <div>
                  <p>
                    {t(`workspace.paymentMethod.${m.method}`)} · {m.reference}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDisplayDateTime(m.createdAt, timezone)} ·{' '}
                    {m.cashierName}
                  </p>
                  {m.note ? <p>{m.note}</p> : null}
                </div>
                <strong className="tabular-nums">{formatIdr(m.amount)}</strong>
              </div>
            ))}
          </section>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {t('purchases.dueDate')}: {formatDisplayDate(p.dueDate)} ·{' '}
        {t('purchases.vatAmount')}: {formatIdr(p.totals!.vatAmount)}
      </p>
      {p.note ? <p className="text-sm">{p.note}</p> : null}
      {action ? (
        <PurchaseAction
          purchase={p}
          kind={action.kind}
          {...(action.receiptId ? { receiptId: action.receiptId } : {})}
          locations={locations}
          onClose={() => setAction(null)}
          onReload={onReload}
          onSaved={(value) => {
            onChange(value);
            setAction(null);
            setNotice(t('purchases.actionSaved'));
          }}
        />
      ) : null}
    </section>
  );
}
