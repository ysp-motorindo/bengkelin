import { sanitizeForLog, type Logger } from './logger';

/**
 * Unexpected failures outside any command (spec 46/48): uncaught
 * exceptions and unhandled rejections in main, and renderer/child
 * processes that died. Each becomes one sanitized log entry with small,
 * known fields only (the logger's sanitizer also drops sensitive keys and
 * bounds strings). Electron-free: main passes `process` and `app`; tests
 * pass emitters.
 */

interface Emitter {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface CrashLoggingDeps {
  process: Emitter;
  app: Emitter;
  logger: Logger;
  /**
   * After logging an uncaught exception: tell the user (main shows a
   * native error box). The affected operation has already stopped.
   */
  onUncaughtException?: (error: Error) => void;
}

/** Error summary (type, code, bounded message and stack), never raw. */
function describe(value: unknown): unknown {
  return sanitizeForLog(
    value instanceof Error ? value : { reason: String(value) },
  );
}

export function installCrashLogging({
  process: proc,
  app,
  logger,
  onUncaughtException,
}: CrashLoggingDeps): void {
  proc.on('uncaughtException', ((error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    logger.error('process.uncaught_exception', { error: describe(failure) });
    try {
      onUncaughtException?.(failure);
    } catch {
      // Reporting must never throw from the handler.
    }
  }) as (...args: unknown[]) => void);

  proc.on('unhandledRejection', ((reason: unknown) => {
    logger.error('process.unhandled_rejection', {
      error: describe(reason),
    });
  }) as (...args: unknown[]) => void);

  app.on('render-process-gone', ((
    _event: unknown,
    webContents: { id?: number } | undefined,
    details: { reason?: string; exitCode?: number } | undefined,
  ) => {
    logger.error('process.render_process_gone', {
      webContentsId: webContents?.id ?? null,
      reason: details?.reason ?? null,
      exitCode: details?.exitCode ?? null,
    });
  }) as (...args: unknown[]) => void);

  app.on('child-process-gone', ((
    _event: unknown,
    details: { type?: string; reason?: string; exitCode?: number } | undefined,
  ) => {
    logger.error('process.child_process_gone', {
      processType: details?.type ?? null,
      reason: details?.reason ?? null,
      exitCode: details?.exitCode ?? null,
    });
  }) as (...args: unknown[]) => void);
}
