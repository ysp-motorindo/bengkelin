import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { useAction } from '@/renderer/lib/use-action';
import type {
  CashierSession,
  InvoicePage,
  InvoiceSearchFilters,
  ReferenceDto,
} from '@/shared/contracts';
import { InvoiceDetail } from './InvoiceDetail';
import { Pager, SummaryTable } from './SummaryTable';
import { useShopTimezone } from './use-shop-timezone';

const EMPTY = {
  invoiceNumber: '',
  dateFrom: '',
  dateTo: '',
  customerName: '',
  phone: '',
  plate: '',
  channelId: '',
  cashierId: '',
  status: '',
  paymentStatus: '',
};
type FilterForm = typeof EMPTY;

const PAGE_SIZE = 25;

/** Only the filled-in fields; blank means "any". */
function toFilters(form: FilterForm): InvoiceSearchFilters {
  const filters: Record<string, string> = {};
  for (const [key, text] of Object.entries(form)) {
    if (text.trim() !== '') filters[key] = text.trim();
  }
  return filters as InvoiceSearchFilters;
}

interface Option {
  id: string;
  label: string;
}

/**
 * Transaction history (spec 34): issued invoices only, filtered on their
 * frozen snapshots, newest first, paginated. Opening a row shows the
 * read-only invoice with its permitted actions; Back returns to the same
 * filters and page.
 */
export function HistoryScreen({ session }: { session: CashierSession }) {
  const { t } = useTranslation();
  const timezone = useShopTimezone();
  const [form, setForm] = useState<FilterForm>(EMPTY);
  const [applied, setApplied] = useState<InvoiceSearchFilters>({});
  const [page, setPage] = useState<InvoicePage | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [channels, setChannels] = useState<Option[]>([]);
  const [cashiers, setCashiers] = useState<Option[]>([]);
  const list = useAction();
  const { run, check } = list;
  const admin = session.role === 'ADMIN';

  const load = useCallback(
    (filters: InvoiceSearchFilters, number: number) =>
      run(async () => {
        const result = await window.bengkelin.invoices.search({
          filters,
          page: { number, size: PAGE_SIZE },
        });
        if (check(result)) setPage(result.value);
      }),
    [run, check],
  );

  useEffect(() => {
    void load({}, 1);
  }, [load]);

  useEffect(() => {
    let live = true;
    const b = window.bengkelin;
    void (async () => {
      const channelResult = admin
        ? await b.references.list({ entity: 'channel' })
        : await b.references.listActive({ entity: 'channel' });
      if (live && channelResult.ok) {
        setChannels(
          (channelResult.value as ReferenceDto[]).map((c) => ({
            id: c.id,
            label: c.label,
          })),
        );
      }
      // Only ADMIN may list cashiers; a CASHIER can filter on themselves.
      if (admin) {
        const cashierResult = await b.cashiers.list();
        if (live && cashierResult.ok) {
          setCashiers(
            cashierResult.value.map((c) => ({
              id: c.id,
              label: c.displayName,
            })),
          );
        }
      } else if (live) {
        setCashiers([
          {
            id: session.cashierId,
            label: t('history.filters.me', { name: session.displayName }),
          },
        ]);
      }
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [admin, session.cashierId, session.displayName, t]);

  function set(key: keyof FilterForm, text: string) {
    setForm((current) => ({ ...current, [key]: text }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const filters = toFilters(form);
    setApplied(filters);
    void load(filters, 1);
  }

  function reset() {
    setForm(EMPTY);
    setApplied({});
    void load({}, 1);
  }

  if (selected && timezone) {
    return (
      <InvoiceDetail
        invoiceId={selected}
        timezone={timezone}
        onBack={() => {
          setSelected(null);
          void load(applied, page?.pageNumber ?? 1);
        }}
      />
    );
  }

  const text = (key: keyof FilterForm, label: string, hint?: string) => (
    <FormField
      label={label}
      hint={hint}
      error={list.fieldErrors[`filters.${key}`]}
    >
      <Input
        type="search"
        autoComplete="off"
        value={form[key]}
        onChange={(event) => set(key, event.target.value)}
      />
    </FormField>
  );

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-semibold">{t('history.title')}</h1>

      <form
        onSubmit={submit}
        noValidate
        role="search"
        aria-label={t('history.filters.label')}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        {text(
          'invoiceNumber',
          t('history.filters.invoiceNumber'),
          t('history.filters.invoiceNumberHint'),
        )}
        <FormField
          label={t('history.filters.dateFrom')}
          error={list.fieldErrors['filters.dateFrom']}
        >
          <Input
            type="date"
            value={form.dateFrom}
            onChange={(event) => set('dateFrom', event.target.value)}
          />
        </FormField>
        <FormField
          label={t('history.filters.dateTo')}
          error={list.fieldErrors['filters.dateTo']}
        >
          <Input
            type="date"
            value={form.dateTo}
            onChange={(event) => set('dateTo', event.target.value)}
          />
        </FormField>
        {text('customerName', t('history.filters.customerName'))}
        {text('phone', t('history.filters.phone'))}
        {text('plate', t('history.filters.plate'))}
        <FormField label={t('history.filters.channel')}>
          <Select
            value={form.channelId}
            onChange={(event) => set('channelId', event.target.value)}
          >
            <option value="">{t('history.filters.any')}</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={t('history.filters.cashier')}>
          <Select
            value={form.cashierId}
            onChange={(event) => set('cashierId', event.target.value)}
          >
            <option value="">{t('history.filters.any')}</option>
            {cashiers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={t('history.filters.status')}>
          <Select
            value={form.status}
            onChange={(event) => set('status', event.target.value)}
          >
            <option value="">{t('history.filters.any')}</option>
            <option value="FINALIZED">{t('history.status.FINALIZED')}</option>
            <option value="VOID">{t('history.status.VOID')}</option>
          </Select>
        </FormField>
        <FormField label={t('history.filters.paymentStatus')}>
          <Select
            value={form.paymentStatus}
            onChange={(event) => set('paymentStatus', event.target.value)}
          >
            <option value="">{t('history.filters.any')}</option>
            {(['UNPAID', 'PARTIALLY_PAID', 'PAID'] as const).map((status) => (
              <option key={status} value={status}>
                {t(`workspace.paymentStatus.${status}`)}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
          <Button type="submit" disabled={list.busy}>
            {t('history.filters.submit')}
          </Button>
          <Button type="button" variant="outline" onClick={reset}>
            {t('history.filters.reset')}
          </Button>
        </div>
      </form>

      {list.error ? <Alert>{list.error}</Alert> : null}

      {page ? (
        <>
          <SummaryTable
            rows={page.items}
            caption={t('history.table.caption')}
            onOpen={setSelected}
          />
          <Pager
            page={page}
            busy={list.busy}
            onPage={(number) => void load(applied, number)}
          />
        </>
      ) : null}
    </div>
  );
}
