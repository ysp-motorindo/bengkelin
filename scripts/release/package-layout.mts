// Where Electron Forge puts a packaged app (`npm run package`) and the files
// the release checks and the packaged smoke test need inside it.
import { existsSync } from 'node:fs';
import path from 'node:path';

export const PRODUCT_NAME = 'Bengkelin';
export const EXECUTABLE_NAME = 'bengkelin';

export interface PackageLayout {
  platform: NodeJS.Platform;
  arch: string;
  /** The packaged app folder (`out/Bengkelin-<platform>-<arch>`). */
  appDir: string;
  /** The binary whose fuses are flipped and that the smoke test launches. */
  executable: string;
  resourcesDir: string;
  asarPath: string;
  unpackedDir: string;
}

export function defaultAppDir(
  root: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return path.join(root, 'out', `${PRODUCT_NAME}-${platform}-${arch}`);
}

/**
 * The layout of a packaged app folder. `appDir` may also be an unpacked
 * installer payload with the same layout (e.g. `usr/lib/bengkelin` from the
 * .deb, or the extracted .zip).
 */
export function packageLayout(
  appDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PackageLayout {
  const resolved = path.resolve(appDir);
  if (platform === 'darwin') {
    const bundle = path.join(resolved, `${PRODUCT_NAME}.app`, 'Contents');
    const resourcesDir = path.join(bundle, 'Resources');
    return {
      platform,
      arch,
      appDir: resolved,
      executable: path.join(bundle, 'MacOS', EXECUTABLE_NAME),
      resourcesDir,
      asarPath: path.join(resourcesDir, 'app.asar'),
      unpackedDir: path.join(resourcesDir, 'app.asar.unpacked'),
    };
  }
  const resourcesDir = path.join(resolved, 'resources');
  return {
    platform,
    arch,
    appDir: resolved,
    executable: path.join(
      resolved,
      platform === 'win32' ? `${EXECUTABLE_NAME}.exe` : EXECUTABLE_NAME,
    ),
    resourcesDir,
    asarPath: path.join(resourcesDir, 'app.asar'),
    unpackedDir: path.join(resourcesDir, 'app.asar.unpacked'),
  };
}

/** Command-line `--app <dir>` (default: this platform's Forge output). */
export function layoutFromArgs(
  argv: readonly string[],
  root: string,
): PackageLayout {
  const index = argv.indexOf('--app');
  const appDir =
    index >= 0 && argv[index + 1] ? argv[index + 1]! : defaultAppDir(root);
  return packageLayout(appDir);
}

export function missingLayoutParts(layout: PackageLayout): string[] {
  return (
    [
      ['app folder', layout.appDir],
      ['executable', layout.executable],
      ['app.asar', layout.asarPath],
      ['app.asar.unpacked', layout.unpackedDir],
    ] as const
  )
    .filter(([, file]) => !existsSync(file))
    .map(([what, file]) => `${what} not found: ${file}`);
}
