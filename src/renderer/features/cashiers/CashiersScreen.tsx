import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
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
import {
  APPEARANCES,
  LANGUAGES,
  type Appearance,
  type CashierDto,
  type Language,
  type PreferencesInput,
  type Role,
} from '@/shared/contracts';
import { CashierManageDialog } from './CashierManageDialog';

/**
 * ADMIN cashier management (spec 4, 55) over the T4 services: list,
 * create, rename, change role, deactivate/reactivate and reset password.
 * Cashiers are never deleted. Main enforces ADMIN and protects the last
 * active ADMIN (LAST_ACTIVE_ADMIN is shown as an alert).
 */
export function CashiersScreen({
  defaultPreferences = {
    language: 'id',
    appearance: 'SYSTEM',
    numberFormat: 'ID',
  },
}: {
  defaultPreferences?: PreferencesInput;
}) {
  const { t } = useTranslation();
  const [cashiers, setCashiers] = useState<CashierDto[]>([]);
  const [managing, setManaging] = useState<CashierDto | null>(null);
  const { error, run, check } = useAction();

  useEffect(() => {
    void run(async () => {
      const result = await window.bengkelin.cashiers.list();
      if (check(result)) setCashiers(result.value);
    });
  }, [run, check]);

  const replace = useCallback((next: CashierDto) => {
    setCashiers((current) => {
      const exists = current.some((c) => c.id === next.id);
      return exists
        ? current.map((c) => (c.id === next.id ? next : c))
        : [...current, next];
    });
    setManaging((current) => (current?.id === next.id ? next : current));
  }, []);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="flex min-w-0 flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold">{t('cashiers.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('cashiers.description')}
          </p>
        </div>
        {error ? <Alert>{error}</Alert> : null}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="p-2">
                  {t('cashiers.fields.username')}
                </th>
                <th scope="col" className="p-2">
                  {t('cashiers.fields.displayName')}
                </th>
                <th scope="col" className="p-2">
                  {t('cashiers.fields.role')}
                </th>
                <th scope="col" className="p-2">
                  {t('cashiers.fields.status')}
                </th>
                <th scope="col" className="p-2">
                  <span className="sr-only">{t('cashiers.actions.label')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {cashiers.map((cashier) => (
                <tr
                  key={cashier.id}
                  data-testid="cashier-row"
                  className="border-b border-border"
                >
                  <td className="p-2 font-mono">{cashier.username}</td>
                  <td className="p-2">{cashier.displayName}</td>
                  <td className="p-2">{t(`common.role.${cashier.role}`)}</td>
                  <td className="p-2">
                    {cashier.isActive
                      ? t('cashiers.status.active')
                      : t('cashiers.status.inactive')}
                  </td>
                  <td className="p-2 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`${t('cashiers.actions.manage')}: ${cashier.displayName}`}
                      onClick={() => setManaging(cashier)}
                    >
                      {t('cashiers.actions.manage')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <CreateCashierForm
        onCreated={replace}
        defaultPreferences={defaultPreferences}
      />
      {managing ? (
        <CashierManageDialog
          cashier={managing}
          onChanged={replace}
          onClose={() => setManaging(null)}
        />
      ) : null}
    </div>
  );
}

function CreateCashierForm({
  onCreated,
  defaultPreferences,
}: {
  onCreated(cashier: CashierDto): void;
  defaultPreferences: PreferencesInput;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('CASHIER');
  const [language, setLanguage] = useState<Language>(
    defaultPreferences.language,
  );
  const [appearance, setAppearance] = useState<Appearance>(
    defaultPreferences.appearance,
  );
  const [created, setCreated] = useState<string | null>(null);
  const { busy, error, fieldErrors, run, check } = useAction();
  const first = useRef<HTMLInputElement>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    setCreated(null);
    void run(async () => {
      const result = await window.bengkelin.cashiers.create({
        username,
        displayName,
        password,
        role,
        language,
        appearance,
      });
      if (!check(result)) return;
      onCreated(result.value);
      setCreated(
        t('cashiers.create.created', { name: result.value.displayName }),
      );
      setUsername('');
      setDisplayName('');
      setPassword('');
      setRole('CASHIER');
      setLanguage(defaultPreferences.language);
      setAppearance(defaultPreferences.appearance);
      first.current?.focus();
    });
  }

  return (
    <Card>
      <form
        onSubmit={submit}
        noValidate
        aria-label={t('cashiers.create.title')}
      >
        <CardHeader>
          <CardTitle className="text-base">
            {t('cashiers.create.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error ? <Alert>{error}</Alert> : null}
          <FormField
            label={t('cashiers.fields.username')}
            error={fieldErrors.username}
          >
            <Input
              ref={first}
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </FormField>
          <FormField
            label={t('cashiers.fields.displayName')}
            error={fieldErrors.displayName}
          >
            <Input
              autoComplete="off"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </FormField>
          <FormField
            label={t('cashiers.fields.password')}
            error={fieldErrors.password}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </FormField>
          <FormField label={t('cashiers.fields.role')} error={fieldErrors.role}>
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              <option value="CASHIER">{t('common.role.CASHIER')}</option>
              <option value="ADMIN">{t('common.role.ADMIN')}</option>
            </Select>
          </FormField>
          <FormField label={t('shell.preferences.language')}>
            <Select
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
            >
              {LANGUAGES.map((value) => (
                <option key={value} value={value}>
                  {t(`shell.preferences.languages.${value}`)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label={t('shell.preferences.appearance')}>
            <Select
              value={appearance}
              onChange={(e) => setAppearance(e.target.value as Appearance)}
            >
              {APPEARANCES.map((value) => (
                <option key={value} value={value}>
                  {t(`shell.preferences.appearances.${value}`)}
                </option>
              ))}
            </Select>
          </FormField>
          <p role="status" className="text-sm text-muted-foreground">
            {created ?? ''}
          </p>
          <Button type="submit" disabled={busy}>
            {busy ? t('common.saving') : t('cashiers.create.submit')}
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}
