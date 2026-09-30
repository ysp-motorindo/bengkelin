import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Result } from '@/shared/primitives';
import { errorMessage } from './errors';
import { watchSessionError } from './session-events';

/**
 * Runs one async UI action at a time. `busy` is always cleared (try/finally),
 * even when the IPC promise rejects, and a rejection surfaces as the generic
 * translated error instead of leaving the screen stuck.
 */
export function useAction() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const running = useRef(false);

  const run = useCallback(
    async (work: () => Promise<void>) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setError(null);
      setFieldErrors({});
      try {
        await work();
      } catch {
        setError(t('errors.INTERNAL_ERROR'));
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [t],
  );

  /** Shows a failed Result's message and field errors; returns true when ok. */
  const check = useCallback(
    <T>(result: Result<T>): result is Extract<Result<T>, { ok: true }> => {
      if (result.ok) return true;
      watchSessionError(result.error);
      setFieldErrors(result.error.fieldErrors ?? {});
      setError(errorMessage(t, result.error));
      return false;
    },
    [t],
  );

  return { busy, error, fieldErrors, setError, run, check };
}
