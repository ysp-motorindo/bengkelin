import { formatDisplayDate } from '@/renderer/lib/date-format';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { cn } from '@/renderer/lib/utils';
import type { InvoicePage, InvoiceSummaryDto } from '@/shared/contracts';
import { StatusBadges } from './StatusBadges';

interface SummaryTableProps {
  rows: InvoiceSummaryDto[];
  caption: string;
  /** Shown when there are no rows (default: "no invoices match"). */
  emptyText?: string;
  onOpen(id: string): void;
}

/**
 * Issued invoices as a table (snapshots only). Each row has one "Open"
 * button, so Tab / Shift+Tab walks the rows and Enter opens the invoice.
 */
export function SummaryTable({
  rows,
  caption,
  emptyText,
  onOpen,
}: SummaryTableProps) {
  const { formatIdr } = useNumberFormat();
  const { t } = useTranslation();
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="history-empty">
        {emptyText ?? t('history.table.empty')}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="px-2 py-2">
              {t('history.table.number')}
            </th>
            <th scope="col" className="px-2 py-2">
              {t('history.table.invoiceDate')}
            </th>
            <th scope="col" className="px-2 py-2">
              {t('history.table.dueDate')}
            </th>
            <th scope="col" className="px-2 py-2">
              {t('history.table.customer')}
            </th>
            <th scope="col" className="px-2 py-2">
              {t('history.table.plate')}
            </th>
            <th scope="col" className="px-2 py-2">
              {t('history.table.channel')}
            </th>
            <th scope="col" className="px-2 py-2">
              {t('history.table.cashier')}
            </th>
            <th scope="col" className="px-2 py-2 text-right">
              {t('history.table.amount')}
            </th>
            <th scope="col" className="px-2 py-2 text-right">
              {t('history.table.paid')}
            </th>
            <th scope="col" className="px-2 py-2 text-right">
              {t('history.table.outstanding')}
            </th>
            <th scope="col" className="px-2 py-2">
              {t('history.table.status')}
            </th>
            <th scope="col" className="px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              data-testid="history-row"
              data-status={row.status}
              className={cn(
                'border-t border-border',
                row.status === 'VOID' && 'text-muted-foreground',
              )}
            >
              <td className="px-2 py-2 font-mono whitespace-nowrap">
                <span className={cn(row.status === 'VOID' && 'line-through')}>
                  {row.invoiceNumber}
                </span>
              </td>
              <td className="px-2 py-2 whitespace-nowrap">
                {formatDisplayDate(row.invoiceDate)}
              </td>
              <td className="px-2 py-2 whitespace-nowrap">
                {formatDisplayDate(row.dueDate)}
              </td>
              <td className="px-2 py-2">
                {row.customerName ?? t('history.table.anonymous')}
                {row.customerPhone ? (
                  <span className="block text-xs text-muted-foreground">
                    {row.customerPhone}
                  </span>
                ) : null}
              </td>
              <td className="px-2 py-2 whitespace-nowrap">
                {row.plateNumber ?? ''}
              </td>
              <td className="px-2 py-2">{row.channel.label}</td>
              <td className="px-2 py-2">{row.cashier.displayName}</td>
              <td className="px-2 py-2 text-right tabular whitespace-nowrap">
                {formatIdr(row.amount)}
              </td>
              <td className="px-2 py-2 text-right tabular whitespace-nowrap">
                {formatIdr(row.paidAmount)}
              </td>
              <td className="px-2 py-2 text-right tabular whitespace-nowrap">
                {row.status === 'VOID' ? '—' : formatIdr(row.outstandingAmount)}
              </td>
              <td className="px-2 py-2">
                <StatusBadges
                  status={row.status}
                  paymentStatus={row.paymentStatus}
                />
              </td>
              <td className="px-2 py-2">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t('history.table.openInvoice', {
                    number: row.invoiceNumber,
                  })}
                  onClick={() => onOpen(row.id)}
                >
                  {t('history.table.open')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface PagerProps {
  page: Pick<InvoicePage, 'total' | 'pageSize' | 'pageNumber' | 'hasMore'>;
  busy: boolean;
  onPage(number: number): void;
  summaryKey?: string;
}

export function Pager({
  page,
  busy,
  onPage,
  summaryKey = 'history.pagination.summary',
}: PagerProps) {
  const { numberOptions } = useNumberFormat();
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  return (
    <nav
      aria-label={t('history.pagination.label')}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <Button
        variant="outline"
        size="sm"
        disabled={busy || page.pageNumber <= 1}
        onClick={() => onPage(page.pageNumber - 1)}
      >
        {t('history.pagination.previous')}
      </Button>
      <span data-testid="history-page-summary">
        {t(summaryKey, {
          ...numberOptions,
          page: page.pageNumber,
          pages,
          total: page.total,
        })}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !page.hasMore}
        onClick={() => onPage(page.pageNumber + 1)}
      >
        {t('history.pagination.next')}
      </Button>
    </nav>
  );
}
