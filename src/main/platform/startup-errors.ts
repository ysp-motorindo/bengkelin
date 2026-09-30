import { sanitizeForLog, type Logger } from './logger';

/**
 * Startup failures outside the database step (I2). Electron-free so it can
 * be tested: main passes `dialog.showErrorBox` and `app.exit`.
 */

export interface StartupFailureDeps {
  /** Lazily resolved: creating the logger may itself be what failed. */
  logger: () => Logger;
  showErrorBox(title: string, content: string): void;
  exit(code: number): void;
}

/** Fixed and bilingual: never the raw error (it may hold paths or names). */
export const STARTUP_FAILED_MESSAGE = [
  'Bengkelin tidak dapat dimulai. Data yang sudah tersimpan tetap aman. Tutup lalu buka kembali aplikasi; bila masih gagal, hubungi dukungan dan kirimkan folder log.',
  'Bengkelin could not start. Saved data is safe. Close and reopen the app; if it still fails, contact support and send the log folder.',
].join('\n\n');

/**
 * `app.whenReady().then(...).catch(handler)`: a throw during startup would
 * otherwise leave a windowless process holding the single-instance lock
 * (a second launch would only focus nothing). Logs a sanitized entry,
 * explains once, and exits with code 1. Never throws.
 */
export function createStartupFailureHandler(
  deps: StartupFailureDeps,
): (error: unknown) => void {
  return (error: unknown) => {
    try {
      deps.logger().error('startup.failed', {
        error: sanitizeForLog(
          error instanceof Error ? error : { reason: String(error) },
        ),
      });
    } catch {
      // Logging must never stop the exit.
    }
    try {
      deps.showErrorBox('Bengkelin', STARTUP_FAILED_MESSAGE);
    } catch {
      // No display: still exit.
    }
    deps.exit(1);
  };
}

/** Chromium's ERR_ABORTED: a navigation superseded or cancelled, not a failure. */
const ERR_ABORTED = -3;

/** Whether a `did-fail-load` is worth an error log entry (M4). */
export function shouldLogLoadFailure(
  code: number,
  isMainFrame: boolean,
): boolean {
  return isMainFrame && code !== ERR_ABORTED;
}
