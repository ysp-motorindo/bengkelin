import { createPortal } from 'react-dom';
import { NavigationRow } from '@/renderer/features/shell/NavigationRow';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { FormField } from '@/renderer/components/form-field';
import { useAction } from '@/renderer/lib/use-action';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { todayInShop } from '@/renderer/features/workspace/shop-time';
import { formatDisplayDate } from '@/renderer/lib/date-format';
import type {
  PurchaseDraftView,
  PurchaseView,
  ReferenceDto,
  PurchasePage,
} from '@/shared/contracts';
import { PurchaseEditor } from './PurchaseEditor';
import { PurchaseDetail } from './PurchaseDetail';
import { SuppliersScreen } from './Suppliers';
import {
  registerWorkspaceActions,
  type WorkspaceActions,
} from '@/renderer/features/workspace/workspace-actions';
type Tab = 'editor' | 'history' | 'receiving' | 'payables' | 'suppliers';
export function PurchasesScreen({
  active,
  navigationSlot,
}: {
  active: boolean;
  navigationSlot?: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const action = useAction();
  const [started, setStarted] = useState(false);
  const [tab, setTab] = useState<Tab>('editor');
  const [drafts, setDrafts] = useState<PurchaseDraftView[]>([]);
  const [current, setCurrent] = useState<PurchaseDraftView | null>(null);
  const [units, setUnits] = useState<ReferenceDto[]>([]);
  const [locations, setLocations] = useState<ReferenceDto[]>([]);
  const [timezone, setTimezone] = useState('Asia/Jakarta');
  const [autoPrint, setAutoPrint] = useState(false);
  const [detail, setDetail] = useState<PurchaseView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const newRequest = useRef<string | null>(null);
  const editorActions = useRef<WorkspaceActions | null>(null);
  const registerDraftActions = useCallback((actions: WorkspaceActions) => {
    editorActions.current = actions;
    return () => {
      if (editorActions.current === actions) editorActions.current = null;
    };
  }, []);
  const flushDraft = useCallback(
    () => editorActions.current?.saveDraft() ?? Promise.resolve(true),
    [],
  );
  const changedDraft = useCallback(
    (view: PurchaseDraftView) =>
      setDrafts((ds) =>
        ds.some((d) => d.id === view.id && d.version < view.version)
          ? ds.map((d) => (d.id === view.id ? view : d))
          : ds,
      ),
    [],
  );

  const refreshReferences = useCallback(async () => {
    const b = window.bengkelin;
    const [u, l, s] = await Promise.all([
      b.references.listActive({ entity: 'unit' }),
      b.references.listActive({ entity: 'stockLocation' }),
      b.settings.getShop(),
    ]);
    if (action.check(u)) setUnits(u.value);
    if (action.check(l)) setLocations(l.value);
    if (action.check(s)) setTimezone(s.value.timezone);
  }, [action.check]);
  const boot = useCallback(async () => {
    const [d] = await Promise.all([
      window.bengkelin.purchaseDrafts.list(),
      refreshReferences(),
    ]);
    if (action.check(d)) {
      setDrafts(d.value);
      setCurrent((old) => old ?? d.value[0] ?? null);
    }
  }, [action.check, refreshReferences]);
  const wasActive = useRef(false);
  useEffect(() => {
    if (active && !wasActive.current) {
      setTab('editor');
      setDetail(null);
      setAutoPrint(false);
      if (!started) {
        setStarted(true);
        void action.run(boot);
      } else void action.run(refreshReferences);
    }
    wasActive.current = active;
  }, [active, started, boot, refreshReferences, action.run]);
  const create = useCallback(async () => {
    if (!(await flushDraft())) {
      setNotice(t('workspace.notices.unsaved'));
      setTab('editor');
      return;
    }
    await action.run(async () => {
      newRequest.current ??= crypto.randomUUID();
      const r = await window.bengkelin.purchaseDrafts.create({
        requestId: newRequest.current,
        billDate: todayInShop(timezone),
      });
      if (action.check(r)) {
        newRequest.current = null;
        setCurrent(r.value);
        setDrafts((ds) => [r.value, ...ds]);
        setDetail(null);
        setTab('editor');
      }
    });
  }, [action.run, action.check, timezone, flushDraft]);
  useEffect(() => {
    if (!active || tab === 'editor') return;
    return registerWorkspaceActions({
      newTransaction: create,
      focusSearch: () => {
        setTab('editor');
        requestAnimationFrame(() => editorActions.current?.focusSearch());
      },
      addCustomItem: () => {
        setTab('editor');
        requestAnimationFrame(() => editorActions.current?.addCustomItem());
      },
      saveDraft: flushDraft,
      openCheckoutReview: async () => {
        setTab('editor');
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        await editorActions.current?.openCheckoutReview();
      },
    });
  }, [active, tab, create]);
  if (!started) return null;
  const navigate = (next: Tab) => {
    setAutoPrint(false);
    setTab(next);
    setDetail(null);
  };
  const reload = async () => {
    if (!detail) return;
    const r = await window.bengkelin.purchases.get({ purchaseId: detail.id });
    if (action.check(r)) setDetail(r.value);
  };
  const navigation = (
    <NavigationRow
      label={t('shell.nav.secondaryLabel', { area: t('purchases.title') })}
      level="secondary"
      items={(
        ['editor', 'history', 'receiving', 'payables', 'suppliers'] as const
      ).map((name) => ({
        id: name,
        label: t(`purchases.${name}`),
        current: name === tab ? 'page' : undefined,
        onSelect: () => navigate(name),
      }))}
    />
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('purchases.title')}</h1>
      </div>
      {active
        ? navigationSlot
          ? createPortal(navigation, navigationSlot)
          : navigation
        : null}
      {action.error ? (
        <Alert>
          {action.error}
          <Button variant="outline" onClick={() => void action.run(boot)}>
            {t('common.retry')}
          </Button>
        </Alert>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div hidden={tab !== 'editor'}>
        {drafts.length ? (
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <FormField label={t('purchases.drafts')}>
              <Select
                value={current?.id ?? ''}
                onChange={(e) => {
                  const id = e.target.value;
                  void flushDraft().then((ok) => {
                    if (ok)
                      void action.run(async () => {
                        const r = await window.bengkelin.purchaseDrafts.get({
                          purchaseId: id,
                        });
                        if (action.check(r)) setCurrent(r.value);
                      });
                  });
                }}
              >
                {drafts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.supplier?.name ?? t('purchases.chooseSupplier')} ·{' '}
                    {formatDisplayDate(d.billDate)} · {d.id.slice(0, 8)}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
        ) : null}
        {current ? (
          <PurchaseEditor
            key={current.id}
            initial={current}
            active={active && tab === 'editor'}
            units={units}
            registerDraftActions={registerDraftActions}
            onChanged={changedDraft}
            onNew={create}
            onPosted={(p) => {
              setDrafts((ds) => ds.filter((d) => d.id !== p.id));
              setCurrent(null);
              setAutoPrint(true);
              setDetail(p);
              setTab('history');
              setNotice(t('purchases.billRecorded'));
            }}
            onDiscarded={() => {
              setCurrent(null);
              void action.run(async () => {
                const r = await window.bengkelin.purchaseDrafts.list();
                if (action.check(r)) {
                  setDrafts(r.value);
                  setCurrent(r.value[0] ?? null);
                }
              });
            }}
          />
        ) : (
          <div className="space-y-4 rounded-md border bg-card p-6">
            <p>{t('purchases.noDrafts')}</p>
            <Button onClick={() => void create()} disabled={action.busy}>
              {t('purchases.new')}
            </Button>
          </div>
        )}
      </div>
      {detail && tab !== 'editor' ? (
        <PurchaseDetail
          key={detail.id}
          purchase={detail}
          active={active}
          autoPrint={autoPrint}
          locations={locations}
          timezone={timezone}
          onChange={(p) => {
            setDetail(p);
            setNotice(null);
          }}
          onReload={reload}
          onBack={() => {
            setAutoPrint(false);
            setDetail(null);
          }}
        />
      ) : null}
      {!detail &&
      (tab === 'history' || tab === 'receiving' || tab === 'payables') ? (
        <PurchaseList tab={tab} onOpen={(p) => setDetail(p)} />
      ) : null}
      {tab === 'suppliers' ? <SuppliersScreen /> : null}
    </div>
  );
}
function PurchaseList({
  tab,
  onOpen,
}: {
  tab: 'history' | 'receiving' | 'payables';
  onOpen: (p: PurchaseView) => void;
}) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const action = useAction();
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [settlement, setSettlement] = useState<'PAYABLE' | 'REFUND_DUE'>(
    'PAYABLE',
  );
  const [result, setResult] = useState<PurchasePage | null>(null);
  const revision = useRef(0);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    const rev = ++revision.current;
    setLoading(true);
    try {
      const r = await window.bengkelin.purchases.search({
        query,
        page,
        ...(from ? { fromDate: from } : {}),
        ...(to ? { toDate: to } : {}),
        ...(tab === 'receiving' ? { receivingOnly: true } : {}),
        ...(tab === 'payables' ? { settlement } : {}),
      });
      if (rev === revision.current && action.check(r)) setResult(r.value);
    } catch {
      if (rev === revision.current) action.setError(t('errors.INTERNAL_ERROR'));
    } finally {
      if (rev === revision.current) setLoading(false);
    }
  }, [
    query,
    from,
    to,
    page,
    tab,
    settlement,
    action.check,
    action.setError,
    t,
  ]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 150);
    return () => {
      clearTimeout(timer);
      revision.current++;
    };
  }, [load]);
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <FormField label={t('purchases.search')}>
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </FormField>
        <FormField label={t('purchases.fromDate')}>
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </FormField>
        <FormField label={t('purchases.toDate')}>
          <Input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </FormField>
        {tab === 'payables' ? (
          <FormField label={t('purchases.paymentStatus')}>
            <Select
              value={settlement}
              onChange={(e) => {
                setSettlement(e.target.value as typeof settlement);
                setPage(1);
              }}
            >
              <option value="PAYABLE">{t('purchases.payableOnly')}</option>
              <option value="REFUND_DUE">{t('purchases.refundOnly')}</option>
            </Select>
          </FormField>
        ) : null}
      </div>
      {action.error ? (
        <Alert>
          {action.error}
          <Button variant="outline" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </Alert>
      ) : null}
      {loading ? <p role="status">{t('common.loading')}</p> : null}
      {result ? (
        <>
          <dl className="flex flex-wrap gap-6 text-sm">
            <div>
              <dt className="text-muted-foreground">
                {t('purchases.outstanding')}
              </dt>
              <dd className="font-semibold tabular-nums">
                {formatIdr(result.payableAmount)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t('purchases.refundDue')}
              </dt>
              <dd className="font-semibold tabular-nums">
                {formatIdr(result.refundDue)}
              </dd>
            </div>
          </dl>
          {!result.items.length ? (
            <p>{t('purchases.noResults')}</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[780px] text-sm">
                <caption className="sr-only">{t('purchases.history')}</caption>
                <thead className="bg-muted/40">
                  <tr>
                    {[
                      'billReference',
                      'supplier',
                      'billDate',
                      'total',
                      'outstanding',
                      'refundDue',
                      'paymentStatus',
                      'receivingStatus',
                    ].map((k) => (
                      <th key={k} className="p-3 text-left">
                        {t(`purchases.${k}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="p-3">
                        <Button
                          variant="ghost"
                          className="px-0 text-primary underline underline-offset-4"
                          onClick={() => onOpen(p)}
                        >
                          {p.documentNumber}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                          {p.supplierBillReference}
                        </p>
                      </td>
                      <td className="p-3">{p.supplier?.name}</td>
                      <td className="p-3">{formatDisplayDate(p.billDate)}</td>
                      <td className="p-3 tabular-nums">
                        {formatIdr(p.totals!.amount)}
                      </td>
                      <td className="p-3 tabular-nums">
                        {formatIdr(p.outstandingAmount)}
                      </td>
                      <td className="p-3 tabular-nums">
                        {formatIdr(p.refundDue)}
                      </td>
                      <td className="p-3">
                        {t(
                          `purchases.status.${p.status === 'VOID' ? 'VOID' : p.settlementStatus}`,
                        )}
                      </td>
                      <td className="p-3">
                        {t(`purchases.status.${p.receivingStatus}`)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center justify-end gap-3">
            <Button
              variant="outline"
              disabled={page === 1 || loading}
              onClick={() => setPage((p) => p - 1)}
            >
              {t('common.back')}
            </Button>
            <span className="text-sm">{page}</span>
            <Button
              variant="outline"
              disabled={!result.hasMore || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              {t('common.next')}
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
