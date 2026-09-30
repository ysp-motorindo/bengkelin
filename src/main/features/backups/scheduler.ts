import type { AutomaticBackupOutcome, BackupService } from './service';

/** The timer functions the scheduler uses (injectable for tests). */
export interface BackupTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemTimers: BackupTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

export const BACKUP_CHECK_INTERVAL_MS = 15 * 60_000;

export interface BackupSchedulerDeps {
  backups: Pick<BackupService, 'runAutomaticBackupIfDue'>;
  timers?: BackupTimers;
  intervalMs?: number;
  /** Delay of the startup catch-up check (default: next tick). */
  startupDelayMs?: number;
}

/**
 * Runs the automatic backup while the app is open: a catch-up check right
 * after startup (on a timer, so window creation is never delayed) and then
 * a check every 15 minutes. Whether a backup is due (once per shop
 * business day) is decided by `BackupService` from `backup_runs`, using the
 * injected clock. Overlapping checks are skipped.
 */
export class BackupScheduler {
  private readonly timers: BackupTimers;
  private startup: unknown = null;
  private interval: unknown = null;
  private running: Promise<AutomaticBackupOutcome> | null = null;

  constructor(private readonly deps: BackupSchedulerDeps) {
    this.timers = deps.timers ?? systemTimers;
  }

  start(): void {
    if (this.interval !== null) return;
    this.startup = this.timers.setTimeout(() => {
      this.startup = null;
      void this.check();
    }, this.deps.startupDelayMs ?? 0);
    this.interval = this.timers.setInterval(
      () => void this.check(),
      this.deps.intervalMs ?? BACKUP_CHECK_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.startup !== null) this.timers.clearTimeout(this.startup);
    if (this.interval !== null) this.timers.clearInterval(this.interval);
    this.startup = null;
    this.interval = null;
  }

  /** One check; while one is in flight, the same one is returned. */
  check(): Promise<AutomaticBackupOutcome> {
    this.running ??= this.deps.backups.runAutomaticBackupIfDue().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Resolves when no check is in flight (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }
}
