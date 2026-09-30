import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import {
  EXECUTABLE_NAME,
  PRODUCT_NAME,
} from './scripts/release/package-layout.mts';
import { PRODUCTION_FUSES } from './scripts/release/production-fuses.mts';

// Packaging (T18). No code signing and no auto-updater in v1 (plan §5).
// `npm run release:check` verifies the packaged output against this file;
// `npm run smoke:packaged` launches the hardened binary.

const APP_ID = 'id.bengkelin.kasir';
const DESCRIPTION = 'Aplikasi kasir bengkel motor (offline, satu komputer)';

/** rpmbuild is optional on build machines; the .rpm is made only where it exists. */
function hasRpmbuild(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('rpmbuild', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    console.warn(
      '[bengkelin] rpmbuild not found: the RPM maker is skipped on this machine',
    );
    return false;
  }
}

/**
 * The better-sqlite3 files needed at runtime: its JS, package.json, license
 * and the N-API prebuild(s) for the TARGET platform/arch (sources, the
 * SQLite amalgamation and other platforms' binaries are left out).
 */
function betterSqliteFilter(platform: string, arch: string) {
  const root = path.resolve('node_modules', 'better-sqlite3');
  const prebuilds = new Set(
    platform === 'linux'
      ? [`linux-${arch}.node`, `linuxmusl-${arch}.node`]
      : [`${platform}-${arch}.node`],
  );
  return (source: string) => {
    const relative = path.relative(root, source).split(path.sep);
    const [top, file] = relative;
    if (relative.length === 1 && top === '') return true;
    if (['src', 'deps', 'build', 'binding.gyp'].includes(top!)) return false;
    if (top === 'prebuilds' && file !== undefined) return prebuilds.has(file);
    return true;
  };
}

const config: ForgeConfig = {
  packagerConfig: {
    name: PRODUCT_NAME,
    executableName: EXECUTABLE_NAME,
    appBundleId: APP_ID,
    appCategoryType: 'public.app-category.business',
    appCopyright: 'Bengkelin',
    win32metadata: {
      CompanyName: PRODUCT_NAME,
      FileDescription: DESCRIPTION,
      ProductName: PRODUCT_NAME,
    },
    // Native .node binaries (better-sqlite3) must live outside the asar.
    // A basename pattern: AutoUnpackNativesPlugin's own glob
    // (`**/{.**,**}/**/*.node`) is matched against the ABSOLUTE staging
    // path and silently packs the binary when that path has a dot-folder
    // (e.g. TMPDIR under `.cache`); release:check caught exactly that.
    asar: { unpack: '*.node' },
  },
  hooks: {
    // The Vite plugin packages only the bundles. better-sqlite3 is external to
    // the main bundle, so ship it (and its runtime deps) inside the app;
    // AutoUnpackNativesPlugin then unpacks its .node binary out of the asar.
    packageAfterCopy: async (
      _config,
      buildPath,
      _electronVersion,
      platform,
      arch,
    ) => {
      await cp(
        path.resolve('node_modules', 'better-sqlite3'),
        path.join(buildPath, 'node_modules', 'better-sqlite3'),
        { recursive: true, filter: betterSqliteFilter(platform, arch) },
      );
      for (const name of ['node-addon-api']) {
        const source = path.resolve('node_modules', name);
        if (!existsSync(source)) continue;
        await cp(source, path.join(buildPath, 'node_modules', name), {
          recursive: true,
        });
      }
    },
  },
  rebuildConfig: {},
  makers: [
    // Windows: Squirrel installer (Setup.exe), unsigned.
    new MakerSquirrel({
      name: 'bengkelin',
      setupExe: `${PRODUCT_NAME}-Setup.exe`,
      description: DESCRIPTION,
    }),
    // macOS (arm64 and x64) and Linux: portable zip archives.
    new MakerZIP({}, ['darwin', 'linux']),
    // Linux (Ubuntu 24.04 acceptance target): .deb; .rpm where rpmbuild exists.
    new MakerDeb({
      options: {
        name: 'bengkelin',
        productName: PRODUCT_NAME,
        genericName: 'Kasir Bengkel',
        description: DESCRIPTION,
        categories: ['Office'],
        bin: EXECUTABLE_NAME,
      },
    }),
    ...(hasRpmbuild()
      ? [
          new MakerRpm({
            options: {
              name: 'bengkelin',
              productName: PRODUCT_NAME,
              description: DESCRIPTION,
              bin: EXECUTABLE_NAME,
            },
          }),
        ]
      : []),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Production security fuses (scripts/release/production-fuses.mts):
    // RunAsNode, NODE_OPTIONS and --inspect off; asar integrity and
    // only-load-from-asar on; cookie encryption on. Flipped at package time.
    new FusesPlugin(PRODUCTION_FUSES),
  ],
};

export default config;
