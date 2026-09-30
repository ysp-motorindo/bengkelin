import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatIdr } from '@/renderer/lib/money';
import { cn } from '@/renderer/lib/utils';
import type { DailyReport } from '@/shared/contracts';

/**
 * The daily report DTO as tables. Only formats (BigInt `formatIdr`); every
 * figure comes straight from the DTO, as in the CSV and the printout. Sales,
 * voids and payments stay visibly separate sections.
 */

function Money({ field, value }: { field: string; value: string }) {
  return (
    <span className="whitespace-nowrap tabular-nums" data-field={field}>
      {formatIdr(value)}
    </span>
  );
}

function Count({ field, value }: { field: string; value: number }) {
  return (
    <span className="tabular-nums" data-field={field}>
      {value}
    </span>
  );
}

function Section({
  id,
  title,
  basis,
  children,
}: {
  id: string;
  title: string;
  basis: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
    >
      <div>
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{basis}</p>
      </div>
      {children}
    </section>
  );
}

/** Label / value rows; the last one may be emphasized. */
function Figures({
  caption,
  rows,
}: {
  caption: string;
  rows: { label: string; value: ReactNode; strong?: boolean }[];
}) {
  return (
    <table className="w-full max-w-md text-sm">
      <caption className="sr-only">{caption}</caption>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.label}
            className={cn(row.strong && 'border-t border-border font-semibold')}
          >
            <th scope="row" className="py-1 pr-4 text-left font-normal">
              {row.label}
            </th>
            <td className="py-1 text-right">{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Column {
  label: string;
  right?: boolean;
}

function Table({
  caption,
  columns,
  rows,
  empty,
}: {
  caption: string;
  columns: Column[];
  rows: { key: string; cells: ReactNode[] }[];
  empty: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="mb-1 text-left font-medium">{caption}</caption>
        <thead>
          <tr className="text-muted-foreground">
            {columns.map((c) => (
              <th
                key={c.label}
                scope="col"
                className={cn(
                  'py-1 pr-3',
                  c.right ? 'text-right' : 'text-left',
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="py-1 text-muted-foreground"
              >
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.key} className="border-t border-border">
                {row.cells.map((cell, i) => (
                  <td
                    key={columns[i]!.label}
                    className={cn(
                      'py-1 pr-3 align-top',
                      columns[i]!.right && 'text-right',
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** `YYYY-MM-DD` -> `DD/MM/YYYY`. */
function dmy(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

export function ReportSections({ report }: { report: DailyReport }) {
  const { t } = useTranslation();
  const { sales, voids, payments } = report;
  const empty = t('reports.empty');
  return (
    <div className="flex flex-col gap-4" data-testid="daily-report">
      <Section
        id="report-sales"
        title={t('reports.sales.title')}
        basis={t('reports.sales.basis')}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Figures
            caption={t('reports.sales.title')}
            rows={[
              {
                label: t('reports.sales.invoiceCount'),
                value: (
                  <Count
                    field="sales.invoiceCount"
                    value={sales.invoiceCount}
                  />
                ),
              },
              {
                label: t('reports.sales.grossSubtotal'),
                value: (
                  <Money
                    field="sales.grossSubtotal"
                    value={sales.grossSubtotal}
                  />
                ),
              },
              {
                label: t('reports.sales.itemDiscounts'),
                value: (
                  <Money
                    field="sales.itemDiscounts"
                    value={sales.itemDiscounts}
                  />
                ),
              },
              {
                label: t('reports.sales.invoiceDiscounts'),
                value: (
                  <Money
                    field="sales.invoiceDiscounts"
                    value={sales.invoiceDiscounts}
                  />
                ),
              },
              {
                label: t('reports.sales.netBeforeVoids'),
                value: (
                  <Money
                    field="sales.netBeforeVoids"
                    value={sales.netBeforeVoids}
                  />
                ),
                strong: true,
              },
            ]}
          />
          <Figures
            caption={t('reports.voids.title')}
            rows={[
              {
                label: t('reports.voids.count'),
                value: <Count field="voids.count" value={voids.count} />,
              },
              {
                label: t('reports.voids.deduction'),
                value: (
                  <Money field="voids.deduction" value={voids.deduction} />
                ),
              },
              {
                label: t('reports.voids.netAfterVoids'),
                value: (
                  <Money field="netAfterVoids" value={report.netAfterVoids} />
                ),
                strong: true,
              },
            ]}
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Table
            caption={t('reports.sales.byChannel')}
            columns={[
              { label: t('reports.sales.channel') },
              { label: t('reports.sales.invoiceCount'), right: true },
              { label: t('reports.sales.net'), right: true },
            ]}
            rows={sales.byChannel.map((row, i) => ({
              key: row.channel.id,
              cells: [
                row.channel.label,
                <Count
                  key="n"
                  field={`sales.byChannel.${i}.invoiceCount`}
                  value={row.invoiceCount}
                />,
                <Money
                  key="v"
                  field={`sales.byChannel.${i}.netBeforeVoids`}
                  value={row.netBeforeVoids}
                />,
              ],
            }))}
            empty={empty}
          />
          <Table
            caption={t('reports.sales.byCashier')}
            columns={[
              { label: t('reports.sales.cashier') },
              { label: t('reports.sales.invoiceCount'), right: true },
              { label: t('reports.sales.net'), right: true },
            ]}
            rows={sales.byCashier.map((row, i) => ({
              key: row.cashier.id,
              cells: [
                row.cashier.displayName,
                <Count
                  key="n"
                  field={`sales.byCashier.${i}.invoiceCount`}
                  value={row.invoiceCount}
                />,
                <Money
                  key="v"
                  field={`sales.byCashier.${i}.netBeforeVoids`}
                  value={row.netBeforeVoids}
                />,
              ],
            }))}
            empty={empty}
          />
        </div>
      </Section>

      <Section
        id="report-voids"
        title={t('reports.voids.title')}
        basis={t('reports.voids.basis')}
      >
        <Table
          caption={t('reports.voids.list')}
          columns={[
            { label: t('reports.voids.invoiceNumber') },
            { label: t('reports.voids.finalizedDate') },
            { label: t('reports.voids.voidedAt') },
            { label: t('reports.voids.voidedBy') },
            { label: t('reports.voids.channel') },
            { label: t('reports.voids.reason') },
            { label: t('reports.voids.amount'), right: true },
          ]}
          rows={voids.invoices.map((v, i) => ({
            key: v.invoiceId,
            cells: [
              <span key="no" className="whitespace-nowrap">
                {v.invoiceNumber}
              </span>,
              dmy(v.finalizedDate),
              <span key="at" className="whitespace-nowrap tabular-nums">
                {`${dmy(v.voidedAtLocal.slice(0, 10))} ${v.voidedAtLocal.slice(11)}`}
              </span>,
              v.voidedBy.displayName,
              v.channel.label,
              <span key="r" className="break-words">
                {v.reason}
              </span>,
              <Money
                key="v"
                field={`voids.invoices.${i}.amount`}
                value={v.amount}
              />,
            ],
          }))}
          empty={empty}
        />
      </Section>

      <Section
        id="report-payments"
        title={t('reports.payments.title')}
        basis={t('reports.payments.basis')}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Figures
            caption={t('reports.payments.title')}
            rows={[
              {
                label: t('reports.payments.count'),
                value: <Count field="payments.count" value={payments.count} />,
              },
              {
                label: t('reports.payments.sameDay'),
                value: (
                  <Money
                    field="payments.sameDayInvoices"
                    value={payments.sameDayInvoices}
                  />
                ),
              },
              {
                label: t('reports.payments.older'),
                value: (
                  <Money
                    field="payments.olderInvoices"
                    value={payments.olderInvoices}
                  />
                ),
              },
              {
                label: t('reports.payments.received'),
                value: (
                  <Money field="payments.received" value={payments.received} />
                ),
                strong: true,
              },
            ]}
          />
          <Table
            caption={t('reports.payments.byMethod')}
            columns={[
              { label: t('reports.payments.method') },
              { label: t('reports.payments.count'), right: true },
              { label: t('reports.payments.amount'), right: true },
            ]}
            rows={payments.byMethod.map((m) => ({
              key: m.method,
              cells: [
                t(`workspace.paymentMethod.${m.method}`),
                <Count
                  key="n"
                  field={`payments.byMethod.${m.method}.count`}
                  value={m.count}
                />,
                <Money
                  key="v"
                  field={`payments.byMethod.${m.method}.amount`}
                  value={m.amount}
                />,
              ],
            }))}
            empty={empty}
          />
        </div>
      </Section>
    </div>
  );
}
