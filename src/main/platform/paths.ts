import path from 'node:path';
import type { App } from 'electron';

/**
 * Test-only override for where the application keeps its state. In unpackaged
 * builds, when BENGKELIN_DATA_DIR is set, Electron's userData (database,
 * backups, logs and the single-instance lock) lives there. Packaged builds
 * ignore it, so a shipped app can never be split across data directories.
 */
export function applyDataDirOverride(
  app: Pick<App, 'setPath' | 'isPackaged'>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dataDir = env.BENGKELIN_DATA_DIR;
  if (dataDir && !app.isPackaged) {
    app.setPath('userData', path.resolve(dataDir));
  }
}
