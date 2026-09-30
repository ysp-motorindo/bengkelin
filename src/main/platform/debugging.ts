import type { App } from 'electron';

/**
 * Chromium switches that open a DevTools protocol endpoint on the app.
 * The production fuses turn off Node's inspector (--inspect) but not these,
 * which Chromium reads from the command line.
 */
export const REMOTE_DEBUGGING_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'remote-allow-origins',
] as const;

/**
 * Packaged builds run without development tools (plan §4): drop the
 * remote-debugging switches before Chromium starts its DevTools server.
 * Unpackaged builds keep them (Playwright drives the automation build
 * through them). Must run at startup, before the app is ready.
 */
export function disableRemoteDebugging(
  app: Pick<App, 'isPackaged' | 'commandLine'>,
): string[] {
  if (!app.isPackaged) return [];
  const removed: string[] = [];
  for (const name of REMOTE_DEBUGGING_SWITCHES) {
    if (app.commandLine.hasSwitch(name)) {
      app.commandLine.removeSwitch(name);
      removed.push(name);
    }
  }
  return removed;
}
