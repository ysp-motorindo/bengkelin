import { LogOut, Wrench, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { flushAll } from '@/renderer/lib/flush-registry';
import { useAction } from '@/renderer/lib/use-action';
import { cn } from '@/renderer/lib/utils';
import { BackupNoticeBanner } from '@/renderer/features/backups/BackupNoticeBanner';
import { RestoreOutcomeNotice } from '@/renderer/features/backups/RestoreOutcomeNotice';
import { CashiersScreen } from '@/renderer/features/cashiers/CashiersScreen';
import { reportPrintContext } from '@/renderer/features/printing/print-target';
import { CatalogScreen } from '@/renderer/features/catalog/CatalogScreen';
import { CatalogTransferScreen } from '@/renderer/features/catalog-transfer/CatalogTransferScreen';
import { InventoryScreen } from '@/renderer/features/inventory/InventoryScreen';
import { CustomersScreen } from '@/renderer/features/customers/CustomersScreen';
import { HistoryScreen } from '@/renderer/features/history/HistoryScreen';
import { ReceivablesScreen } from '@/renderer/features/history/ReceivablesScreen';
import { DailyReportScreen } from '@/renderer/features/reports/DailyReportScreen';
import { ReferencesScreen } from '@/renderer/features/references/ReferencesScreen';
import { SettingsScreen } from '@/renderer/features/settings/SettingsScreen';
import { CashierWorkspace } from '@/renderer/features/workspace/CashierWorkspace';
import type { FinalizeClient } from '@/renderer/features/workspace/checkout/finalize-client';
import type {
  CashierSession,
  PreferencesInput,
  PublicSettings,
} from '@/shared/contracts';
import { PreferencesControls } from './PreferencesControls';
import { useShellMenu } from './use-shell-menu';

type View =
  | 'workspace'
  | 'history'
  | 'receivables'
  | 'reports'
  | 'customers'
  | 'catalog'
  | 'catalogTransfer'
  | 'inventory'
  | 'references'
  | 'cashiers'
  | 'settings';

interface ShellProps {
  session: CashierSession;
  shopName: string;
  settings?: PublicSettings | undefined;
  onLoggedOut(): void;
  onPreferencesChanged?: ((settings: PreferencesInput) => void) | undefined;
  onShopSettingsChanged?: ((settings: PublicSettings) => void) | undefined;
  /** Finalization client for the checkout review (default: the bridge). */
  finalizer?: FinalizeClient | undefined;
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
  onShopSettingsChanged,
  finalizer,
}: ShellProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>('workspace');
  const { busy, error, setError, run, check } = useAction();
  const menu = useShellMenu({ session, showView: setView });

  // After a reload main may still hold the previous page's print context.
  useEffect(() => reportPrintContext(), []);

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
      ? [
          'workspace',
          'history',
          'receivables',
          'reports',
          'customers',
          'catalog',
          'catalogTransfer',
          'inventory',
          'references',
          'cashiers',
          'settings',
        ]
      : [
          'workspace',
          'history',
          'receivables',
          'reports',
          'customers',
          'catalog',
          'inventory',
        ];

  return (
    <div className="flex min-h-screen flex-col">
      <div className="sticky top-0 z-40 bg-card">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-card px-4 py-2 sm:px-6">
          <div className="flex items-center gap-2 font-semibold">
            <Wrench aria-hidden="true" className="size-5 text-primary" />
            <span>{shopName || t('common.appName')}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {settings && onPreferencesChanged ? (
              <PreferencesControls
                preferences={session}
                onChanged={onPreferencesChanged}
              />
            ) : null}
            <details className="relative text-sm">
              <summary
                aria-label={t('shell.profileMenuLabel')}
                className="cursor-pointer list-none rounded-md border border-input px-3 py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span data-testid="session-name">{session.displayName}</span>{' '}
                <span data-testid="session-role">
                  ({t(`common.role.${session.role}`)})
                </span>{' '}
                ▾
              </summary>
              <div className="absolute right-0 z-50 mt-1 min-w-40 rounded-md border border-border bg-card p-2 shadow-lg">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={logout}
                >
                  <LogOut aria-hidden="true" />
                  {t('shell.logout')}
                </Button>
              </div>
            </details>
          </div>
        </header>
        <nav
          aria-label={t('shell.nav.label')}
          className="flex flex-nowrap gap-1 overflow-x-auto border-b border-border bg-card px-4 sm:px-6"
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
      </div>
      {session.role === 'ADMIN' ? <BackupNoticeBanner /> : null}
      {session.role === 'ADMIN' ? <RestoreOutcomeNotice /> : null}
      <main className="min-w-0 flex-1 p-3 sm:p-4 lg:p-6">
        {error ? <Alert className="mb-4">{error}</Alert> : null}
        {menu.notice ? (
          <div
            data-testid="menu-notice"
            role={menu.notice.tone}
            className={cn(
              'mb-4 flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm',
              menu.notice.tone === 'alert'
                ? 'border-destructive/50 text-destructive'
                : 'border-border bg-card',
            )}
          >
            <span>{menu.notice.text}</span>
            <button
              type="button"
              aria-label={t('shell.menuNotice.dismiss')}
              onClick={menu.dismiss}
              className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        ) : null}
        <div hidden={view !== 'workspace'}>
          <CashierWorkspace finalizer={finalizer} />
        </div>
        {view === 'history' ? <HistoryScreen session={session} /> : null}
        {view === 'receivables' ? <ReceivablesScreen /> : null}
        {view === 'reports' ? <DailyReportScreen session={session} /> : null}
        {view === 'customers' ? <CustomersScreen role={session.role} /> : null}
        {view === 'catalog' ? <CatalogScreen role={session.role} /> : null}
        {view === 'catalogTransfer' && session.role === 'ADMIN' ? (
          <CatalogTransferScreen />
        ) : null}
        {view === 'inventory' ? <InventoryScreen role={session.role} /> : null}
        {view === 'references' && session.role === 'ADMIN' ? (
          <ReferencesScreen />
        ) : null}
        {view === 'cashiers' && session.role === 'ADMIN' ? (
          <CashiersScreen defaultPreferences={session} />
        ) : null}
        {view === 'settings' && session.role === 'ADMIN' ? (
          <SettingsScreen onShopSaved={onShopSettingsChanged} />
        ) : null}
      </main>
    </div>
  );
}
