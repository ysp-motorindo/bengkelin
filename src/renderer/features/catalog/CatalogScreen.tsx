import { useNumberFormat } from '@/renderer/lib/number-format';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { X } from 'lucide-react';
import { useAction } from '@/renderer/lib/use-action';
import type { CatalogItemDto, Role } from '@/shared/contracts';
import { BarcodeEditor } from './BarcodeEditor';
import { ItemForm } from './ItemForm';
import { PricingPanel } from './PricingPanel';

const LIST_LIMIT = 25;

type Panel =
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'item'; id: string; editing: boolean };

/**
 * Catalog list with search and barcode lookup for every signed-in cashier.
 * ADMIN also gets the item form, barcode editor and price editing. Every
 * write is re-authorized in main; this only decides what to show.
 */
export function CatalogScreen({ role }: { role: Role }) {
  const { numberOptions } = useNumberFormat();
  const { t } = useTranslation();
  const admin = role === 'ADMIN';
  const [query, setQuery] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [results, setResults] = useState<CatalogItemDto[]>([]);
  const [panel, setPanel] = useState<Panel>({ kind: 'none' });
  const [code, setCode] = useState('');
  const [found, setFound] = useState<CatalogItemDto | null>(null);
  const search = useAction();
  const { run: searchRun, check: searchCheck } = search;
  const lookup = useAction();

  const runSearch = useCallback(
    (text: string, inactive: boolean) => {
      void searchRun(async () => {
        const result = await window.bengkelin.catalog.search({
          query: text,
          includeInactive: inactive,
          limit: LIST_LIMIT,
        });
        if (searchCheck(result)) {
          setResults(result.value.results);
          setHasLoaded(true);
        }
      });
    },
    [searchRun, searchCheck],
  );

  useEffect(() => {
    runSearch('', false);
  }, [runSearch]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    runSearch(query, includeInactive);
  }

  function submitLookup(event: FormEvent) {
    event.preventDefault();
    setFound(null);
    void lookup.run(async () => {
      const result = await window.bengkelin.catalog.lookupBarcode({ code });
      if (!lookup.check(result)) return;
      setFound(result.value);
      setCode('');
      setPanel({ kind: 'item', id: result.value.id, editing: false });
    });
  }

  function replace(item: CatalogItemDto) {
    setResults((current) => {
      const exists = current.some((entry) => entry.id === item.id);
      return exists
        ? current.map((entry) => (entry.id === item.id ? item : entry))
        : [item, ...current];
    });
  }

  const selected =
    panel.kind === 'item'
      ? (results.find((entry) => entry.id === panel.id) ??
        (found?.id === panel.id ? found : undefined))
      : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold leading-tight tracking-tight">
          {t('catalog.title')}
        </h1>
        {admin ? (
          <Button onClick={() => setPanel({ kind: 'new' })}>
            {t('catalog.new')}
          </Button>
        ) : null}
      </div>
      {!admin ? (
        <p className="text-sm text-muted-foreground">
          {t('catalog.readOnlyNote')}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <form
          onSubmit={submitSearch}
          noValidate
          role="search"
          className="flex flex-col gap-2"
        >
          <FormField label={t('catalog.search.label')}>
            <Input
              type="search"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </FormField>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={search.busy}
              checked={includeInactive}
              onChange={(event) => {
                setIncludeInactive(event.target.checked);
                runSearch(query, event.target.checked);
              }}
            />
            {t('catalog.search.includeInactive')}
          </label>
          <div>
            <Button type="submit" disabled={search.busy}>
              {t('catalog.search.submit')}
            </Button>
          </div>
        </form>

        <form
          onSubmit={submitLookup}
          noValidate
          className="flex flex-col gap-2"
        >
          <FormField label={t('catalog.lookup.label')}>
            <Input
              autoComplete="off"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </FormField>
          <div>
            <Button type="submit" disabled={lookup.busy}>
              {t('catalog.lookup.submit')}
            </Button>
          </div>
          {lookup.error ? <Alert>{lookup.error}</Alert> : null}
          {found ? (
            <p role="status" data-testid="lookup-found" className="text-sm">
              {t('catalog.lookup.found', { title: found.title })}
            </p>
          ) : null}
        </form>
      </div>

      {search.error ? <Alert>{search.error}</Alert> : null}
      {search.busy ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : null}
      {hasLoaded && !search.busy && !search.error && results.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('catalog.search.empty')}
        </p>
      ) : null}
      {results.length > 0 ? (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="px-2 py-2">
                  {t('catalog.list.title')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('catalog.list.sku')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('catalog.list.type')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('catalog.list.unit')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('catalog.list.status')}
                </th>
                <th scope="col" className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {results.map((item) => (
                <tr
                  key={item.id}
                  data-testid="catalog-row"
                  className="border-t border-border"
                >
                  <td className="max-w-80 wrap-anywhere px-2 py-2">
                    {item.title}
                  </td>
                  <td className="max-w-40 wrap-anywhere px-2 py-2">
                    {item.sku ?? ''}
                  </td>
                  <td className="px-2 py-2">
                    {t(`catalog.type.${item.type}`)}
                  </td>
                  <td className="px-2 py-2">{item.unitLabel}</td>
                  <td className="px-2 py-2">
                    {item.isActive
                      ? t('catalog.status.active')
                      : t('catalog.status.inactive')}
                  </td>
                  <td className="px-2 py-2">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`${t('catalog.list.open')}: ${item.title}`}
                      onClick={() =>
                        setPanel({ kind: 'item', id: item.id, editing: false })
                      }
                    >
                      {t('catalog.list.open')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {results.length >= LIST_LIMIT ? (
        <p className="text-sm text-muted-foreground">
          {t('catalog.search.limit', { ...numberOptions, count: LIST_LIMIT })}
        </p>
      ) : null}

      {panel.kind === 'new' ? (
        <ItemForm
          onCancel={() => setPanel({ kind: 'none' })}
          onSaved={(item) => {
            replace(item);
            setPanel({ kind: 'item', id: item.id, editing: false });
          }}
        />
      ) : null}
      {selected ? (
        <Dialog
          title={t('catalog.detail.title')}
          closeLabel={t('workspace.common.close')}
          onClose={() => setPanel({ kind: 'none' })}
          footer={
            <DialogActions
              secondary={
                <Button
                  variant="outline"
                  onClick={() => setPanel({ kind: 'none' })}
                >
                  <X aria-hidden="true" />
                  {t('workspace.common.close')}
                </Button>
              }
            />
          }
        >
          {selected ? (
            <div className="flex min-w-0 flex-col gap-6">
              {admin && panel.kind === 'item' && panel.editing ? (
                <ItemForm
                  item={selected}
                  onCancel={() =>
                    setPanel({ kind: 'item', id: selected.id, editing: false })
                  }
                  onSaved={(item) => {
                    replace(item);
                    setPanel({ kind: 'item', id: item.id, editing: false });
                  }}
                />
              ) : (
                <ItemSummary
                  item={selected}
                  onEdit={
                    admin
                      ? () =>
                          setPanel({
                            kind: 'item',
                            id: selected.id,
                            editing: true,
                          })
                      : undefined
                  }
                />
              )}
              {admin ? (
                <BarcodeEditor item={selected} onChanged={replace} />
              ) : null}
              <PricingPanel
                key={selected.id}
                catalogItemId={selected.id}
                canEdit={admin}
              />
            </div>
          ) : null}
        </Dialog>
      ) : null}
    </div>
  );
}

function ItemSummary({
  item,
  onEdit,
}: {
  item: CatalogItemDto;
  onEdit: (() => void) | undefined;
}) {
  const { numberOptions } = useNumberFormat();
  const { t } = useTranslation();
  return (
    <section
      aria-label={t('catalog.detail.title')}
      data-testid="item-detail"
      className="flex flex-col gap-1"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <h2 className="min-w-0 flex-1 wrap-anywhere text-lg font-semibold">
          {item.title}
        </h2>
        {onEdit ? (
          <Button variant="outline" size="sm" onClick={onEdit}>
            {t('catalog.form.editTitle')}
          </Button>
        ) : null}
      </div>
      <p className="wrap-anywhere text-sm text-muted-foreground">
        {t(`catalog.type.${item.type}`)} ·{' '}
        {item.sku ?? t('catalog.detail.noSku')} · {item.unitLabel}
        {item.weight !== null
          ? ` · ${t('catalog.detail.weight', { ...numberOptions, grams: item.weight })}`
          : ''}{' '}
        ·{' '}
        {item.trackInventory
          ? t('catalog.detail.tracked')
          : t('catalog.detail.notTracked')}
      </p>
      {item.description ? (
        <p className="wrap-anywhere text-sm">{item.description}</p>
      ) : null}
      {item.barcodes.length > 0 ? (
        <p className="wrap-anywhere font-mono text-sm">
          {item.barcodes
            .filter((entry) => entry.isActive)
            .map((entry) => entry.barcode)
            .join(', ')}
        </p>
      ) : null}
    </section>
  );
}
