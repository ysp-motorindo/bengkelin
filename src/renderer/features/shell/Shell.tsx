import { LogOut, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { flushAll } from '@/renderer/lib/flush-registry';
import { useAction } from '@/renderer/lib/use-action';
import { cn } from '@/renderer/lib/utils';
import { CatalogScreen } from '@/renderer/features/catalog/CatalogScreen';
import { InventoryScreen } from '@/renderer/features/inventory/InventoryScreen';
import { CustomersScreen } from '@/renderer/features/customers/CustomersScreen';
import { ReferencesScreen } from '@/renderer/features/references/ReferencesScreen';
import { CashierWorkspace } from '@/renderer/features/workspace/CashierWorkspace';
import type { FinalizeHandler } from '@/renderer/features/workspace/checkout/CheckoutReviewDialog';
import type { CashierSession, PublicSettings } from '@/shared/contracts';
import { PreferencesControls } from './PreferencesControls';

type View = 'workspace' | 'customers' | 'catalog' | 'inventory' | 'references';

interface ShellProps {
  session: CashierSession;
  shopName: string;
  settings?: PublicSettings | undefined;
  onLoggedOut(): void;
  onPreferencesChanged?: ((settings: PublicSettings) => void) | undefined;
  /** T10 wires finalization into the checkout review. */
  onFinalize?: FinalizeHandler | undefined;
}

/**
 * Post-login shell. "New Transaction" (the cashier workspace) is the default
 * view; the other screens stay reachable from the navigation. The workspace
 * stays mounted while another screen is shown so an open draft keeps its
 * state.
 */
export function Shell({
  session,
  shopName,
  settings,
  onLoggedOut,
  onPreferencesChanged,
  onFinalize,
}: ShellProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>('workspace');
  const { busy, error, setError, run, check } = useAction();

  function logout() {
    void run(async () => {
      // Pending draft input is sent before the session ends.
      if (!(await flushAll())) {
        setError(t('workspace.notices.unsaved'));
        return;
      }
      const result = await window.bengkelin.auth.logout();
      if (check(result)) onLoggedOut();
    });
  }

  const views: View[] =
    session.role === 'ADMIN'
      ? ['workspace', 'customers', 'catalog', 'inventory', 'references']
      : ['workspace', 'customers', 'catalog', 'inventory'];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-card px-4 py-2 sm:px-6">
        <div className="flex items-center gap-2 font-semibold">
          <Wrench aria-hidden="true" className="size-5 text-primary" />
          <span>{shopName || t('common.appName')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {session.role === 'ADMIN' && settings && onPreferencesChanged ? (
            <PreferencesControls
              settings={settings}
              onChanged={onPreferencesChanged}
            />
          ) : null}
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
        className="flex flex-wrap gap-1 border-b border-border bg-card px-4 sm:px-6"
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
      <main className="min-w-0 flex-1 p-3 sm:p-4 lg:p-6">
        {error ? <Alert className="mb-4">{error}</Alert> : null}
        <div hidden={view !== 'workspace'}>
          <CashierWorkspace onFinalize={onFinalize} />
        </div>
        {view === 'customers' ? <CustomersScreen /> : null}
        {view === 'catalog' ? <CatalogScreen role={session.role} /> : null}
        {view === 'inventory' ? <InventoryScreen role={session.role} /> : null}
        {view === 'references' && session.role === 'ADMIN' ? (
          <ReferencesScreen />
        ) : null}
      </main>
    </div>
  );
}
