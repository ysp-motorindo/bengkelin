import { Check, X } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
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
  onClose?: () => void;
  returnFocus?: () => void;
  /** Called with the new customer, or an existing one the cashier chose to reuse. */
  onSelected(customer: CustomerDto): void;
}

/** Quick creation (spec 6, 51): name and phone only. */
export function QuickCustomerForm({
  onSelected,
  onClose,
  returnFocus,
}: QuickCustomerFormProps) {
  const { t } = useTranslation();
  const formId = useId();
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

  const action = matches ? (
    <Button disabled={busy} onClick={() => save(true)}>
      {onClose ? <Check aria-hidden="true" /> : null}
      {t('customers.duplicate.acknowledge')}
    </Button>
  ) : (
    <Button type="submit" form={formId} disabled={busy}>
      {onClose ? <Check aria-hidden="true" /> : null}
      {busy ? t('common.saving') : t('customers.quickCustomer.submit')}
    </Button>
  );

  const Content = onClose ? 'div' : CardContent;
  const form = (
    <form
      id={formId}
      onSubmit={submit}
      noValidate
      aria-label={t('customers.quickCustomer.title')}
    >
      {!onClose ? (
        <CardHeader>
          <CardTitle>{t('customers.quickCustomer.title')}</CardTitle>
        </CardHeader>
      ) : null}
      <Content className="flex flex-col gap-3">
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
              {!onClose ? action : null}
              <Button variant="ghost" onClick={() => setMatches(null)}>
                {t('customers.duplicate.cancel')}
              </Button>
            </div>
          </div>
        ) : !onClose ? (
          action
        ) : null}
      </Content>
    </form>
  );
  if (!onClose) return <Card>{form}</Card>;
  return (
    <Dialog
      title={t('workspace.party.createCustomer')}
      onClose={onClose}
      returnFocus={returnFocus}
      closeLabel={t('workspace.common.close')}
      footer={
        <DialogActions
          secondary={
            <Button variant="outline" onClick={onClose}>
              <X aria-hidden="true" />
              {t('workspace.common.cancel')}
            </Button>
          }
        >
          {action}
        </DialogActions>
      }
    >
      {form}
    </Dialog>
  );
}
