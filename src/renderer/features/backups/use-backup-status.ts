import { useCallback, useEffect, useState } from 'react';
import type { BackupStatusDto } from '@/shared/contracts';

/**
 * Backup status shared by the ADMIN failure banner and the Settings backup
 * section. After a backup or a folder change, `announceBackupChange()` lets
 * every mounted view refresh at once.
 */

const listeners = new Set<() => void>();

export function announceBackupChange(): void {
  for (const listener of listeners) listener();
}

/** How often an open ADMIN shell re-reads the status (notice freshness). */
export const BACKUP_STATUS_REFRESH_MS = 5 * 60_000;

export function useBackupStatus(options: { poll?: boolean } = {}) {
  const [status, setStatus] = useState<BackupStatusDto | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await window.bengkelin.backups.status();
      if (result.ok) setStatus(result.value);
    } catch {
      // A status read that fails leaves the last known status in place.
    }
  }, []);

  useEffect(() => {
    void refresh();
    listeners.add(refresh);
    const timer = options.poll
      ? setInterval(() => void refresh(), BACKUP_STATUS_REFRESH_MS)
      : undefined;
    return () => {
      listeners.delete(refresh);
      if (timer) clearInterval(timer);
    };
  }, [refresh, options.poll]);

  return { status, setStatus, refresh };
}
