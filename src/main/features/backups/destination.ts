import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { DomainError } from '@/shared/primitives';

/**
 * Checks that a backup folder can be written to, and classifies failures:
 *  - BACKUP_DESTINATION_UNAVAILABLE: missing, not a folder, or unreachable
 *    (an unplugged USB drive, a disconnected share);
 *  - BACKUP_DESTINATION_READ_ONLY: present but not writable.
 *
 * Only the default folder (`userData/backups`) is created on demand. A
 * configured folder is never created, so a missing drive cannot turn into a
 * folder on the internal disk: there is no silent fallback.
 */
export function prepareDestination(
  dir: string,
  options: { create: boolean },
): void {
  if (options.create) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw destinationError(error);
    }
  }
  let isDirectory: boolean;
  try {
    isDirectory = statSync(dir).isDirectory();
  } catch (error) {
    throw destinationError(error);
  }
  if (!isDirectory) throw new DomainError('BACKUP_DESTINATION_UNAVAILABLE');
  try {
    accessSync(dir, constants.W_OK);
  } catch (error) {
    throw destinationError(error);
  }
}

const READ_ONLY = new Set(['EACCES', 'EPERM', 'EROFS']);
const UNAVAILABLE = new Set([
  'ENOENT',
  'ENOTDIR',
  'ENODEV',
  'ENXIO',
  'EIO',
  'ENOTCONN',
  'EHOSTDOWN',
  'ESTALE',
]);

/** A file-system error code (`EACCES`, ...), if any. */
export function errnoCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function destinationError(error: unknown): DomainError {
  const code = errnoCode(error);
  if (code && READ_ONLY.has(code)) {
    return new DomainError('BACKUP_DESTINATION_READ_ONLY');
  }
  return new DomainError('BACKUP_DESTINATION_UNAVAILABLE');
}

/** Classifies an error raised while writing the backup file itself. */
export function writeError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const code = errnoCode(error);
  if (code && (READ_ONLY.has(code) || code === 'SQLITE_READONLY')) {
    return new DomainError('BACKUP_DESTINATION_READ_ONLY');
  }
  if (code && UNAVAILABLE.has(code)) {
    return new DomainError('BACKUP_DESTINATION_UNAVAILABLE');
  }
  return new DomainError('BACKUP_WRITE_FAILED');
}
