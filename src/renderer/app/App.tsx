import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { LoginScreen } from '@/renderer/features/auth/LoginScreen';
import { SetupWizard } from '@/renderer/features/setup/SetupWizard';
import { AboutDialog } from '@/renderer/features/shell/AboutDialog';
import { Shell } from '@/renderer/features/shell/Shell';
import { DEFAULT_LANGUAGE, setLanguage } from '@/renderer/i18n';
import { flushAll } from '@/renderer/lib/flush-registry';
import { onUnauthenticated } from '@/renderer/lib/session-events';
import { applyAppearance } from '@/renderer/lib/theme';
import { reloadAfterFlush, useMenuActions } from './menu-actions';
import type {
  Appearance,
  CashierSession,
  Language,
  PublicSettings,
} from '@/shared/contracts';

type Phase =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; settings: PublicSettings; session: CashierSession | null };

/**
 * Root: decides between setup wizard, login and the signed-in shell, and keeps
 * language and theme in step with the shop-wide settings (also while the
 * wizard previews a choice).
 */
export function App() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [preview, setPreview] = useState<{
    language: Language;
    appearance: Appearance;
  } | null>(null);

  const [aboutOpen, setAboutOpen] = useState(false);
  const closeAbout = useCallback(() => setAboutOpen(false), []);

  // Menu actions that need no session: Help > About and View > Reload
  // (which flushes draft input first). The shell handles the rest.
  useMenuActions((action) => {
    if (action === 'about') setAboutOpen(true);
    else if (action === 'reload') void reloadAfterFlush();
  });

  const settings = phase.kind === 'ready' ? phase.settings : null;
  const language = preview?.language ?? settings?.language ?? DEFAULT_LANGUAGE;
  const appearance = preview?.appearance ?? settings?.appearance ?? 'SYSTEM';

  useEffect(() => setLanguage(language), [language]);
  useEffect(() => applyAppearance(appearance), [appearance]);

  async function load() {
    setPhase({ kind: 'loading' });
    try {
      const [publicResult, sessionResult] = await Promise.all([
        window.bengkelin.settings.getPublic(),
        window.bengkelin.auth.currentSession(),
      ]);
      if (!publicResult.ok || !sessionResult.ok) {
        setPhase({ kind: 'failed' });
        return;
      }
      setPhase({
        kind: 'ready',
        settings: publicResult.value,
        session: sessionResult.value,
      });
    } catch {
      setPhase({ kind: 'failed' });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // A session lost behind this window's back (UNAUTHENTICATED) -> login.
  useEffect(
    () =>
      onUnauthenticated(() =>
        setPhase((current) =>
          current.kind === 'ready' ? { ...current, session: null } : current,
        ),
      ),
    [],
  );

  // Normal exit: flush pending draft input, then let main close the window.
  useEffect(() => {
    const bridge = window.bengkelin.app;
    if (typeof bridge?.onBeforeClose !== 'function') return undefined;
    return bridge.onBeforeClose(() => {
      void flushAll().finally(() => bridge.readyToClose());
    });
  }, []);

  function content(): ReactNode {
    if (phase.kind === 'loading') {
      return (
        <main className="flex min-h-screen items-center justify-center text-muted-foreground">
          <p role="status">{t('common.loading')}</p>
        </main>
      );
    }

    if (phase.kind === 'failed') {
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
          <Alert>{t('errors.LOAD_FAILED')}</Alert>
          <Button onClick={() => void load()}>{t('common.retry')}</Button>
        </main>
      );
    }

    const { session } = phase;

    if (!phase.settings.setupCompleted) {
      return (
        <SetupWizard
          language={language}
          appearance={appearance}
          onPreview={setPreview}
          onCompleted={(completed) => {
            setPreview(null);
            setPhase({ kind: 'ready', settings: completed, session: null });
          }}
        />
      );
    }

    if (!session) {
      return (
        <LoginScreen
          shopName={phase.settings.shopName}
          onLoggedIn={(next) =>
            setPhase({ kind: 'ready', settings: phase.settings, session: next })
          }
        />
      );
    }

    return (
      <Shell
        session={session}
        shopName={phase.settings.shopName}
        settings={phase.settings}
        onLoggedOut={() =>
          setPhase({ kind: 'ready', settings: phase.settings, session: null })
        }
        onPreferencesChanged={(next) =>
          setPhase({ kind: 'ready', settings: next, session })
        }
      />
    );
  }

  return (
    <>
      {content()}
      {aboutOpen ? <AboutDialog onClose={closeAbout} /> : null}
    </>
  );
}
