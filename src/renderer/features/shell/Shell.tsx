import { LogOut, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { useAction } from '@/renderer/lib/use-action';
import { cn } from '@/renderer/lib/utils';
import { CustomersScreen } from '@/renderer/features/customers/CustomersScreen';
import { ReferencesScreen } from '@/renderer/features/references/ReferencesScreen';
import type { CashierSession } from '@/shared/contracts';

type View = 'home' | 'customers' | 'references';

interface ShellProps {
  session: CashierSession;
  shopName: string;
  onLoggedOut(): void;
}

/** Minimal post-login shell. Later tasks add navigation and screens here. */
export function Shell({ session, shopName, onLoggedOut }: ShellProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>('home');
  const { busy, error, run, check } = useAction();

  function logout() {
    void run(async () => {
      const result = await window.bengkelin.auth.logout();
      if (check(result)) onLoggedOut();
    });
  }

  const views: View[] =
    session.role === 'ADMIN'
      ? ['home', 'customers', 'references']
      : ['home', 'customers'];

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
          <Button variant="outline" size="sm" disabled={busy} onClick={logout}>
            <LogOut aria-hidden="true" />
            {t('shell.logout')}
          </Button>
        </div>
      </header>
      <nav
        aria-label={t('shell.nav.label')}
        className="flex gap-1 border-b border-border bg-card px-6"
      >
        {views.map((name) => (
          <button
            key={name}
            type="button"
            aria-current={view === name ? 'page' : undefined}
            onClick={() => setView(name)}
            className={cn(
              'px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              view === name
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`shell.nav.${name}`)}
          </button>
        ))}
      </nav>
      <main className="flex-1 p-6">
        {error ? <Alert className="mb-4">{error}</Alert> : null}
        {view === 'customers' ? <CustomersScreen /> : null}
        {view === 'references' && session.role === 'ADMIN' ? (
          <ReferencesScreen />
        ) : null}
        {view === 'home' ? (
          <>
            <h1 className="text-xl font-semibold">
              {t('shell.welcome', { name: session.displayName })}
            </h1>
            <p className="mt-2 text-muted-foreground">
              {t('shell.placeholder')}
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
