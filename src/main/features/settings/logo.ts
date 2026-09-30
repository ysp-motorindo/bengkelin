import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DomainError } from '@/shared/primitives';

/**
 * Shop logo files (spec 32). A logo is a PNG or JPEG of at most 512 KB,
 * recognized by its magic bytes (never by its name), copied into
 * `userData/assets/<sha256>.<ext>`. The asset key is what settings and
 * invoice snapshots store, so a finalized invoice keeps printing the logo it
 * was issued with even after the shop changes it.
 */

export const LOGO_MAX_BYTES = 512 * 1024;
const ASSET_KEY = /^[0-9a-f]{64}\.(png|jpg)$/;
type ImageType = 'png' | 'jpg';
const MIME: Record<ImageType, string> = { png: 'image/png', jpg: 'image/jpeg' };

export function detectImageType(bytes: Uint8Array): ImageType | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) {
    return 'png';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'jpg';
  }
  return null;
}

export function isLogoAsset(key: string): boolean {
  return ASSET_KEY.test(key);
}

/** Reads and validates the chosen file (size first, then magic bytes). */
export function readLogoFile(file: string): { bytes: Buffer; type: ImageType } {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new DomainError('LOGO_INVALID_TYPE', 'Not a file');
  if (stat.size > LOGO_MAX_BYTES) {
    throw new DomainError('LOGO_TOO_LARGE', 'Logo is larger than 512 KB');
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > LOGO_MAX_BYTES) {
    throw new DomainError('LOGO_TOO_LARGE', 'Logo is larger than 512 KB');
  }
  const type = detectImageType(bytes);
  if (!type) {
    throw new DomainError('LOGO_INVALID_TYPE', 'Logo must be PNG or JPEG');
  }
  return { bytes, type };
}

/** Copies the bytes to `<assetsDir>/<sha256>.<ext>`; returns the key. */
export function storeLogo(
  assetsDir: string,
  bytes: Buffer,
  type: ImageType,
): string {
  const key = `${createHash('sha256').update(bytes).digest('hex')}.${type}`;
  const target = path.join(assetsDir, key);
  fs.mkdirSync(assetsDir, { recursive: true });
  if (!fs.existsSync(target)) {
    // Write then rename, so a crash never leaves a truncated asset.
    const temp = path.join(assetsDir, `.${randomUUID()}.tmp`);
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, target);
  }
  return key;
}

/**
 * The asset as a data URL, or null when the key is malformed or the file
 * is missing or no longer a PNG/JPEG. Callers log and print without it.
 */
export function readLogoDataUrl(assetsDir: string, key: string): string | null {
  if (!isLogoAsset(key)) return null;
  try {
    const bytes = fs.readFileSync(path.join(assetsDir, key));
    const type = detectImageType(bytes);
    if (!type || bytes.length > LOGO_MAX_BYTES) return null;
    return `data:${MIME[type]};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}
