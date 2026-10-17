import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog } from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { QuickCustomerForm } from '@/renderer/features/customers/QuickCustomerForm';
import { QuickVehicleForm } from '@/renderer/features/customers/QuickVehicleForm';
import {
  customerLabel,
  customerName,
} from '@/renderer/features/customers/labels';
import { useAction } from '@/renderer/lib/use-action';
import type { CustomerDto, DraftView, VehicleDto } from '@/shared/contracts';
import type { Result } from '@/shared/primitives';

interface CustomerVehicleDialogProps {
  view: DraftView;
  selectCustomer(customerId: string | null): Promise<boolean>;
  selectVehicle(vehicleId: string | null): Promise<boolean>;
  clearParty(): Promise<Result<null>>;
  onClose(): void;
}

function vehicleText(vehicle: VehicleDto): string {
  return [vehicle.plateNumber, vehicle.brandName, vehicle.modelName]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Customer and vehicle for the draft (spec 51): customer search, quick
 * create (name + phone), "Umum" (anonymous), the customer's vehicles, global
 * plate search showing the current owner, and quick vehicle creation.
 * Selecting never changes ownership; a mismatch is only a warning.
 */
export function CustomerVehicleDialog({
  view,
  selectCustomer,
  selectVehicle,
  clearParty,
  onClose,
}: CustomerVehicleDialogProps) {
  const { t } = useTranslation();
  const searchRef = useRef<HTMLInputElement>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const includeInactiveRef = useRef(false);
  const searchVersion = useRef(0);
  const plateVersion = useRef(0);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customers, setCustomers] = useState<CustomerDto[] | null>(null);
  const [plateQuery, setPlateQuery] = useState('');
  const [plates, setPlates] = useState<VehicleDto[] | null>(null);
  const [selected, setSelected] = useState<CustomerDto | null>(null);
  const [owned, setOwned] = useState<VehicleDto[]>([]);
  const { error, run, check, setError } = useAction();
  const customerId = view.customer?.id ?? null;

  // The draft's customer as a full DTO (quick vehicle owner, owned vehicles).
  useEffect(() => {
    if (!customerId) {
      setSelected(null);
      setOwned([]);
      return;
    }
    let current = true;
    window.bengkelin.customers
      .get({ id: customerId })
      .then((result) => {
        if (!current) return;
        if (result.ok) {
          setSelected(result.value.customer);
          setOwned(result.value.vehicles);
        }
      })
      .catch(() => {
        if (current) setError(t('errors.INTERNAL_ERROR'));
      });
    return () => {
      current = false;
    };
  }, [customerId, setError, t]);

  const loadCustomers = useCallback(
    async (query: string, include: boolean) => {
      const version = ++searchVersion.current;
      try {
        const result = await window.bengkelin.customers.search({
          query,
          includeInactive: include,
        });
        if (version === searchVersion.current && check(result))
          setCustomers(result.value.results);
      } catch {
        if (version === searchVersion.current)
          setError(t('errors.INTERNAL_ERROR'));
      }
    },
    [check, setError, t],
  );

  useEffect(() => {
    if (!customerQuery) {
      void loadCustomers('', includeInactiveRef.current);
      return () => {
        ++searchVersion.current;
      };
    }
    const timer = window.setTimeout(
      () => void loadCustomers(customerQuery, includeInactiveRef.current),
      250,
    );
    return () => {
      window.clearTimeout(timer);
      ++searchVersion.current;
    };
  }, [customerQuery, loadCustomers]);

  useEffect(() => {
    const version = ++plateVersion.current;
    if (!plateQuery.trim()) {
      setPlates(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void window.bengkelin.vehicles
        .searchByPlate({ query: plateQuery })
        .then((result) => {
          if (version === plateVersion.current && check(result))
            setPlates(result.value.results);
        })
        .catch(() => {
          if (version === plateVersion.current)
            setError(t('errors.INTERNAL_ERROR'));
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      ++plateVersion.current;
    };
  }, [plateQuery, check, setError, t]);

  function walkIn() {
    void run(async () => {
      if (check(await clearParty())) onClose();
    });
  }

  function chooseCustomer(customer: CustomerDto | null) {
    void run(async () => {
      await selectCustomer(customer?.id ?? null);
    });
  }

  function chooseVehicle(vehicle: VehicleDto | null) {
    void run(async () => {
      await selectVehicle(vehicle?.id ?? null);
    });
  }

  return (
    <Dialog
      title={t('workspace.party.title')}
      description={
        <p className="-mt-3" data-testid="party-current">
          {t('workspace.party.current')}:{' '}
          <strong>
            {view.customer
              ? customerLabel(t, view.customer)
              : t('workspace.header.anonymous')}
          </strong>
          {view.vehicle ? ` · ${view.vehicle.plateNumber}` : ''}
        </p>
      }
      onClose={onClose}
      initialFocus={searchRef}
      closeLabel={t('workspace.common.close')}
      className="max-w-3xl"
      scrollBody
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={walkIn}>
            {t('workspace.party.anonymous')}
          </Button>
          <Button onClick={onClose}>{t('workspace.party.done')}</Button>
        </div>
      }
    >
      <div className="shrink-0">{error ? <Alert>{error}</Alert> : null}</div>

      <div className="grid min-h-0 flex-1 grid-rows-2 gap-4 overflow-hidden md:grid-cols-2 md:grid-rows-1">
        <section
          aria-label={t('workspace.party.customers')}
          className="flex min-h-0 flex-col gap-2 overflow-hidden"
        >
          <h3 className="text-sm font-semibold">
            {t('workspace.party.customers')}
          </h3>
          <div className="flex shrink-0 gap-2" role="search">
            <Label htmlFor="party-customer-search" className="sr-only">
              {t('workspace.party.customerSearch')}
            </Label>
            <Input
              id="party-customer-search"
              className="mx-1"
              ref={searchRef}
              placeholder={t('workspace.party.customerSearch')}
              value={customerQuery}
              onChange={(event) => setCustomerQuery(event.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => {
                const include = e.target.checked;
                includeInactiveRef.current = include;
                setIncludeInactive(include);
                void loadCustomers(customerQuery, include);
              }}
            />
            {t('workspace.party.showInactive')}
          </label>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-1">
            {customers ? (
              customers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('workspace.party.noResults')}
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {customers.map((customer) => (
                    <li
                      key={customer.id}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span>
                        {customerLabel(t, customer)}
                        {!customer.isActive
                          ? ` · ${t('customers.inactive')}`
                          : ''}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${t('workspace.party.select')}: ${customerLabel(t, customer)}`}
                        onClick={() => chooseCustomer(customer)}
                      >
                        {t('workspace.party.select')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
            <QuickCustomerForm
              onSelected={(customer) => chooseCustomer(customer)}
            />
          </div>
        </section>

        <section
          aria-label={t('workspace.party.vehicles')}
          className="flex min-h-0 flex-col gap-2 overflow-hidden"
        >
          <h3 className="text-sm font-semibold">
            {t('workspace.party.vehicles')}
          </h3>
          <div className="flex shrink-0 gap-2" role="search">
            <Label htmlFor="party-plate-search" className="sr-only">
              {t('workspace.party.plateSearch')}
            </Label>
            <Input
              id="party-plate-search"
              className="mx-1"
              placeholder={t('workspace.party.plateSearch')}
              value={plateQuery}
              onChange={(event) => setPlateQuery(event.target.value)}
            />
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-1">
            {selected && owned.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="text-xs text-muted-foreground">
                  {t('workspace.party.ownedBy', {
                    name: customerName(t, selected),
                  })}
                </p>
                <ul className="flex flex-col gap-1">
                  {owned.map((vehicle) => (
                    <li
                      key={vehicle.id}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span>{vehicleText(vehicle)}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${t('workspace.party.select')}: ${vehicle.plateNumber}`}
                        onClick={() => chooseVehicle(vehicle)}
                      >
                        {t('workspace.party.select')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {plates ? (
              plates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('workspace.party.noResults')}
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {plates.map((vehicle) => (
                    <li
                      key={vehicle.id}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span>
                        {vehicleText(vehicle)}
                        <span className="block text-xs text-muted-foreground">
                          {t('workspace.party.owner')}:{' '}
                          {vehicle.activeOwner
                            ? customerLabel(t, vehicle.activeOwner)
                            : t('workspace.party.noOwner')}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${t('workspace.party.select')}: ${vehicle.plateNumber}`}
                        onClick={() => chooseVehicle(vehicle)}
                      >
                        {t('workspace.party.select')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
            {view.vehicle ? (
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => chooseVehicle(null)}
              >
                {t('workspace.party.noVehicle')}
              </Button>
            ) : null}
            <QuickVehicleForm
              customer={selected}
              onSelected={(vehicle) => chooseVehicle(vehicle)}
            />
          </div>
        </section>
      </div>
    </Dialog>
  );
}
