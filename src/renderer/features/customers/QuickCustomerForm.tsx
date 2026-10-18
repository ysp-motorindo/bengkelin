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

interface QuickCustomerFormProps {
  /** Called with the new customer, or an existing one the cashier chose to reuse. */
  onSelected(customer: CustomerDto): void;
}

/** Quick creation (spec 6, 51): name and phone only. */
export function QuickCustomerForm({ onSelected }: QuickCustomerFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [matches, setMatches] = useState<CustomerDto[] | null>(null);
  const { busy, error, fieldErrors, run, check } = useAction();

  function save(acknowledgeDuplicates: boolean) {
    void run(async () => {
      const result = await window.bengkelin.customers.save({
        name,
        phoneNumber: phone,
        ...(acknowledgeDuplicates ? { acknowledgeDuplicates: true } : {}),
      });
      if (!check(result)) return;
      if (!result.value.saved) {
        setMatches(result.value.warning.matches);
        return;
      }
      setMatches(null);
      setName('');
      setPhone('');
      onSelected(result.value.customer);
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    save(false);
  }

  return (
    <Card>
      <form
        onSubmit={submit}
        noValidate
        aria-label={t('customers.quickCustomer.title')}
      >
        <CardHeader>
          <CardTitle>{t('customers.quickCustomer.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error ? <Alert>{error}</Alert> : null}
          <FormField
            label={t('customers.quickCustomer.name')}
            error={fieldErrors.name}
          >
            <Input
              autoComplete="off"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setMatches(null);
              }}
            />
          </FormField>
          <FormField
            label={t('customers.quickCustomer.phone')}
            error={fieldErrors.phoneNumber}
            hint={t('customers.quickCustomer.hint')}
          >
            <Input
              type="tel"
              autoComplete="off"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                setMatches(null);
              }}
            />
          </FormField>
          {matches ? (
            <div
              role="group"
              aria-label={t('customers.duplicate.title')}
              className="flex flex-col gap-2 rounded-md border border-border p-3"
            >
              <p className="font-medium">{t('customers.duplicate.title')}</p>
              <p className="text-sm text-muted-foreground">
                {t('customers.duplicate.description')}
              </p>
              <ul className="flex flex-col gap-1">
                {matches.map((match) => (
                  <li
                    key={match.id}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span>{customerLabel(t, match)}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setMatches(null);
                        onSelected(match);
                      }}
                    >
                      {t('customers.duplicate.use')}
                    </Button>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => save(true)}>
                  {t('customers.duplicate.acknowledge')}
                </Button>
                <Button variant="ghost" onClick={() => setMatches(null)}>
                  {t('customers.duplicate.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button type="submit" disabled={busy}>
              {busy ? t('common.saving') : t('customers.quickCustomer.submit')}
            </Button>
          )}
        </CardContent>
      </form>
    </Card>
  );
}
