import { useNumberFormat } from '@/renderer/lib/number-format';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { useAction } from '@/renderer/lib/use-action';
import { cn } from '@/renderer/lib/utils';
import {
  RECEIVABLE_KINDS,
  type ReceivableKind,
  type ReceivablesPage,
} from '@/shared/contracts';
import { InvoiceDetail } from './InvoiceDetail';
import { Pager, SummaryTable } from './SummaryTable';
import { useShopTimezone } from './use-shop-timezone';

const PAGE_SIZE = 25;

/**
 * Receivables: unpaid and partially paid FINALIZED invoices (VOID never
 * counts), oldest due date first, with an Overdue tab (due before today in
 * the shop timezone). Tabs follow the WAI-ARIA tabs pattern (arrow keys).
 */
export function ReceivablesScreen() {
  const { formatIdr } = useNumberFormat();
  const { t } = useTranslation();
  const timezone = useShopTimezone();
  const [kind, setKind] = useState<ReceivableKind>('OUTSTANDING');
  const [page, setPage] = useState<ReceivablesPage | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const list = useAction();
  const { run, check } = list;

  const load = useCallback(
    (which: ReceivableKind, number: number) =>
      run(async () => {
        const result = await window.bengkelin.invoices.receivables({
          kind: which,
          page: { number, size: PAGE_SIZE },
        });
        if (check(result)) setPage(result.value);
      }),
    [run, check],
  );

  useEffect(() => {
    void load(kind, 1);
  }, [load, kind]);

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const index = RECEIVABLE_KINDS.indexOf(kind);
    let next: number | null = null;
    if (event.key === 'ArrowRight')
      next = (index + 1) % RECEIVABLE_KINDS.length;
    if (event.key === 'ArrowLeft')
      next = (index - 1 + RECEIVABLE_KINDS.length) % RECEIVABLE_KINDS.length;
    if (next === null) return;
    event.preventDefault();
    const target = RECEIVABLE_KINDS[next]!;
    setKind(target);
    tabs.current[target]?.focus();
  }

  if (selected && timezone) {
    return (
      <InvoiceDetail
        invoiceId={selected}
        timezone={timezone}
        onBack={() => {
          setSelected(null);
          void load(kind, page?.pageNumber ?? 1);
        }}
      />
    );
  }

  const panelId = 'receivables-panel';
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <h1 className="text-xl font-semibold leading-tight tracking-tight">
        {t('history.receivables.title')}
      </h1>
      <div
        role="tablist"
        aria-label={t('history.receivables.tabs')}
        className="flex gap-1 border-b border-border"
      >
        {RECEIVABLE_KINDS.map((value) => (
          <button
            key={value}
            ref={(el) => {
              tabs.current[value] = el;
            }}
            type="button"
            role="tab"
            id={`receivables-tab-${value}`}
            aria-selected={kind === value}
            aria-controls={panelId}
            tabIndex={kind === value ? 0 : -1}
            onClick={() => setKind(value)}
            onKeyDown={onTabKey}
            className={cn(
              'px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              kind === value
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`history.receivables.${value}`)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={`receivables-tab-${kind}`}
        className="flex flex-col gap-3"
      >
        {page ? (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <p className="font-semibold" data-testid="receivables-total">
              {t('history.receivables.totalOutstanding', {
                amount: formatIdr(page.totalOutstanding),
              })}
            </p>
            <p className="text-muted-foreground">
              {t('history.receivables.today', { date: page.today })}
            </p>
          </div>
        ) : null}
        {kind === 'OVERDUE' ? (
          <p className="text-xs text-muted-foreground">
            {t('history.receivables.overdueNote')}
          </p>
        ) : null}
        {list.error ? <Alert>{list.error}</Alert> : null}
        {page && page.kind === kind ? (
          <>
            <SummaryTable
              rows={page.items}
              caption={t(`history.receivables.${kind}`)}
              emptyText={t('history.receivables.empty')}
              onOpen={setSelected}
            />
            <Pager
              page={page}
              busy={list.busy}
              onPage={(number) => void load(kind, number)}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
