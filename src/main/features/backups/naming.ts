import { existsSync } from 'node:fs';
import path from 'node:path';
import { Temporal } from 'temporal-polyfill';
import type { BackupKind } from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';

/**
 * Backup file names: `bengkelin-<auto|manual|safety>-YYYYMMDD-HHmmss.sqlite`
 * in shop-timezone local time, with `-2`, `-3`, ... on a collision. The kind
 * is part of the name so retention can recognise (and prune) automatic
 * backups only.
 */

const PREFIX = 'bengkelin';
const EXTENSION = '.sqlite';
/** The suffix of a backup still being written and validated. */
export const PARTIAL_SUFFIX = '.partial';

const KIND_BY_TOKEN: Record<string, BackupKind> = {
  auto: 'AUTO',
  manual: 'MANUAL',
  safety: 'SAFETY',
};

// `-1` is never produced (the first file has no suffix), and no leading zeros.
const PATTERN =
  /^bengkelin-(auto|manual|safety)-(\d{8}-\d{6})(?:-([2-9]|[1-9]\d+))?\.sqlite$/;

export interface ParsedBackupName {
  kind: BackupKind;
  /** `YYYYMMDD-HHmmss`, shop local time. */
  stamp: string;
  /** 1 for the unsuffixed name, then 2, 3, ... */
  sequence: number;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `YYYYMMDD-HHmmss` of the instant in the shop timezone. */
export function backupStamp(at: Instant, timezone: string): string {
  const local = Temporal.Instant.from(at).toZonedDateTimeISO(timezone);
  return (
    `${pad(local.year, 4)}${pad(local.month)}${pad(local.day)}-` +
    `${pad(local.hour)}${pad(local.minute)}${pad(local.second)}`
  );
}

export function backupFileName(
  kind: BackupKind,
  at: Instant,
  timezone: string,
  sequence = 1,
): string {
  const suffix = sequence > 1 ? `-${sequence}` : '';
  return `${PREFIX}-${kind.toLowerCase()}-${backupStamp(at, timezone)}${suffix}${EXTENSION}`;
}

/** Null for anything that is not exactly a Bengkelin backup file name. */
export function parseBackupFileName(name: string): ParsedBackupName | null {
  const match = PATTERN.exec(name);
  if (!match) return null;
  return {
    kind: KIND_BY_TOKEN[match[1] as string] as BackupKind,
    stamp: match[2] as string,
    sequence: match[3] ? Number(match[3]) : 1,
  };
}

/**
 * The first name not already used in `dir`, as a final file or as a partial
 * one (a crashed attempt keeps its name reserved). Never overwrites.
 */
export function availableBackupName(
  dir: string,
  kind: BackupKind,
  at: Instant,
  timezone: string,
): string {
  for (let sequence = 1; ; sequence += 1) {
    const name = backupFileName(kind, at, timezone, sequence);
    const file = path.join(dir, name);
    if (!existsSync(file) && !existsSync(file + PARTIAL_SUFFIX)) return name;
  }
}
