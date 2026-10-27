// `npm run smoke:packaged [-- --app <packaged app folder>] [--seconds N] [--keep]`
//
// Launches the HARDENED packaged binary (production fuses on, so no
// Playwright: it needs the inspector fuse) with a throwaway HOME /
// XDG_CONFIG_HOME / APPDATA, a Chromium net-log and host-resolver rules
// that make every non-local name unresolvable, then asserts:
//  - the process stays up for N seconds (default 10);
//  - userData/bengkelin.sqlite is created, migrated to the latest bundled
//    schema, with Bengkelin's application_id and a clean integrity check;
//  - the technical log records the migrations and the window's document
//    loading (window.loaded), and no error;
//  - the database is closed on exit (WAL checkpointed and removed);
//  - the net-log is complete and shows no non-local request or lookup;
//  - SIGTERM makes it exit cleanly (exit code 0) — POSIX only;
//  - no development tools: ELECTRON_RUN_AS_NODE, NODE_OPTIONS and --inspect
//    are ignored (fuses), --remote-debugging-port opens no DevTools endpoint
//    (src/main/platform/debugging.ts), and the unpackaged-only
//    BENGKELIN_DATA_DIR hook is ignored.
// Linux needs a display: run under Xvfb (`xvfb-run -a npm run smoke:packaged`).
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { analyzeNetLog } from './release/net-log.mts';
import {
  layoutFromArgs,
  missingLayoutParts,
  PRODUCT_NAME,
} from './release/package-layout.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const seconds = Number(option('--seconds') ?? 10);
const keep = argv.includes('--keep');
const layout = layoutFromArgs(argv, root);

const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail = '') =>
  results.push({ name, ok, detail });

function latestSchemaVersion(): number {
  const files = readdirSync(path.join(root, 'src/main/database/migrations'))
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  return Number(files.at(-1)!.slice(0, 3));
}

function applicationId(): number {
  const source = readFileSync(
    path.join(root, 'src/main/database/identity.ts'),
    'utf8',
  );
  const match = /APPLICATION_ID\s*=\s*(0x[0-9a-f]+|\d+)/i.exec(source);
  if (!match) throw new Error('APPLICATION_ID not found in identity.ts');
  return Number(match[1]);
}

