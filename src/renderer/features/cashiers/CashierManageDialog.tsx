import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog } from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { useAction } from '@/renderer/lib/use-action';
import type { CashierDto, Role } from '@/shared/contracts';
import type { Result } from '@/shared/primitives';

/**
 * One cashier: rename, change role, reset password, deactivate/reactivate.
 * Role changes, deactivation and password resets end that cashier's
 * sessions in main. Errors (LAST_ACTIVE_ADMIN, validation) are announced
 * in the dialog; success is a status message.
 */
export function CashierManageDialog({
  cashier,
  onChanged,
  onClose,
}: {
  cashier: CashierDto;
  onChanged(cashier: CashierDto): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(cashier.displayName);
  const [role, setRole] = useState<Role>(cashier.role);
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const { busy, error, fieldErrors, run, check } = useAction();
  const b = window.bengkelin.cashiers;

  function apply(
    call: () => Promise<Result<CashierDto | void>>,
    message = t('cashiers.manage.saved'),
  ) {
    setSaved(null);
    void run(async () => {
      const result = await call();
      if (!check(result)) return;
      if (result.value) onChanged(result.value);
      setSaved(message);
    });
  }

  function submit(handler: () => void) {
    return (event: FormEvent) => {
      event.preventDefault();
      handler();
    };
  }

  const id = { cashierId: cashier.id };

  return (
    <Dialog
      title={t('cashiers.manage.title', { name: cashier.displayName })}
      description={t('cashiers.manage.sessionNote')}
      onClose={onClose}
      closeLabel={t('workspace.common.close')}
      className="max-w-lg"
    >
      <div className="flex flex-col gap-4">
        {error ? <Alert>{error}</Alert> : null}
        <p role="status" className="text-sm text-muted-foreground">
          {saved ?? ''}
        </p>

        <form
          noValidate
          className="flex items-end gap-2"
          onSubmit={submit(() =>
            apply(() => b.updateDisplayName({ ...id, displayName })),
          )}
        >
          <div className="flex-1">
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
          </div>
          <Button type="submit" variant="outline" disabled={busy}>
            {t('cashiers.manage.saveName')}
          </Button>
        </form>

        <form
          noValidate
          className="flex items-end gap-2"
          onSubmit={submit(() => apply(() => b.changeRole({ ...id, role })))}
        >
          <div className="flex-1">
            <FormField
              label={t('cashiers.fields.role')}
              error={fieldErrors.role}
            >
              <Select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                <option value="CASHIER">{t('common.role.CASHIER')}</option>
                <option value="ADMIN">{t('common.role.ADMIN')}</option>
              </Select>
            </FormField>
          </div>
          <Button type="submit" variant="outline" disabled={busy}>
            {t('cashiers.manage.saveRole')}
          </Button>
        </form>

        <form
          noValidate
          className="flex items-end gap-2"
          onSubmit={submit(() => {
            apply(
              () => b.resetPassword({ ...id, newPassword: password }),
              t('cashiers.manage.passwordReset'),
            );
            setPassword('');
          })}
        >
          <div className="flex-1">
            <FormField
              label={t('cashiers.fields.newPassword')}
              error={fieldErrors.newPassword}
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormField>
          </div>
          <Button type="submit" variant="outline" disabled={busy}>
            {t('cashiers.manage.resetPassword')}
          </Button>
        </form>

        <div className="flex justify-between gap-2 border-t border-border pt-4">
          {cashier.isActive ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => apply(() => b.deactivate(id))}
            >
              {t('cashiers.manage.deactivate')}
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => apply(() => b.reactivate(id))}
            >
              {t('cashiers.manage.reactivate')}
            </Button>
          )}
          <Button onClick={onClose}>{t('workspace.common.close')}</Button>
        </div>
      </div>
    </Dialog>
  );
}
