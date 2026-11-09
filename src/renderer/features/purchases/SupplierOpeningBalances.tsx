import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { Alert } from '@/renderer/components/ui/alert';
import { useAction } from '@/renderer/lib/use-action';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { formatLocal } from '@/renderer/lib/date-format';
import type {
  SupplierOpeningPage,
  SupplierOpeningDetail,
} from '@/shared/contracts';
import { Pager } from '../history/SummaryTable';
import { SupplierOpeningPaymentDialog } from './SupplierOpeningPaymentDialog';
export function SupplierOpeningBalances({ timezone }: { timezone: string }) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const action = useAction();
  const detailAction = useAction();
  const [page, setPage] = useState<SupplierOpeningPage | null>(null);
  const [detail, setDetail] = useState<SupplierOpeningDetail | null>(null);
  const [pay, setPay] = useState(false);
  const { run, check } = action;
  const load = useCallback(
    (number: number) =>
      run(async () => {
        const result = await window.bengkelin.supplierPayables.list({
          page: { number, size: 25 },
        });
        if (check(result)) setPage(result.value);
      }),
    [run, check],
  );
  useEffect(() => {
    void load(1);
  }, [load]);
  function open(supplierId: string) {
    void detailAction.run(async () => {
      const result = await window.bengkelin.supplierPayables.get({
        supplierId,
      });
      if (detailAction.check(result)) setDetail(result.value);
    });
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t('purchases.opening.description')}
      </p>
      {action.error && <Alert>{action.error}</Alert>}
      {detailAction.error && <Alert>{detailAction.error}</Alert>}
      {detail ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setDetail(null);
                void load(page?.pageNumber ?? 1);
              }}
            >
              {t('history.detail.back')}
            </Button>
            <h2 className="font-semibold">
              {detail.supplierName ?? detail.externalId}
            </h2>
            <Button
              disabled={
                detailAction.busy || BigInt(detail.outstandingAmount) === 0n
              }
              onClick={() => setPay(true)}
            >
              {t('history.detail.recordPayment')}
            </Button>
          </div>
          <dl className="flex flex-wrap gap-6">
            {(
              [
                ['asOfDate', detail.asOfDate],
                ['original', formatIdr(detail.originalAmount)],
                ['paid', formatIdr(detail.paidAmount)],
                ['outstanding', formatIdr(detail.outstandingAmount)],
              ] as const
            ).map(([key, value]) => (
              <div key={key}>
                <dt className="text-sm text-muted-foreground">
                  {t(`purchases.opening.${key}`)}
                </dt>
                <dd className="font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <h3 className="font-semibold">{t('history.detail.payments')}</h3>
          {detail.payments.length === 0 ? (
            <p>{t('history.detail.noPayments')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    {[
                      'paidAt',
                      'method',
                      'amount',
                      'receivedBy',
                      'reference',
                      'note',
                    ].map((key) => (
                      <th key={key} scope="col" className="px-2 py-2">
                        {t(
                          key === 'receivedBy'
                            ? 'purchases.cashier'
                            : `history.detail.${key}`,
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.payments.map((p) => (
                    <tr key={p.id}>
                      <td className="px-2 py-2 whitespace-nowrap">
                        {formatLocal(p.createdAt, timezone)}
                      </td>
                      <td className="px-2 py-2">
                        {t(`workspace.paymentMethod.${p.method}`)}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap tabular-nums">
                        {formatIdr(p.amount)}
                      </td>
                      <td className="px-2 py-2">{p.cashierName}</td>
                      <td className="px-2 py-2">{p.reference ?? '—'}</td>
                      <td className="px-2 py-2">{p.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pay && (
            <SupplierOpeningPaymentDialog
              opening={detail}
              onClose={() => setPay(false)}
              onRecorded={(view: SupplierOpeningDetail) => {
                setDetail(view);
                setPay(false);
                open(view.supplierId);
                void load(page?.pageNumber ?? 1);
              }}
            />
          )}
        </>
      ) : (
        page && (
          <>
            <p className="font-semibold" data-testid="opening-total">
              {t('history.receivables.totalOutstanding', {
                amount: formatIdr(page.totalOutstanding),
              })}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">
                  {t('purchases.opening.title')}
                </caption>
                <thead>
                  <tr>
                    {[
                      'externalId',
                      'supplier',
                      'asOfDate',
                      'original',
                      'paid',
                      'outstanding',
                      'status',
                    ].map((key) => (
                      <th key={key} scope="col" className="px-2 py-2">
                        {t(`purchases.opening.${key}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((row) => (
                    <tr key={row.supplierId}>
                      <td className="px-2 py-2">{row.externalId ?? '—'}</td>
                      <td className="px-2 py-2">
                        <Button
                          variant="ghost"
                          disabled={detailAction.busy}
                          onClick={() => open(row.supplierId)}
                        >
                          {row.supplierName ?? row.externalId ?? '—'}
                        </Button>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        {row.asOfDate}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap tabular-nums">
                        {formatIdr(row.originalAmount)}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap tabular-nums">
                        {formatIdr(row.paidAmount)}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap tabular-nums">
                        {formatIdr(row.outstandingAmount)}
                      </td>
                      <td className="px-2 py-2">
                        {t(`workspace.paymentStatus.${row.paymentStatus}`)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {page.items.length === 0 && (
                <p>{t('history.receivables.empty')}</p>
              )}
            </div>
            <Pager
              summaryKey="purchases.opening.pagination"
              page={page}
              busy={action.busy}
              onPage={(number) => void load(number)}
            />
          </>
        )
      )}
    </div>
  );
}
