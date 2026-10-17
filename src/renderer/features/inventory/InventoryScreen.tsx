import { useNumberFormat } from '@/renderer/lib/number-format';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { useAction } from '@/renderer/lib/use-action';
import { cn } from '@/renderer/lib/utils';
import type { Role, StockListItemDto } from '@/shared/contracts';
import { StockPanel } from './StockPanel';

/**
 * Stock list for every signed-in cashier (read-only), with negative stock
 * flagged and filterable (spec 25). ADMIN also gets the stock actions in the
 * item panel. Every write is re-authorized in main; `role` only decides what
 * to show.
 */
export function InventoryScreen({ role }: { role: Role }) {
  const { numberOptions, formatNumber } = useNumberFormat();
  const { t } = useTranslation();
  const admin = role === 'ADMIN';
  const [query, setQuery] = useState('');
  const [negativeOnly, setNegativeOnly] = useState(false);
  const [items, setItems] = useState<StockListItemDto[]>([]);
  const [picked, setPicked] = useState<StockListItemDto | null>(null);
  const list = useAction();
  const { run, check } = list;

  const load = useCallback(
    (text: string, negatives: boolean) =>
      run(async () => {
        const result = await window.bengkelin.inventory.listStock({
          query: text,
          negativeOnly: negatives,
        });
        if (check(result)) setItems(result.value.items);
      }),
    [run, check],
  );

  useEffect(() => {
    void load('', false);
  }, [load]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void load(query, negativeOnly);
  }

  const negativeCount = items.filter((item) => item.isNegative).length;
  // Stay on the picked item even if a filter no longer lists it.
  const selected =
    items.find((item) => item.catalogItemId === picked?.catalogItemId) ??
    picked;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{t('inventory.title')}</h1>
      {!admin ? (
        <p className="text-sm text-muted-foreground">
          {t('inventory.readOnlyNote')}
        </p>
      ) : null}

      <form
        onSubmit={submit}
        noValidate
        role="search"
        className="flex flex-col gap-2 md:max-w-md"
      >
        <FormField label={t('inventory.search.label')}>
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
            checked={negativeOnly}
            onChange={(event) => {
              setNegativeOnly(event.target.checked);
              void load(query, event.target.checked);
            }}
          />
          {t('inventory.filter.negativeOnly')}
        </label>
        <div>
          <Button type="submit" disabled={list.busy}>
            {t('inventory.search.submit')}
          </Button>
        </div>
      </form>

      {list.error ? <Alert>{list.error}</Alert> : null}
      {negativeCount > 0 ? (
        <p
          role="status"
          data-testid="negative-banner"
          className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive"
        >
          {t('inventory.negativeBanner', {
            ...numberOptions,
            count: negativeCount,
          })}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('inventory.search.empty')}
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="py-1 pr-2">
                {t('inventory.list.title')}
              </th>
              <th scope="col" className="py-1 pr-2">
                {t('inventory.list.sku')}
              </th>
              <th scope="col" className="py-1 pr-2 text-right">
                {t('inventory.list.stock')}
              </th>
              <th scope="col" className="py-1 pr-2">
                {t('inventory.list.unit')}
              </th>
              <th scope="col" className="py-1" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.catalogItemId}
                data-testid="stock-row"
                data-negative={item.isNegative ? 'true' : 'false'}
                className={cn(
                  'border-t border-border',
                  item.isNegative && 'bg-destructive/10',
                )}
              >
                <td className="py-1 pr-2">{item.title}</td>
                <td className="py-1 pr-2">{item.sku ?? ''}</td>
                <td className="py-1 pr-2 text-right font-mono">
                  {formatNumber(item.quantity)}
                  {item.isNegative ? (
                    <span
                      data-testid="negative-flag"
                      className="ml-2 rounded border border-destructive px-1 font-sans text-xs text-destructive"
                    >
                      {t('inventory.negative')}
                    </span>
                  ) : null}
                </td>
                <td className="py-1 pr-2">{item.unitLabel}</td>
                <td className="py-1">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`${t('inventory.list.open')}: ${item.title}`}
                    onClick={() => setPicked(item)}
                  >
                    {t('inventory.list.open')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected ? (
        <StockPanel
          key={selected.catalogItemId}
          item={selected}
          admin={admin}
          onChanged={() => load(query, negativeOnly)}
        />
      ) : null}
    </div>
  );
}
