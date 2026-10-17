import { Search } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
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

interface CustomerVehicleDialogProps {
  view: DraftView;
  selectCustomer(customerId: string | null): Promise<boolean>;
  selectVehicle(vehicleId: string | null): Promise<boolean>;
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
  onClose,
}: CustomerVehicleDialogProps) {
  const { t } = useTranslation();
  const searchRef = useRef<HTMLInputElement>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const searchVersion = useRef(0);
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
    void loadCustomers('', false);
    return () => {
      ++searchVersion.current;
    };
  }, [loadCustomers]);

  function searchCustomers(event: FormEvent) {
    event.preventDefault();
    void loadCustomers(customerQuery, includeInactive);
  }

  function searchPlates(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result = await window.bengkelin.vehicles.searchByPlate({
        query: plateQuery,
      });
      if (check(result)) setPlates(result.value.results);
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
      onClose={onClose}
      initialFocus={searchRef}
      closeLabel={t('workspace.common.close')}
      className="max-w-3xl"
      scrollBody
      footer={
        <div className="flex justify-end border-t border-border pt-3">
          <Button onClick={onClose}>{t('workspace.party.done')}</Button>
        </div>
      }
    >
      {error ? <Alert>{error}</Alert> : null}
      <p className="text-sm" data-testid="party-current">
        {t('workspace.party.current')}:{' '}
        <strong>
          {view.customer
            ? customerLabel(t, view.customer)
            : t('workspace.header.anonymous')}
        </strong>
        {view.vehicle ? ` · ${view.vehicle.plateNumber}` : ''}
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <section
          aria-label={t('workspace.party.customers')}
          className="flex flex-col gap-2"
        >
          <h3 className="text-sm font-semibold">
            {t('workspace.party.customers')}
          </h3>
          <form onSubmit={searchCustomers} className="flex gap-2" role="search">
            <Label htmlFor="party-customer-search" className="sr-only">
              {t('workspace.party.customerSearch')}
            </Label>
            <Input
              id="party-customer-search"
              ref={searchRef}
              placeholder={t('workspace.party.customerSearch')}
              value={customerQuery}
              onChange={(event) => setCustomerQuery(event.target.value)}
            />
            <Button type="submit" variant="outline">
              <Search aria-hidden="true" />
              <span className="sr-only">{t('workspace.party.search')}</span>
            </Button>
          </form>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => {
                const include = e.target.checked;
                setIncludeInactive(include);
                void loadCustomers(customerQuery, include);
              }}
            />
            {t('workspace.party.showInactive')}
          </label>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => chooseCustomer(null)}
          >
            {t('workspace.party.anonymous')}
          </Button>
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
        </section>

        <section
          aria-label={t('workspace.party.vehicles')}
          className="flex flex-col gap-2"
        >
          <h3 className="text-sm font-semibold">
            {t('workspace.party.vehicles')}
          </h3>
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
          <form onSubmit={searchPlates} className="flex gap-2" role="search">
            <Label htmlFor="party-plate-search" className="sr-only">
              {t('workspace.party.plateSearch')}
            </Label>
            <Input
              id="party-plate-search"
              placeholder={t('workspace.party.plateSearch')}
              value={plateQuery}
              onChange={(event) => setPlateQuery(event.target.value)}
            />
            <Button type="submit" variant="outline">
              <Search aria-hidden="true" />
              <span className="sr-only">{t('workspace.party.search')}</span>
            </Button>
          </form>
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
        </section>
      </div>
    </Dialog>
  );
}
