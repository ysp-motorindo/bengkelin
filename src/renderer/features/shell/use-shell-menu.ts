import { useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useMenuActions } from '@/renderer/app/menu-actions';
import { hasOpenDialog } from '@/renderer/components/ui/dialog';
import { announceBackupChange } from '@/renderer/features/backups/use-backup-status';
import { runPrintTarget } from '@/renderer/features/printing/print-target';
import { getWorkspaceActions } from '@/renderer/features/workspace/workspace-actions';
import { errorMessage } from '@/renderer/lib/errors';
import { watchSessionError } from '@/renderer/lib/session-events';
import type { CashierSession } from '@/shared/contracts';
import type { MenuAction } from '@/shared/menu';

export type MenuNotice = { tone: 'status' | 'alert'; text: string } | null;

/**
 * Signed-in menu actions (spec 53). The shell switches to the workspace
 * view first (synchronously, so focus lands on visible controls) and then
 * calls the workspace's registered actions or an existing API. Finalize
 * only opens the checkout review. While a modal dialog is open, actions
 * that would reach behind it (search, custom item, review) are ignored;
 * New Transaction, Save Draft and Print still work (for example Ctrl+P and
 * Ctrl+N on the finalized-success view). ADMIN-only actions are ignored
 * for a CASHIER here, and main refuses them anyway.
 */
export function useShellMenu({
  session,
  showView,
}: {
  session: CashierSession;
  showView(view: 'workspace' | 'reports'): void;
}): { notice: MenuNotice; dismiss(): void } {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<MenuNotice>(null);
  const admin = session.role === 'ADMIN';

  function toWorkspace() {
    flushSync(() => showView('workspace'));
    return getWorkspaceActions();
  }

  async function run(action: MenuAction): Promise<void> {
    switch (action) {
      case 'newTransaction':
        await toWorkspace()?.newTransaction();
        return;
      case 'searchItem':
        if (!hasOpenDialog()) toWorkspace()?.focusSearch();
        return;
      case 'addCustomItem':
        if (!hasOpenDialog()) toWorkspace()?.addCustomItem();
        return;
      case 'finalize':
        if (!hasOpenDialog()) await toWorkspace()?.openCheckoutReview();
        return;
      case 'saveDraft': {
        const actions = getWorkspaceActions();
        if (actions && !(await actions.saveDraft())) {
          setNotice({ tone: 'alert', text: t('workspace.notices.unsaved') });
        }
        return;
      }
      case 'print':
        await runPrintTarget();
        return;
      case 'dailyReport':
        showView('reports');
        return;
      case 'backupDatabase': {
        if (!admin) return;
        setNotice({
          tone: 'status',
          text: t('shell.menuNotice.backupRunning'),
        });
        const result = await window.bengkelin.backups
          .create()
          .finally(announceBackupChange);
        if (result.ok) {
          setNotice({
            tone: 'status',
            text: t('shell.menuNotice.backupDone', {
              fileName: result.value.fileName,
            }),
          });
        } else {
          watchSessionError(result.error);
          setNotice({ tone: 'alert', text: errorMessage(t, result.error) });
        }
        return;
      }
      case 'openLogFolder': {
        if (!admin) return;
        const result = await window.bengkelin.app.openLogFolder();
        setNotice(
          result.ok
            ? { tone: 'status', text: t('shell.menuNotice.logFolderOpened') }
            : { tone: 'alert', text: errorMessage(t, result.error) },
        );
        return;
      }
      default:
        // About and Reload are handled by App.
        return;
    }
  }

  useMenuActions((action) => {
    run(action).catch(() =>
      setNotice({ tone: 'alert', text: t('errors.INTERNAL_ERROR') }),
    );
  });

  return { notice, dismiss: () => setNotice(null) };
}