function findFiles(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return findFiles(full, name);
    return entry.name === name ? [full] : [];
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`Packaged smoke test: ${layout.executable}`);
  const missing = missingLayoutParts(layout);
  if (missing.length) {
    for (const m of missing) record('package present', false, m);
    return;
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bengkelin-smoke-'));
  const home = path.join(tmp, 'home');
  const config = path.join(tmp, 'config');
  const appData = path.join(tmp, 'appdata');
  const trap = path.join(tmp, 'trap');
  for (const dir of [home, config, appData, trap]) {
    mkdirSync(dir, { recursive: true });
  }
  const netLog = path.join(tmp, 'netlog.json');
  const nodeOptionsMarker = path.join(trap, 'NODE_OPTIONS-ran');
  const nodeOptionsScript = path.join(trap, 'node-options.cjs');
  writeFileSync(
    nodeOptionsScript,
    `require('fs').writeFileSync(${JSON.stringify(nodeOptionsMarker)}, 'ran');\n`,
  );
  // Linux: userData follows XDG_CONFIG_HOME (<config>/Bengkelin). macOS and
  // Windows resolve the profile from the OS, not HOME/APPDATA, so there the
  // throwaway userData is passed with Chromium's --user-data-dir (Electron
  // uses it as app.getPath('userData')).
  const explicitUserData = layout.platform !== 'linux';
  const userData = explicitUserData
    ? path.join(tmp, 'userdata')
    : path.join(config, PRODUCT_NAME);
  const databaseFile = path.join(userData, 'bengkelin.sqlite');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: path.join(tmp, 'cache'),
    XDG_DATA_HOME: path.join(tmp, 'data'),
    APPDATA: appData,
    LOCALAPPDATA: path.join(tmp, 'localappdata'),
    // Each must be ignored by the hardened package:
    ELECTRON_RUN_AS_NODE: '1', // RunAsNode fuse off
    NODE_OPTIONS: `--require ${nodeOptionsScript}`, // NODE_OPTIONS fuse off
    BENGKELIN_DATA_DIR: trap, // unpackaged-only hook (R3)
  };
  const args = [
    // The zip/Forge output has no setuid chrome-sandbox (the .deb does).
    ...(layout.platform === 'linux' ? ['--no-sandbox'] : []),
    ...(explicitUserData ? [`--user-data-dir=${userData}`] : []),
    '--inspect=0', // inspect-arguments fuse off
    '--remote-debugging-port=0', // removed at startup when packaged
    `--log-net-log=${netLog}`,
    '--net-log-capture-mode=Everything',
    '--host-resolver-rules=MAP * ^NOTFOUND, EXCLUDE localhost',
  ];
  console.log(`  temp profile: ${tmp}`);

  const started = Date.now();
  const child = spawn(layout.executable, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr.on('data', (d: Buffer) => (output += d.toString()));
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  const exited = new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  const spawnError = new Promise<Error>((resolve) =>
    child.on('error', resolve),
  );

  // ---- stays up, creates the database ----
  let databaseSeenAfter: number | null = null;
  while (Date.now() - started < seconds * 1000 && exit === null) {
    if (databaseSeenAfter === null && existsSync(databaseFile)) {
      databaseSeenAfter = Date.now() - started;
    }
    const failed = await Promise.race([spawnError, delay(250)]);
    if (failed) {
      record('launch', false, (failed as Error).message);
      break;
    }
  }
  record(
    `process stays up for ${seconds} s`,
    exit === null,
    exit ? `exited early: ${JSON.stringify(exit)}` : `pid ${child.pid}`,
  );
  record(
    'database file created in userData',
    databaseSeenAfter !== null,
    databaseSeenAfter !== null
      ? `${databaseFile} after ${databaseSeenAfter} ms`
      : `not found at ${databaseFile}`,
  );

  // ---- clean exit on SIGTERM ----
  if (exit === null) {
    if (layout.platform === 'win32') {
      child.kill();
      await Promise.race([exited, delay(20_000)]);
      record(
        'terminated (Windows: no graceful SIGTERM; not asserted)',
        exit !== null,
      );
    } else {
      const signalledAt = Date.now();
      child.kill('SIGTERM');
      await Promise.race([exited, delay(20_000)]);
      if (exit === null) {
        child.kill('SIGKILL');
        await exited;
        record('exits cleanly on SIGTERM', false, 'still running after 20 s');
      } else {
        const { code, signal } = exit as {
          code: number | null;
          signal: NodeJS.Signals | null;
        };
        record(
          'exits cleanly on SIGTERM',
          code === 0 && signal === null,
          `code ${code}, signal ${signal}, after ${Date.now() - signalledAt} ms`,
        );
      }
    }
  }

  // ---- the database, read after exit ----
  if (layout.platform !== 'win32') {
    // A clean quit closes the connection, which checkpoints and removes the
    // WAL file (checked before this script opens the file itself).
    const wal = `${databaseFile}-wal`;
    record(
      'database closed on exit (WAL checkpointed and removed)',
      existsSync(databaseFile) && !existsSync(wal),
      existsSync(wal) ? `${wal} left behind` : '',
    );
  }
  if (existsSync(databaseFile)) {
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      const pragma = (sql: string) =>
        Object.values(db.prepare(sql).get() ?? {})[0];
      const version = Number(pragma('PRAGMA user_version'));
      const appId = Number(pragma('PRAGMA application_id'));
      const integrity = String(pragma('PRAGMA integrity_check'));
      const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
      const tables = db
        .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`)
        .get() as { n: number };
      const want = latestSchemaVersion();
      record(
        `schema migrated to latest (${want})`,
        version === want,
        `user_version ${version}, ${tables.n} tables`,
      );
      record(
        'application_id is Bengkelin',
        appId === applicationId(),
        `0x${appId.toString(16)}`,
      );
      record(
        'integrity_check ok, no foreign key violations',
        integrity === 'ok' && foreignKeys.length === 0,
        `${integrity}, ${foreignKeys.length} fk violations`,
      );
    } finally {
      db.close();
    }
  }

  const logFile = path.join(userData, 'logs', 'bengkelin.log');
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  record(
    'startup log records the migrations',
    log.includes('startup.migrations'),
    existsSync(logFile) ? logFile : 'no log file',
  );
  record(
    'app window loaded its document (window.loaded)',
    log.includes('"window.loaded"'),
  );
  const errors = log
    .split('\n')
    .filter((line) => line.includes('"level":"error"'));
  record(
    'no errors in the technical log',
    errors.length === 0,
    errors.slice(0, 3).join(' | '),
  );

  // ---- network ----
  if (existsSync(netLog)) {
    try {
      const summary = analyzeNetLog(readFileSync(netLog, 'utf8'));
      record(
        'net-log complete and non-empty',
        summary.events > 0,
        `${summary.events} events`,
      );
      record(
        'no non-local network activity',
        summary.nonLocal.length === 0,
        summary.nonLocal.slice(0, 10).join('; ') || 'none',
      );
    } catch (error) {
      record('net-log complete and non-empty', false, (error as Error).message);
    }
  } else {
    record('net-log complete and non-empty', false, `missing ${netLog}`);
  }

  // ---- hardening ----
  record(
    'NODE_OPTIONS ignored (fuse)',
    !existsSync(nodeOptionsMarker),
    existsSync(nodeOptionsMarker) ? 'the --require script ran' : '',
  );
  record(
    '--inspect ignored (fuse)',
    !/Debugger listening/i.test(output),
    /Debugger listening/i.test(output) ? 'a debugger was listening' : '',
  );
  const devToolsPort = path.join(userData, 'DevToolsActivePort');
  record(
    'no DevTools endpoint (--remote-debugging-port ignored)',
    !existsSync(devToolsPort) && !/DevTools listening/i.test(output),
    existsSync(devToolsPort) || /DevTools listening/i.test(output)
      ? 'a DevTools server was started'
      : '',
  );
  const trapped = findFiles(trap, 'bengkelin.sqlite');
  record(
    'BENGKELIN_DATA_DIR ignored when packaged',
    trapped.length === 0,
    trapped.join(', '),
  );
  const stray = findFiles(tmp, 'bengkelin.sqlite').filter(
    (f) => f !== databaseFile,
  );
  record('no database outside userData', stray.length === 0, stray.join(', '));

  if (results.some((r) => !r.ok)) {
    console.log('  --- app output (tail) ---');
    console.log(
      output
        .split('\n')
        .slice(-30)
        .map((l) => `  | ${l}`)
        .join('\n'),
    );
  }
  if (keep) console.log(`  kept: ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

await main();
let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  console.log(
    `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`,
  );
}
console.log(
  failed === 0
    ? `\nsmoke:packaged passed (${results.length} checks)`
    : `\nsmoke:packaged FAILED: ${failed} of ${results.length} checks`,
);
process.exit(failed === 0 ? 0 : 1);
