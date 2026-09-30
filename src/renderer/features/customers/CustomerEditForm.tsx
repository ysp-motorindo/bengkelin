import { useState, type FormEvent } from 'react';
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
import { useAction } from '@/renderer/lib/use-action';
import type { CustomerDto } from '@/shared/contracts';
import { customerLabel } from './labels';

const FIELDS = [
  'name',
  'phoneNumber',
  'email',
  'birthdate',
  'address',
  'rt',
  'rw',
  'kelurahan',
  'kecamatan',
  'cityOrRegency',
  'province',
  'postalCode',
] as const;
type Field = (typeof FIELDS)[number];
type Values = Record<Field, string>;

const LABEL_KEYS: Record<Field, string> = {
  name: 'customers.edit.name',
  phoneNumber: 'customers.edit.phone',
  email: 'customers.edit.email',
  birthdate: 'customers.edit.birthdate',
  address: 'customers.edit.address',
  rt: 'customers.edit.rt',
  rw: 'customers.edit.rw',
  kelurahan: 'customers.edit.kelurahan',
  kecamatan: 'customers.edit.kecamatan',
  cityOrRegency: 'customers.edit.cityOrRegency',
  province: 'customers.edit.province',
  postalCode: 'customers.edit.postalCode',
};

const INPUT_TYPES: Partial<Record<Field, string>> = {
  phoneNumber: 'tel',
  email: 'email',
  birthdate: 'date',
};

/** Fields laid out two per row, except the ones that need the full width. */
const WIDE: ReadonlySet<Field> = new Set(['name', 'address']);

/**
 * The complete customer form (spec 6, T5 carry): every field, maintained
 * separately from the quick checkout form. A phone already used by another
 * customer asks before saving, as in quick creation.
 */
export function CustomerEditForm({
  customer,
  onSaved,
  onCancel,
}: {
  customer: CustomerDto;
  onSaved(customer: CustomerDto): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Values>(
    () =>
      Object.fromEntries(
        FIELDS.map((field) => [field, customer[field] ?? '']),
      ) as Values,
  );
  const [duplicates, setDuplicates] = useState<CustomerDto[] | null>(null);
  const { busy, error, fieldErrors, run, check } = useAction();

  function save(acknowledgeDuplicates: boolean) {
    void run(async () => {
      const result = await window.bengkelin.customers.save({
        id: customer.id,
        ...values,
        ...(acknowledgeDuplicates ? { acknowledgeDuplicates: true } : {}),
      });
      if (!check(result)) return;
      if (!result.value.saved) {
        setDuplicates(result.value.warning.matches);
        return;
      }
      setDuplicates(null);
      onSaved(result.value.customer);
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    save(false);
  }

  return (
    <Card>
      <form noValidate onSubmit={submit} aria-label={t('customers.edit.title')}>
        <CardHeader>
          <CardTitle className="text-base">
            {t('customers.edit.title')}: {customerLabel(t, customer)}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error ? <Alert>{error}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map((field) => (
              <div
                key={field}
                className={WIDE.has(field) ? 'sm:col-span-2' : ''}
              >
                <FormField
                  label={t(LABEL_KEYS[field])}
                  error={fieldErrors[field]}
                >
                  <Input
                    type={INPUT_TYPES[field] ?? 'text'}
                    autoComplete="off"
                    value={values[field]}
                    onChange={(e) => {
                      const next = e.target.value;
                      setValues((current) => ({ ...current, [field]: next }));
                      if (field === 'phoneNumber') setDuplicates(null);
                    }}
                  />
                </FormField>
              </div>
            ))}
          </div>
          {duplicates ? (
            <div
              role="group"
              aria-label={t('customers.duplicate.title')}
              className="flex flex-col gap-2 rounded-md border border-border p-3"
            >
              <p className="font-medium">{t('customers.duplicate.title')}</p>
              <ul className="text-sm">
                {duplicates.map((match) => (
                  <li key={match.id}>{customerLabel(t, match)}</li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => save(true)}>
                  {t('customers.duplicate.acknowledge')}
                </Button>
                <Button variant="ghost" onClick={() => setDuplicates(null)}>
                  {t('customers.duplicate.cancel')}
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? t('common.saving') : t('customers.edit.submit')}
            </Button>
            <Button variant="outline" onClick={onCancel}>
              {t('customers.edit.cancel')}
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
