import { lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseBackupFileName } from './naming';

/** Spec 42: "retention policy, default approximately 30 backups". */
export const AUTO_BACKUPS_KEPT = 30;

export interface PruneOptions {
  /** Never deleted (the automatic backup that was just written). */
  protect?: string;
  /**
   * File names of this folder's recorded successful AUTO runs, newest run
   * first (by `backup_runs` id, i.e. completion order).
   */
  recordedNewestFirst?: readonly string[];
}

/**
 * Keeps the `keep` most recent automatic backups in `dir` and deletes older
 * ones. Only regular files directly in `dir` whose names are exactly
 * `bengkelin-auto-…sqlite` are candidates: manual and safety backups,
 * partial files, folders, links and anything else are never touched.
 *
 * "Recent" never trusts the local-time stamp in the name (the clock may
 * have been wrong when it was written): the protected file first, then
 * files of recorded runs in run order, then unrecorded files by
 * modification time. Returns the names deleted. Called only after a new
 * automatic backup succeeded.
 */
export function pruneAutoBackups(
  dir: string,
  keep: number = AUTO_BACKUPS_KEPT,
  options: PruneOptions = {},
): string[] {
  const recordedRank = new Map<string, number>();
  (options.recordedNewestFirst ?? []).forEach((name, index) => {
    if (!recordedRank.has(name)) recordedRank.set(name, index);
  });
  const rank = (name: string): number =>
    name === options.protect ? -1 : (recordedRank.get(name) ?? Infinity);

  const autos = readdirSync(dir)
    .filter((name) => parseBackupFileName(name)?.kind === 'AUTO')
    .map((name) => ({ name, stat: lstatSync(path.join(dir, name)) }))
    .filter((entry) => entry.stat.isFile())
    // Newest first.
    .sort((a, b) => {
      const byRank = rank(a.name) - rank(b.name);
      if (!Number.isNaN(byRank) && byRank !== 0) return byRank;
      if (b.stat.mtimeMs !== a.stat.mtimeMs) {
        return b.stat.mtimeMs - a.stat.mtimeMs;
      }
      return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
    });
  const deleted: string[] = [];
  for (const { name } of autos.slice(keep)) {
    if (name === options.protect) continue;
    rmSync(path.join(dir, name));
    deleted.push(name);
  }
  return deleted;
}
