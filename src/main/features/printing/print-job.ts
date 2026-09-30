import type { PrintDriverResult } from './driver';

/**
 * A silent print whose `contents.print` callback never returns would leak
 * the hidden window, keep the print buttons busy and hold the maintenance
 * write drain (printing runs under `runWrite`). It fails with
 * PRINT_TIMEOUT after this long and the window is destroyed.
 */
export const SILENT_PRINT_TIMEOUT_MS = 90_000;

/**
 * The OS print dialog may legitimately stay open while the cashier picks a
 * printer, so its timeout is much longer. While it is open a restore does
 * not wait for it indefinitely: the restore's own drain timeout
 * (RESTORE_BUSY) applies, and the dialog print ends here at the latest.
 */
export const DIALOG_PRINT_TIMEOUT_MS = 10 * 60_000;

type PrintCallback = (success: boolean, failureReason: string) => void;

/** The part of a hidden BrowserWindow a print job needs. */
export interface PrintableWindow {
  webContents: {
    print(options: never, callback: PrintCallback): void;
  };
  isDestroyed(): boolean;
  destroy(): void;
}

/**
 * Prints with `webContents.print` and resolves exactly once: PRINTED,
 * CANCELLED, FAILED/PRINT_FAILED from the callback, or FAILED/PRINT_TIMEOUT
 * (window destroyed) when the callback never comes.
 */
export function printWithTimeout<Options extends { silent: boolean }>(
  window: PrintableWindow,
  options: Options,
  timeoutMs: number = options.silent
    ? SILENT_PRINT_TIMEOUT_MS
    : DIALOG_PRINT_TIMEOUT_MS,
): Promise<PrintDriverResult> {
  return new Promise<PrintDriverResult>((resolve) => {
    let settled = false;
    const settle = (result: PrintDriverResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (!window.isDestroyed()) window.destroy();
      settle({ outcome: 'FAILED', code: 'PRINT_TIMEOUT' });
    }, timeoutMs);
    try {
      window.webContents.print(
        options as never,
        (success: boolean, failureReason: string) => {
          if (success) settle({ outcome: 'PRINTED' });
          else if (/cancel/i.test(failureReason ?? '')) {
            settle({ outcome: 'CANCELLED' });
          } else settle({ outcome: 'FAILED', code: 'PRINT_FAILED' });
        },
      );
    } catch {
      settle({ outcome: 'FAILED', code: 'PRINT_FAILED' });
    }
  });
}
