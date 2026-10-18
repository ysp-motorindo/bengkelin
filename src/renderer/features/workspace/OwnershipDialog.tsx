import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { VehicleDetail } from '@/renderer/features/customers/VehicleDetail';
import { watchSessionError } from '@/renderer/lib/session-events';
import type { CustomerDto, VehicleDetailDto } from '@/shared/contracts';

interface OwnershipDialogProps {
  vehicleId: string;
  customerId: string;
  /** After an explicit transfer: re-read the draft (ownerMismatch changes). */
  onTransferred(): void;
  onClose(): void;
}

/**
 * The explicit ownership transfer action from T5, reached from the draft's
 * owner-mismatch warning. Nothing changes unless the cashier confirms.
 */
export function OwnershipDialog({
  vehicleId,
  customerId,
  onTransferred,
  onClose,
}: OwnershipDialogProps) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<VehicleDetailDto | null>(null);
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    Promise.all([
      window.bengkelin.vehicles.get({ id: vehicleId }),
      window.bengkelin.customers.get({ id: customerId }),
    ])
      .then(([vehicle, owner]) => {
        if (!current) return;
        if (!vehicle.ok || !owner.ok) {
          if (!vehicle.ok) watchSessionError(vehicle.error);
          setFailed(true);
          return;
        }
        setDetail(vehicle.value);
        setCustomer(owner.value.customer);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [vehicleId, customerId]);

  return (
    <Dialog
      title={t('workspace.ownership.title')}
      onClose={onClose}
      closeLabel={t('workspace.common.close')}
      footer={
        <DialogActions
          secondary={
            <Button variant="outline" onClick={onClose}>
              <X aria-hidden="true" />
              {t('workspace.common.close')}
            </Button>
          }
        />
      }
    >
      {failed ? <Alert>{t('errors.LOAD_FAILED')}</Alert> : null}
      {detail ? (
        <VehicleDetail
          detail={detail}
          customer={customer}
          onTransferred={(next) => {
            setDetail(next);
            onTransferred();
          }}
        />
      ) : failed ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      )}
    </Dialog>
  );
}
