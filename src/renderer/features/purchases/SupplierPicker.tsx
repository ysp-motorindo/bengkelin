import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/renderer/components/ui/input';
import { Button } from '@/renderer/components/ui/button';
import { errorMessage } from '@/renderer/lib/errors';
import type { SupplierDto } from '@/shared/contracts';

export function SupplierPicker({
  supplier,
  disabled,
  onSelect,
  onAdd,
}: {
  supplier: SupplierDto | null;
  disabled: boolean;
  onSelect(id: string | null): Promise<boolean>;
  onAdd(): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const revision = useRef(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SupplierDto[]>([]);
  const [active, setActive] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const rev = ++revision.current;
    if (!open) return;
    setItems([]);
    setActive(-1);
    setError(null);
    const timer = setTimeout(
      () => {
        void window.bengkelin.suppliers
          .search({ query, limit: 50 })
          .then((r) => {
            if (rev !== revision.current) return;
            if (r.ok) setItems(r.value.results);
            else setError(errorMessage(t, r.error));
          })
          .catch(() => {
            if (rev === revision.current) setError(t('errors.INTERNAL_ERROR'));
          });
      },
      query ? 150 : 0,
    );
    return () => {
      clearTimeout(timer);
      ++revision.current;
    };
  }, [open, query, retry, t]);
  async function choose(value: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      if (await onSelect(value)) {
        setOpen(false);
        setQuery('');
      } else setError(t('workspace.notices.unsaved'));
    } catch {
      setError(t('errors.INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="relative min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium">
        {t('purchases.supplier')}
      </label>
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={id + '-list'}
        aria-autocomplete="list"
        aria-activedescendant={
          open && active >= 0 ? id + '-' + active : undefined
        }
        disabled={disabled}
        readOnly={busy}
        aria-busy={busy}
        autoComplete="off"
        value={open ? query : (supplier?.name ?? '')}
        placeholder={t('purchases.chooseSupplier')}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => {
          if (!busy) {
            setOpen(false);
            setQuery('');
          }
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            setQuery('');
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            setActive((i) =>
              Math.max(
                0,
                Math.min(
                  items.length - 1,
                  i + (e.key === 'ArrowDown' ? 1 : -1),
                ),
              ),
            );
          }
          if (e.key === 'Enter' && open && items[active]) {
            e.preventDefault();
            void choose(items[active]!.id);
          }
        }}
      />
      {open ? (
        <div
          className="absolute left-0 top-full z-40 mt-1 w-full rounded-md border border-border bg-card p-1 shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          {error ? (
            <div role="alert" className="p-2 text-sm">
              {error}
              <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>
                {t('common.retry')}
              </Button>
            </div>
          ) : null}
          <ul
            id={id + '-list'}
            role="listbox"
            className="max-h-56 overflow-auto"
          >
            {items.map((s, i) => (
              <li
                key={s.id}
                id={id + '-' + i}
                role="option"
                aria-selected={active === i}
                className={
                  'cursor-pointer px-3 py-2 text-sm ' +
                  (active === i ? 'bg-accent' : '')
                }
                onMouseEnter={() => setActive(i)}
                onClick={() => void choose(s.id)}
              >
                {s.name}
                {s.phoneNumber ? (
                  <span className="ml-2 text-muted-foreground">
                    {s.phoneNumber}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-1 border-t pt-1">
            {supplier ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void choose(null)}
              >
                {t('purchases.clearSupplier')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onAdd();
              }}
            >
              {t('purchases.addSupplier')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
