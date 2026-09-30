// `npm run print:samples`: bundles scripts/print-samples/main.ts for Electron
// and runs it. Output: artifacts/print-samples/*.pdf (git-ignored).
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import path from 'node:path';
import electron from 'electron';
import { build } from 'vite';

const outDir = path.resolve('artifacts/print-samples/.bundle');

await build({
  configFile: 'vite.main.config.mts',
  clearScreen: false,
  logLevel: 'warn',
  define: {
    MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined',
    MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
  },
  resolve: { conditions: ['node'], mainFields: ['module', 'jsnext:main'] },
  build: {
    copyPublicDir: false,
    emptyOutDir: true,
    outDir,
    lib: {
      entry: 'scripts/print-samples/main.ts',
      fileName: () => 'print-samples.cjs',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: [
        'electron',
        'better-sqlite3',
        ...builtinModules.flatMap((m) => [m, `node:${m}`]),
      ],
    },
  },
});

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
const linuxArgs =
  process.platform === 'linux'
    ? [
        '--no-sandbox',
        '--disable-gpu',
        ...(hasDisplay ? [] : ['--ozone-platform=headless']),
      ]
    : [];
const result = spawnSync(
  electron as unknown as string,
  [...linuxArgs, path.join(outDir, 'print-samples.cjs')],
  { stdio: 'inherit', env },
);
process.exit(result.status ?? 1);
