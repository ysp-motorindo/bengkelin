import { X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { useAction } from '@/renderer/lib/use-action';
import type {
  CustomerDto,
  VehicleDetailDto,
  VehicleDto,
} from '@/shared/contracts';
import { QuickCustomerForm } from './QuickCustomerForm';
import { QuickVehicleForm } from './QuickVehicleForm';
import { VehicleDetail } from './VehicleDetail';
import { customerLabel, customerName } from './labels';

interface Results {
  customers: CustomerDto[];
  vehicles: VehicleDto[];
}

/**
 * "Pelanggan & Kendaraan": search by name/phone/plate, quick creation, vehicle
 * detail with owner history and an explicit transfer. Selecting a customer and
 * a vehicle never changes ownership; the transfer is its own confirmed action.
 * (Checkout-time use of this arrives with the draft workspace.)
 */
export function CustomersScreen() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [owned, setOwned] = useState<VehicleDto[]>([]);
  const [detail, setDetail] = useState<VehicleDetailDto | null>(null);
  const { busy, error, run, check } = useAction();

  function search(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const [customers, vehicles] = await Promise.all([
        window.bengkelin.customers.search({ query }),
        window.bengkelin.vehicles.searchByPlate({ query }),
      ]);
      if (!check(customers) || !check(vehicles)) return;
      setResults({
        customers: customers.value.results,
        vehicles: vehicles.value.results,
      });
    });
  }

  function selectCustomer(next: CustomerDto) {
    setCustomer(next);
    void refreshOwned(next.id);
  }

  async function refreshOwned(customerId: string) {
    const result = await window.bengkelin.customers.get({ id: customerId });
    if (result.ok) setOwned(result.value.vehicles);
  }

  function showVehicle(vehicle: VehicleDto) {
    void run(async () => {
      const result = await window.bengkelin.vehicles.get({ id: vehicle.id });
      if (check(result)) setDetail(result.value);
    });
  }

  function clearCustomer() {
    setCustomer(null);
    setOwned([]);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">{t('customers.title')}</h1>
        {error ? <Alert>{error}</Alert> : null}

        <form onSubmit={search} className="flex items-end gap-2" role="search">
          <div className="flex-1">
            <FormField label={t('customers.search.label')}>
              <Input
                autoComplete="off"
                placeholder={t('customers.search.placeholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </FormField>
          </div>
          <Button type="submit" disabled={busy}>
            {t('customers.search.submit')}
          </Button>
        </form>

        {customer ? (
          <div
            data-testid="selected-customer"
            className="flex items-center justify-between gap-2 rounded-md border border-border bg-card p-3"
          >
            <p>
              <span className="text-sm text-muted-foreground">
                {t('customers.customer.selected')}:{' '}
              </span>
              <span className="font-medium">{customerLabel(t, customer)}</span>
            </p>
            <Button variant="ghost" size="sm" onClick={clearCustomer}>
              <X aria-hidden="true" />
              {t('customers.customer.clear')}
            </Button>
          </div>
        ) : null}

        {customer ? (
          <section aria-label={t('customers.customer.vehicles')}>
            <h2 className="mb-1 text-sm font-medium">
              {t('customers.customer.vehicles')}
            </h2>
            {owned.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('customers.customer.noVehicles')}
              </p>
            ) : (
              <VehicleList vehicles={owned} onShow={showVehicle} />
            )}
          </section>
        ) : null}

        {results ? (
          <div className="grid gap-4 md:grid-cols-2">
            <section aria-label={t('customers.search.customers')}>
              <h2 className="mb-1 text-sm font-medium">
                {t('customers.search.customers')}
              </h2>
              {results.customers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('customers.search.none')}
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {results.customers.map((row) => (
                    <li
                      key={row.id}
                      data-testid="customer-result"
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-card p-2 text-sm"
                    >
                      <span>{customerLabel(t, row)}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`${t('customers.customer.select')}: ${customerName(t, row)}`}
                        onClick={() => selectCustomer(row)}
                      >
                        {t('customers.customer.select')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label={t('customers.search.vehicles')}>
              <h2 className="mb-1 text-sm font-medium">
                {t('customers.search.vehicles')}
              </h2>
              {results.vehicles.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('customers.search.none')}
                </p>
              ) : (
                <VehicleList vehicles={results.vehicles} onShow={showVehicle} />
              )}
            </section>
          </div>
        ) : null}

        {detail ? (
          <VehicleDetail
            detail={detail}
            customer={customer}
            onTransferred={(next) => {
              setDetail(next);
              setResults((current) =>
                current
                  ? {
                      ...current,
                      vehicles: current.vehicles.map((v) =>
                        v.id === next.vehicle.id ? next.vehicle : v,
                      ),
                    }
                  : current,
              );
              if (customer) void refreshOwned(customer.id);
            }}
          />
        ) : null}
      </div>

      <div className="flex flex-col gap-4">
        <QuickCustomerForm onSelected={selectCustomer} />
        <QuickVehicleForm customer={customer} onSelected={showVehicle} />
      </div>
    </div>
  );
}

function VehicleList({
  vehicles,
  onShow,
}: {
  vehicles: VehicleDto[];
  onShow(vehicle: VehicleDto): void;
}) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-1">
      {vehicles.map((vehicle) => (
        <li
          key={vehicle.id}
          data-testid="vehicle-result"
          className="flex items-center justify-between gap-2 rounded-md border border-border bg-card p-2 text-sm"
        >
          <span>
            <span className="font-medium">{vehicle.plateNumber}</span>
            {vehicle.brandName ? ` ${vehicle.brandName}` : ''}
            {vehicle.modelName ? ` ${vehicle.modelName}` : ''}
            <span className="text-muted-foreground">
              {' - '}
              {vehicle.activeOwner
                ? customerName(t, vehicle.activeOwner)
                : t('customers.vehicle.noOwner')}
            </span>
          </span>
          <Button
            variant="outline"
            size="sm"
            aria-label={`${t('customers.vehicle.select')}: ${vehicle.plateNumber}`}
            onClick={() => onShow(vehicle)}
          >
            {t('customers.vehicle.select')}
          </Button>
        </li>
      ))}
    </ul>
  );
}
