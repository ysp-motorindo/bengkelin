import { formatDisplayDateTime } from '@/renderer/lib/date-format';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/renderer/components/ui/card';
import { useAction } from '@/renderer/lib/use-action';
import type { CustomerDto, Role, VehicleDetailDto } from '@/shared/contracts';
import { detectOwnerMismatch } from '@/shared/ownership';
import { customerLabel, customerName } from './labels';

interface VehicleDetailProps {
  detail: VehicleDetailDto;
  /** The customer picked in this screen (never changes ownership by itself). */
  customer: CustomerDto | null;
  /** ADMIN may deactivate/reactivate the vehicle (T5 carry). */
  role?: Role;
  /** The vehicle changed here (ownership transfer or active status). */
  onTransferred(detail: VehicleDetailDto): void;
}

/** Vehicle, current owner, history, owner-mismatch warning and explicit transfer. */
export function VehicleDetail({
  detail,
  customer,
  role = 'CASHIER',
  onTransferred,
}: VehicleDetailProps) {
  const { t } = useTranslation();
  const { vehicle, ownerships } = detail;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const { busy, error, run, check } = useAction();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);

  // Reset when another vehicle is shown.
  useEffect(() => {
    setConfirming(false);
    setDone(false);
  }, [vehicle.id]);

  // Keyboard users land on the safe choice when the confirmation opens.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  const mismatch = detectOwnerMismatch(
    vehicle.activeOwnerId,
    customer?.id ?? null,
  );
  const canTransfer =
    customer !== null && vehicle.activeOwnerId !== customer.id;

  function cancel() {
    setConfirming(false);
    // Return focus to the control that opened the confirmation.
    setTimeout(() => openRef.current?.focus(), 0);
  }

  function confirm() {
    if (!customer) return;
    void run(async () => {
      const result = await window.bengkelin.vehicles.transferOwnership({
        vehicleId: vehicle.id,
        newCustomerId: customer.id,
      });
      if (!check(result)) {
        setConfirming(false);
        return;
      }
      setConfirming(false);
      setDone(true);
      onTransferred(result.value);
    });
  }

  function toggleActive() {
    void run(async () => {
      const call = vehicle.isActive
        ? window.bengkelin.vehicles.deactivate
        : window.bengkelin.vehicles.reactivate;
      const result = await call({ id: vehicle.id });
      if (check(result)) onTransferred({ ...detail, vehicle: result.value });
    });
  }

  const model = [vehicle.brandName, vehicle.modelName]
    .filter(Boolean)
    .join(' ');

  return (
    <Card aria-label={t('customers.vehicle.detail')} role="region">
      <CardHeader>
        <CardTitle>
          {t('customers.vehicle.detail')}:{' '}
          <span data-testid="vehicle-plate">{vehicle.plateNumber}</span>
        </CardTitle>
        {model ? (
          <p className="text-sm text-muted-foreground">{model}</p>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? <Alert>{error}</Alert> : null}
        {!vehicle.isActive ? (
          <p
            data-testid="vehicle-inactive"
            className="rounded-md border border-warning/50 bg-warning-surface px-3 py-2 text-sm"
          >
            <span className="font-medium">
              {t('customers.vehicle.inactive')}:
            </span>{' '}
            {t('customers.vehicle.inactiveNote')}
          </p>
        ) : null}
        {role === 'ADMIN' ? (
          <div>
            <Button
              variant={vehicle.isActive ? 'destructive-outline' : 'outline'}
              size="sm"
              disabled={busy}
              onClick={toggleActive}
            >
              {t(
                vehicle.isActive
                  ? 'customers.vehicle.deactivate'
                  : 'customers.vehicle.reactivate',
              )}
            </Button>
          </div>
        ) : null}
        {done ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('customers.transfer.done')}
          </p>
        ) : null}
        <p>
          <span className="text-sm text-muted-foreground">
            {t('customers.vehicle.owner')}:{' '}
          </span>
          <span data-testid="active-owner" className="font-medium">
            {vehicle.activeOwner
              ? customerLabel(t, vehicle.activeOwner)
              : t('customers.vehicle.noOwner')}
          </span>
        </p>

        {mismatch && customer && vehicle.activeOwner ? (
          <Alert data-testid="owner-mismatch">
            {t('customers.mismatch', {
              owner: customerName(t, vehicle.activeOwner),
              customer: customerName(t, customer),
            })}
          </Alert>
        ) : null}

        {canTransfer && customer && !confirming ? (
          <div>
            <Button
              ref={openRef}
              variant="outline"
              onClick={() => setConfirming(true)}
            >
              {t('customers.transfer.action', {
                name: customerName(t, customer),
              })}
            </Button>
          </div>
        ) : null}

        {confirming && customer ? (
          <div
            role="alertdialog"
            aria-labelledby="transfer-title"
            aria-describedby="transfer-body"
            className="flex flex-col gap-2 rounded-md border border-border p-3"
          >
            <p id="transfer-title" className="font-medium">
              {t('customers.transfer.confirmTitle')}
            </p>
            <p id="transfer-body" className="text-sm">
              {t('customers.transfer.confirmBody', {
                plate: vehicle.plateNumber,
                name: customerName(t, customer),
              })}
            </p>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={confirm}>
                {t('customers.transfer.confirm')}
              </Button>
              <Button
                ref={cancelRef}
                variant="outline"
                disabled={busy}
                onClick={cancel}
              >
                {t('customers.transfer.cancel')}
              </Button>
            </div>
          </div>
        ) : null}

        <section aria-label={t('customers.vehicle.history')}>
          <h3 className="mb-1 text-sm font-medium">
            {t('customers.vehicle.history')}
          </h3>
          {ownerships.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('customers.vehicle.noOwner')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {ownerships.map((ownership) => (
                <li key={ownership.id} data-testid="ownership-row">
                  {customerLabel(t, {
                    name: ownership.customerName,
                    phoneNumber: ownership.customerPhone,
                  })}{' '}
                  <span className="text-muted-foreground">
                    ({t('customers.vehicle.from')}{' '}
                    {formatDisplayDateTime(ownership.effectiveFrom, timezone)},{' '}
                    {t('customers.vehicle.until')}{' '}
                    {ownership.effectiveUntil
                      ? formatDisplayDateTime(
                          ownership.effectiveUntil,
                          timezone,
                        )
                      : t('customers.vehicle.current')}
                    )
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
