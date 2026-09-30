import path from 'node:path';
import type { App } from 'electron';

/**
 * Test-only override for where the application keeps its state. When
 * BENGKELIN_DATA_DIR is set, Electron's userData (and therefore the database,
 * backups, logs and the single-instance lock) lives there.
 */
export function applyDataDirOverride(
  app: Pick<App, 'setPath'>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dataDir = env.BENGKELIN_DATA_DIR;
  if (dataDir) {
    app.setPath('userData', path.resolve(dataDir));
  }
}
