import { describe, expect, test, vi } from 'vitest';
import {
  createStartupFailureHandler,
  shouldLogLoadFailure,
} from '@/main/platform/startup-errors';

describe('startup failure handler (I2)', () => {
  test('logs sanitized, shows a safe message and exits with code 1', () => {
    const logged: { event: string; fields?: Record<string, unknown> }[] = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: (event: string, fields?: Record<string, unknown>) =>
        logged.push({ event, ...(fields ? { fields } : {}) }),
    };
    const showErrorBox = vi.fn();
    const exit = vi.fn();
    const handle = createStartupFailureHandler({
      logger: () => logger,
      showErrorBox,
      exit,
    });

    handle(new Error('EACCES: open /home/budi/secret/bengkelin.sqlite'));

    expect(logged).toHaveLength(1);
    expect(logged[0]!.event).toBe('startup.failed');
    expect(showErrorBox).toHaveBeenCalledOnce();
    const [title, message] = showErrorBox.mock.calls[0]!;
    expect(title).toBe('Bengkelin');
    // A fixed, bilingual message: never the raw error (paths, names).
    expect(message).not.toContain('budi');
    expect(message).not.toContain('EACCES');
    expect(message).toMatch(/tidak dapat dimulai/);
    expect(message).toMatch(/could not start/);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('still exits when logging or the dialog throw', () => {
    const exit = vi.fn();
    const handle = createStartupFailureHandler({
      logger: () => {
        throw new Error('log dir unavailable');
      },
      showErrorBox: () => {
        throw new Error('no display');
      },
      exit,
    });
    expect(() => handle('boom')).not.toThrow();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('did-fail-load logging (M4)', () => {
  test('ERR_ABORTED (-3) and subframe failures are not logged as errors', () => {
    expect(shouldLogLoadFailure(-3, true)).toBe(false);
    expect(shouldLogLoadFailure(-105, false)).toBe(false);
    expect(shouldLogLoadFailure(-105, true)).toBe(true);
    expect(shouldLogLoadFailure(-6, true)).toBe(true);
  });
});
