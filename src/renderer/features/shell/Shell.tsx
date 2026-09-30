import { LogOut, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { errorMessage } from '@/renderer/lib/errors';
import type { CashierSession } from '@/shared/contracts';

interface ShellProps {
  session: CashierSession;
  shopName: string;
  onLoggedOut(): void;
}

/** Minimal post-login shell. Later tasks add navigation and screens here. */
export function Shell({ session, shopName, onLoggedOut }: ShellProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    const result = await window.bengkelin.auth.logout();
    if (result.ok) onLoggedOut();
    else setError(errorMessage(t, result.error));
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-3">
        <div className="flex items-center gap-2 font-semibold">
          <Wrench aria-hidden="true" className="size-5 text-primary" />
          <span>{shopName || t('common.appName')}</span>
        </div>
        <div className="flex items-center gap-4">
          <p className="text-sm text-muted-foreground">
            {t('shell.signedInAs')}{' '}
            <span
              data-testid="session-name"
              className="font-medium text-foreground"
            >
              {session.displayName}
            </span>{' '}
            <span data-testid="session-role">
              ({t(`common.role.${session.role}`)})
            </span>
          </p>
          <Button variant="outline" size="sm" onClick={() => void logout()}>
            <LogOut aria-hidden="true" />
            {t('shell.logout')}
          </Button>
        </div>
      </header>
      <main className="flex-1 p-6">
        {error ? <Alert className="mb-4">{error}</Alert> : null}
        <h1 className="text-xl font-semibold">
          {t('shell.welcome', { name: session.displayName })}
        </h1>
        <p className="mt-2 text-muted-foreground">{t('shell.placeholder')}</p>
      </main>
    </div>
  );
}
