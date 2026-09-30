import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/renderer/components/ui/card';
import { Input } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { useAction } from '@/renderer/lib/use-action';
import type { CustomerDto, ReferenceDto, VehicleDto } from '@/shared/contracts';
import { customerName } from './labels';

interface QuickVehicleFormProps {
  /** The selected customer becomes the first owner of a NEW vehicle. */
  customer: CustomerDto | null;
  onSelected(vehicle: VehicleDto): void;
}

/** Quick vehicle creation with brand/model pickers (spec 7, 51). */
export function QuickVehicleForm({
  customer,
  onSelected,
}: QuickVehicleFormProps) {
  const { t } = useTranslation();
  const [plate, setPlate] = useState('');
  const [brandId, setBrandId] = useState('');
  const [modelId, setModelId] = useState('');
  const [brands, setBrands] = useState<ReferenceDto[]>([]);
  const [models, setModels] = useState<ReferenceDto[]>([]);
  const [existing, setExisting] = useState<VehicleDto | null>(null);
  const { busy, error, fieldErrors, setError, run, check } = useAction();

  useEffect(() => {
    let current = true;
    window.bengkelin.references
      .listActive({ entity: 'vehicleBrand' })
      .then((result) => {
        if (current && result.ok) setBrands(result.value);
      })
      .catch(() => {
        if (current) setError(t('errors.INTERNAL_ERROR'));
      });
    return () => {
      current = false;
    };
  }, [setError, t]);

  useEffect(() => {
    setModelId('');
    if (!brandId) {
      setModels([]);
      return;
    }
    let current = true;
    window.bengkelin.references
      .listActive({ entity: 'vehicleModel', brandId })
      .then((result) => {
        if (current && result.ok) setModels(result.value);
      })
      .catch(() => {
        if (current) setError(t('errors.INTERNAL_ERROR'));
      });
    return () => {
      current = false;
    };
  }, [brandId, setError, t]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result = await window.bengkelin.vehicles.save({
        plateNumber: plate,
        brandId: brandId || null,
        vehicleModelId: modelId || null,
        ownerCustomerId: customer?.id ?? null,
      });
      if (!check(result)) return;
      if (result.value.reusedExisting) {
        setExisting(result.value.vehicle);
        return;
      }
      setPlate('');
      setBrandId('');
      onSelected(result.value.vehicle);
    });
  }

  return (
    <Card>
      <form
        onSubmit={submit}
        noValidate
        aria-label={t('customers.quickVehicle.title')}
      >
        <CardHeader>
          <CardTitle className="text-base">
            {t('customers.quickVehicle.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error ? <Alert>{error}</Alert> : null}
          <FormField
            label={t('customers.quickVehicle.plate')}
            error={fieldErrors.plateNumber}
          >
            <Input
              autoComplete="off"
              value={plate}
              onChange={(e) => {
                setPlate(e.target.value);
                setExisting(null);
              }}
            />
          </FormField>
          <FormField label={t('customers.quickVehicle.brand')}>
            <Select
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
            >
              <option value="">{t('customers.quickVehicle.noBrand')}</option>
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label={t('customers.quickVehicle.model')}
            error={fieldErrors.vehicleModelId}
          >
            <Select
              value={modelId}
              disabled={!brandId}
              onChange={(e) => setModelId(e.target.value)}
            >
              <option value="">{t('customers.quickVehicle.noModel')}</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </Select>
          </FormField>
          <p className="text-sm text-muted-foreground">
            {customer
              ? t('customers.quickVehicle.ownerWill', {
                  name: customerName(t, customer),
                })
              : t('customers.quickVehicle.ownerNone')}
          </p>
          {existing ? (
            <div
              role="group"
              aria-label={t('customers.plateExists.title')}
              className="flex flex-col gap-2 rounded-md border border-border p-3"
            >
              <p className="font-medium">{t('customers.plateExists.title')}</p>
              <p className="text-sm text-muted-foreground">
                {t('customers.plateExists.description')} ({existing.plateNumber}
                )
              </p>
              <Button
                onClick={() => {
                  const vehicle = existing;
                  setExisting(null);
                  setPlate('');
                  onSelected(vehicle);
                }}
              >
                {t('customers.plateExists.use')}
              </Button>
            </div>
          ) : (
            <Button type="submit" disabled={busy}>
              {busy ? t('common.saving') : t('customers.quickVehicle.submit')}
            </Button>
          )}
        </CardContent>
      </form>
    </Card>
  );
}
