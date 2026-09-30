import { lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseBackupFileName } from './naming';

/** Spec 42: "retention policy, default approximately 30 backups". */
export const AUTO_BACKUPS_KEPT = 30;

/**
 * Keeps the `keep` most recent automatic backups in `dir` and deletes older
 * ones. Only regular files directly in `dir` whose names are exactly
 * `bengkelin-auto-…sqlite` are candidates: manual and safety backups,
 * partial files, folders, links and anything else are never touched.
 * Returns the names deleted. Called only after a new automatic backup
 * succeeded.
 */
export function pruneAutoBackups(
  dir: string,
  keep: number = AUTO_BACKUPS_KEPT,
): string[] {
  const autos = readdirSync(dir)
    .map((name) => ({ name, parsed: parseBackupFileName(name) }))
    .filter(
      (entry) =>
        entry.parsed?.kind === 'AUTO' &&
        lstatSync(path.join(dir, entry.name)).isFile(),
    )
    // Newest first: by local timestamp, then by collision sequence.
    .sort((a, b) =>
      a.parsed!.stamp === b.parsed!.stamp
        ? b.parsed!.sequence - a.parsed!.sequence
        : a.parsed!.stamp < b.parsed!.stamp
          ? 1
          : -1,
    );
  const deleted: string[] = [];
  for (const { name } of autos.slice(keep)) {
    rmSync(path.join(dir, name));
    deleted.push(name);
  }
  return deleted;
}
