// Builds main, preload and renderer bundles into .vite/ using the same layout
// and compile-time constants Electron Forge's Vite plugin produces, so the
// unpackaged app can be launched with `electron .` (used by the e2e suite).
import { builtinModules } from 'node:module';
import { build } from 'vite';

const external = [
  'electron',
  'electron/common',
  'electron/main',
  ...builtinModules.flatMap((m) => [m, `node:${m}`]),
];
const define = {
  MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined',
  MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
};

async function buildNode(entry: string, configFile: string) {
  await build({
    configFile,
    clearScreen: false,
    define,
    resolve: { conditions: ['node'], mainFields: ['module', 'jsnext:main'] },
    build: {
      copyPublicDir: false,
      emptyOutDir: false,
      outDir: '.vite/build',
      lib: { entry, fileName: () => '[name].cjs', formats: ['cjs'] },
      rollupOptions: { external },
    },
  });
}

await buildNode('src/main.ts', 'vite.main.config.mts');
await buildNode('src/preload.ts', 'vite.preload.config.mts');
await build({
  configFile: 'vite.renderer.config.mts',
  clearScreen: false,
  build: { outDir: '.vite/renderer/main_window', emptyOutDir: true },
});
