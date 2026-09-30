import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DIALOG_PRINT_TIMEOUT_MS,
  SILENT_PRINT_TIMEOUT_MS,
  printWithTimeout,
  type PrintableWindow,
} from '@/main/features/printing/print-job';

type PrintCallback = (success: boolean, failureReason: string) => void;

/** A hidden print window whose print callback the test controls. */
function fakeWindow() {
  const callbacks: PrintCallback[] = [];
  const printOptions: unknown[] = [];
  let destroyed = false;
  const window: PrintableWindow = {
    webContents: {
      print(options: unknown, callback: PrintCallback) {
        printOptions.push(options);
        callbacks.push(callback);
      },
    },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
    },
  };
  return { window, callbacks, printOptions, isDestroyed: () => destroyed };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('printWithTimeout (I1)', () => {
  test('a silent print whose callback never returns fails with PRINT_TIMEOUT and destroys the window', async () => {
    const fake = fakeWindow();
    let settled: unknown = null;
    void printWithTimeout(fake.window, { silent: true }).then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(SILENT_PRINT_TIMEOUT_MS - 1);
    expect(settled).toBeNull();
    expect(fake.isDestroyed()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ outcome: 'FAILED', code: 'PRINT_TIMEOUT' });
    expect(fake.isDestroyed()).toBe(true);
    // A late callback changes nothing.
    fake.callbacks[0]!(true, '');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual({ outcome: 'FAILED', code: 'PRINT_TIMEOUT' });
  });

  test('the OS dialog path waits much longer (the cashier may still be choosing)', async () => {
    expect(DIALOG_PRINT_TIMEOUT_MS).toBeGreaterThan(SILENT_PRINT_TIMEOUT_MS);
    const fake = fakeWindow();
    let settled: unknown = null;
    void printWithTimeout(fake.window, { silent: false }).then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(SILENT_PRINT_TIMEOUT_MS);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(
      DIALOG_PRINT_TIMEOUT_MS - SILENT_PRINT_TIMEOUT_MS,
    );
    expect(settled).toEqual({ outcome: 'FAILED', code: 'PRINT_TIMEOUT' });
    expect(fake.isDestroyed()).toBe(true);
  });

  test('callback results map to outcomes and clear the timer', async () => {
    for (const [success, reason, expected] of [
      [true, '', { outcome: 'PRINTED' }],
      [false, 'Print job canceled', { outcome: 'CANCELLED' }],
      [false, 'Printer error', { outcome: 'FAILED', code: 'PRINT_FAILED' }],
    ] as const) {
      const fake = fakeWindow();
      const result = printWithTimeout(fake.window, { silent: true });
      fake.callbacks[0]!(success, reason);
      await expect(result).resolves.toEqual(expected);
      expect(vi.getTimerCount()).toBe(0);
      expect(fake.isDestroyed()).toBe(false);
    }
  });
});
