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
import type { CustomerDto, VehicleDetailDto } from '@/shared/contracts';
import { detectOwnerMismatch } from '@/shared/ownership';
import { customerLabel, customerName } from './labels';

interface VehicleDetailProps {
  detail: VehicleDetailDto;
  /** The customer picked in this screen (never changes ownership by itself). */
  customer: CustomerDto | null;
  onTransferred(detail: VehicleDetailDto): void;
}

/** Vehicle, current owner, history, owner-mismatch warning and explicit transfer. */
export function VehicleDetail({
  detail,
  customer,
  onTransferred,
}: VehicleDetailProps) {
  const { t } = useTranslation();
  const { vehicle, ownerships } = detail;
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

  const model = [vehicle.brandName, vehicle.modelName]
    .filter(Boolean)
    .join(' ');

  return (
    <Card aria-label={t('customers.vehicle.detail')} role="region">
      <CardHeader>
        <CardTitle className="text-base">
          {t('customers.vehicle.detail')}:{' '}
          <span data-testid="vehicle-plate">{vehicle.plateNumber}</span>
        </CardTitle>
        {model ? (
          <p className="text-sm text-muted-foreground">{model}</p>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? <Alert>{error}</Alert> : null}
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
                    {new Date(ownership.effectiveFrom).toLocaleString()},{' '}
                    {t('customers.vehicle.until')}{' '}
                    {ownership.effectiveUntil
                      ? new Date(ownership.effectiveUntil).toLocaleString()
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
