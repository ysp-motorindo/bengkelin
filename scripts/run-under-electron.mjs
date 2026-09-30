// Runs a Node script under Electron's embedded Node (ELECTRON_RUN_AS_NODE) so
// native modules built for the Electron ABI (better-sqlite3) load in tests.
import { spawnSync } from 'node:child_process';
import electron from 'electron';

const result = spawnSync(electron, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
process.exit(result.status ?? 1);
