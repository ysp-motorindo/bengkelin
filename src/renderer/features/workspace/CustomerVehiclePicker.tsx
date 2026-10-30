import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Input } from '@/renderer/components/ui/input';
import { Dialog } from '@/renderer/components/ui/dialog';
import { QuickCustomerForm } from '@/renderer/features/customers/QuickCustomerForm';
import { QuickVehicleForm } from '@/renderer/features/customers/QuickVehicleForm';
import { customerLabel } from '@/renderer/features/customers/labels';
import { errorMessage } from '@/renderer/lib/errors';
import type { CustomerDto, VehicleDto } from '@/shared/contracts';
import type { DraftCommands } from './use-draft-commands';
interface CustomerVehiclePickerProps {
  mode: 'customer' | 'vehicle';
  commands: DraftCommands;
  onError(message: string | null): void;
}
export function CustomerVehiclePicker({
  mode,
  commands,
  onError,
}: CustomerVehiclePickerProps) {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [customers, setCustomers] = useState<CustomerDto[]>([]);
  const [plates, setPlates] = useState<VehicleDto[]>([]);
  const [owner, setOwner] = useState<CustomerDto | null>(null);
  const [owned, setOwned] = useState<VehicleDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 0,
    maxHeight: 288,
  });
  const seq = useRef(0);
  const { view, send } = commands;
  const customerId = view.customer?.id;
  const label = t(
    mode === 'customer'
      ? 'workspace.header.customer'
      : 'workspace.header.vehicleNumber',
  );
  const cleared = t(
    mode === 'customer'
      ? 'workspace.header.anonymous'
      : 'workspace.header.noVehicle',
  );
  const selected =
    mode === 'customer'
      ? view.customer
        ? customerLabel(t, view.customer)
        : cleared
      : (view.vehicle?.plateNumber ?? cleared);
  useEffect(() => {
    let current = true;
    setOwner(null);
    setOwned([]);
    if (!customerId || mode !== 'vehicle') return;
    window.bengkelin.customers
      .get({ id: customerId })
      .then((result) => {
        if (!current) return;
        if (result.ok) {
          setOwner(result.value.customer);
          setOwned(result.value.vehicles);
        } else setError(errorMessage(t, result.error));
      })
      .catch(() => {
        if (current) setError(t('errors.INTERNAL_ERROR'));
      });
    return () => {
      current = false;
    };
  }, [customerId, mode, t]);
  useEffect(() => {
    const version = ++seq.current;
    if (!open) return;
    setCustomers([]);
    setPlates([]);
    setError(null);
    const timer = setTimeout(
      async () => {
        try {
          if (mode === 'customer') {
            const result = await window.bengkelin.customers.search({
              query,
              includeInactive,
            });
            if (version !== seq.current) return;
            if (result.ok) setCustomers(result.value.results);
            else setError(errorMessage(t, result.error));
          } else if (query.trim()) {
            const result = await window.bengkelin.vehicles.searchByPlate({
              query,
            });
            if (version !== seq.current) return;
            if (result.ok) setPlates(result.value.results);
            else setError(errorMessage(t, result.error));
          }
        } catch {
          if (version === seq.current) setError(t('errors.INTERNAL_ERROR'));
        }
      },
      query ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      seq.current++;
    };
  }, [query, includeInactive, open, mode, t]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = input.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const height = Math.max(80, Math.min(288, Math.max(above, below)));
      setPosition({
        left: Math.max(8, rect.left),
        top:
          below >= Math.min(288, above)
            ? rect.bottom + 4
            : rect.top - height - 4,
        width: Math.min(Math.max(rect.width, 300), window.innerWidth - 16),
        maxHeight: height,
      });
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open]);
  async function choose(recordId: string | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await send({
        kind: 'updateHeader',
        changes:
          mode === 'customer'
            ? { customerId: recordId }
            : { vehicleId: recordId },
      });
      if (!result.ok) {
        const message = errorMessage(t, result.error);
        setError(message);
        onError(message);
        return;
      }
      onError(null);
      setOpen(false);
      setQuery('');
      setCreating(false);
      input.current?.focus();
    } catch {
      setError(t('errors.INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  }
  const vehicles = query.trim() ? plates : owned;
  const options =
    mode === 'customer'
      ? customers.map((c) => ({
          id: c.id,
          label:
            customerLabel(t, c) +
            (c.isActive ? '' : ` · ${t('customers.inactive')}`),
        }))
      : vehicles.map((v) => ({
          id: v.id,
          label: [
            v.plateNumber,
            v.brandName,
            v.modelName,
            query.trim()
              ? v.activeOwner
                ? customerLabel(t, v.activeOwner)
                : t('workspace.party.noOwner')
              : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }));
  const actions = [
    ...options.map((record) => ({
      key: `record:${record.id}`,
      label: record.label,
      run: () => void choose(record.id),
    })),
    { key: 'clear', label: cleared, run: () => void choose(null) },
    {
      key: 'create',
      label: t(
        mode === 'customer'
          ? 'workspace.party.createCustomer'
          : 'workspace.party.createVehicle',
      ),
      run: () => {
        setOpen(false);
        setCreating(true);
      },
    },
  ];
  const activeIndex = actions.findIndex((action) => action.key === active);
  useEffect(() => {
    if (open && activeIndex >= 0)
      document
        .getElementById(`${id}-${activeIndex}`)
        ?.scrollIntoView?.({ block: 'nearest' });
  }, [id, open, activeIndex]);
  return (
    <div className="relative flex flex-col gap-1.5">
      <label htmlFor={id}>{label}</label>
      <Input
        ref={input}
        id={id}
        data-testid={mode === 'customer' ? 'header-customer' : 'header-vehicle'}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-results`}
        aria-activedescendant={
          open && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined
        }
        autoComplete="off"
        disabled={busy}
        value={open ? query : selected}
        placeholder={t(
          mode === 'customer'
            ? 'workspace.party.customerSearch'
            : 'workspace.party.plateSearch',
        )}
        onFocus={() => {
          setActive(null);
        }}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setQuery('');
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(null);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            setQuery('');
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            setActive((current) => {
              const index = actions.findIndex(
                (action) => action.key === current,
              );
              const step = event.key === 'ArrowDown' ? 1 : -1;
              const next =
                index < 0
                  ? step > 0
                    ? 0
                    : actions.length - 1
                  : (index + step + actions.length) % actions.length;
              return actions[next]!.key;
            });
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            if (open && activeIndex >= 0) actions[activeIndex]?.run();
          }
        }}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {open
        ? createPortal(
            <div
              style={position}
              className="fixed z-40 overflow-auto rounded-md border border-border bg-card py-1 shadow-lg"
              onMouseDown={(event) => event.preventDefault()}
            >
              {mode === 'customer' ? (
                <label className="flex items-center gap-2 px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    checked={includeInactive}
                    onChange={(event) =>
                      setIncludeInactive(event.target.checked)
                    }
                  />
                  {t('workspace.party.showInactive')}
                </label>
              ) : null}
              <ul id={`${id}-results`} role="listbox" aria-label={label}>
                {actions.map((action, index) => (
                  <li
                    key={action.key}
                    id={`${id}-${index}`}
                    role="option"
                    aria-selected={active === action.key}
                    onMouseEnter={() => setActive(action.key)}
                    onClick={action.run}
                    className={`cursor-pointer px-3 py-2 text-sm ${active === action.key ? 'bg-accent text-accent-foreground' : ''}`}
                  >
                    {action.label}
                  </li>
                ))}
              </ul>
            </div>,
            document.body,
          )
        : null}
      {creating ? (
        <Dialog
          title={t(
            mode === 'customer'
              ? 'workspace.party.createCustomer'
              : 'workspace.party.createVehicle',
          )}
          onClose={() => setCreating(false)}
          returnFocus={() => input.current?.focus()}
          closeLabel={t('workspace.common.close')}
        >
          {mode === 'customer' ? (
            <QuickCustomerForm
              onSelected={(record) => void choose(record.id)}
            />
          ) : (
            <QuickVehicleForm
              customer={owner}
              onSelected={(record) => void choose(record.id)}
            />
          )}
        </Dialog>
      ) : null}
    </div>
  );
}
