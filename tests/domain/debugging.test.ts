import { describe, expect, test } from 'vitest';
import {
  disableRemoteDebugging,
  REMOTE_DEBUGGING_SWITCHES,
} from '@/main/platform/debugging';

function fakeApp(isPackaged: boolean, switches: string[]) {
  const present = new Set(switches);
  return {
    isPackaged,
    present,
    commandLine: {
      hasSwitch: (name: string) => present.has(name),
      removeSwitch: (name: string) => void present.delete(name),
    } as unknown as Electron.CommandLine,
  };
}

describe('remote debugging in packaged builds', () => {
  test('packaged: every remote-debugging switch is removed', () => {
    const app = fakeApp(true, [...REMOTE_DEBUGGING_SWITCHES, 'no-sandbox']);
    expect(disableRemoteDebugging(app)).toEqual([...REMOTE_DEBUGGING_SWITCHES]);
    expect([...app.present]).toEqual(['no-sandbox']);
  });

  test('unpackaged (automation build): switches are kept for Playwright', () => {
    const app = fakeApp(false, ['remote-debugging-port']);
    expect(disableRemoteDebugging(app)).toEqual([]);
    expect(app.present.has('remote-debugging-port')).toBe(true);
  });
});
