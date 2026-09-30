import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import type { Instant } from '@/shared/primitives';

/**
 * The file operations restore and startup recovery use, as one injectable
 * layer so tests can fail any of them. Every function here is synchronous:
 * the swap runs with the live connection closed and nothing else pending.
 */
export interface RestoreFs {
  exists(file: string): boolean;
  /** Atomic within one filesystem; replaces an existing `to`. */
  rename(from: string, to: string): void;
  /** Removes a file; a missing file is fine. */
  remove(file: string): void;
  /** Removes a directory tree; a missing one is fine. */
  removeTree(dir: string): void;
  /** Copies without ever overwriting `to`. */
  copyFile(from: string, to: string): void;
  fsyncFile(file: string): void;
  /** Best effort: some platforms cannot fsync a directory. */
  fsyncDir(dir: string): void;
  /** Null when the file does not exist. */
  readText(file: string): string | null;
  /** Writes `<file>.tmp`, fsyncs it, renames it over `file`, fsyncs the folder. */
  writeTextDurable(file: string, text: string): void;
}

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Windows cannot open a directory for fsync; rename is durable there.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsyncFile(file: string): void {
  const fd = openSync(file, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export const nodeRestoreFs: RestoreFs = {
  exists: (file) => existsSync(file),
  rename: (from, to) => renameSync(from, to),
  remove: (file) => rmSync(file, { force: true }),
  removeTree: (dir) => rmSync(dir, { recursive: true, force: true }),
  copyFile: (from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL),
  fsyncFile,
  fsyncDir,
  readText(file) {
    try {
      return readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  writeTextDurable(file, text) {
    const temp = `${file}.tmp`;
    const fd = openSync(temp, 'w');
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    fsyncDir(path.dirname(file));
  },
};

// ---- layout and marker ----

export interface RestoreLayout {
  /** `userData/restore-staging/<token>/candidate.sqlite` per inspection. */
  stagingRoot: string;
  /** The durable recovery marker. */
  markerPath: string;
}

export function restoreLayout(dataDir: string): RestoreLayout {
  return {
    stagingRoot: path.join(dataDir, 'restore-staging'),
    markerPath: path.join(dataDir, 'restore-marker.json'),
  };
}

/**
 * PREPARED -> MOVED_ASIDE -> REPLACED -> DONE on the way forward;
 * ROLLING_BACK while recovery moves the old files back (resumable).
 */
export const RESTORE_STAGES = [
  'PREPARED',
  'MOVED_ASIDE',
  'REPLACED',
  'DONE',
  'ROLLING_BACK',
] as const;
export type RestoreStage = (typeof RESTORE_STAGES)[number];

/** Everything recovery needs to finish or undo an interrupted swap. */
export interface RestoreMarkerFields {
  stage: RestoreStage;
  /** userData. */
  dataDir: string;
  /** The live database path (`bengkelin.sqlite`). */
  targetPath: string;
  /** The staged, migrated, validated replacement. */
  stagedPath: string;
  /** Where the live database (and its -wal/-shm) is moved aside. */
  asidePath: string;
  /** The SAFETY backup of the pre-restore database (full path). */
  safetyBackup: string;
  startedAt: Instant;
}

export interface RestoreMarker extends RestoreMarkerFields {
  version: 1;
}

export type MarkerRead =
  | { kind: 'NONE' }
  | { kind: 'UNREADABLE' }
  | { kind: 'MARKER'; marker: RestoreMarker };

/** Durable (fsynced, atomically replaced) marker write. */
export function writeMarker(
  fs: RestoreFs,
  dataDir: string,
  fields: RestoreMarkerFields,
): void {
  const marker: RestoreMarker = { version: 1, ...fields };
  fs.writeTextDurable(
    restoreLayout(dataDir).markerPath,
    `${JSON.stringify(marker, null, 2)}\n`,
  );
}

export function removeMarker(fs: RestoreFs, dataDir: string): void {
  const { markerPath } = restoreLayout(dataDir);
  fs.remove(markerPath);
  fs.remove(`${markerPath}.tmp`);
  fs.fsyncDir(dataDir);
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

export function readMarker(fs: RestoreFs, dataDir: string): MarkerRead {
  const { markerPath } = restoreLayout(dataDir);
  let text: string | null;
  try {
    text = fs.readText(markerPath);
  } catch {
    return { kind: 'UNREADABLE' };
  }
  if (text === null) return { kind: 'NONE' };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { kind: 'UNREADABLE' };
  }
  if (
    raw === null ||
    typeof raw !== 'object' ||
    raw.version !== 1 ||
    !RESTORE_STAGES.includes(raw.stage as RestoreStage) ||
    ![
      raw.dataDir,
      raw.targetPath,
      raw.stagedPath,
      raw.asidePath,
      raw.safetyBackup,
      raw.startedAt,
    ].every(isText)
  ) {
    return { kind: 'UNREADABLE' };
  }
  return { kind: 'MARKER', marker: raw as unknown as RestoreMarker };
}

export const SIDECARS = ['-wal', '-shm'] as const;
/** The main file first, then its sidecars (the order files are moved in). */
export const DATABASE_FILES = ['', ...SIDECARS] as const;
