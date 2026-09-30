import { DomainError } from '@/shared/primitives';

type Mode = 'OPEN' | 'WRITES_BLOCKED' | 'CLOSED';

const inProgress = () =>
  new DomainError('RESTORE_IN_PROGRESS', 'A database restore is in progress');

/**
 * The main-process maintenance flag for restore (T16). The command table
 * runs every mutating command through `runWrite` and every read through
 * `assertReadable`:
 *  - OPEN: everything runs;
 *  - WRITES_BLOCKED (restore started): mutating commands are refused with
 *    RESTORE_IN_PROGRESS, reads continue, and `drain()` waits for writes
 *    that were already running;
 *  - CLOSED (the live connection is closed for the swap): every command is
 *    refused until the app restarts.
 * `reopen()` clears the flag when a restore fails before the swap.
 */
export class MaintenanceGate {
  private mode: Mode = 'OPEN';
  private inFlight = 0;
  private idle: (() => void)[] = [];

  get active(): boolean {
    return this.mode !== 'OPEN';
  }

  assertWritable(): void {
    if (this.mode !== 'OPEN') throw inProgress();
  }

  assertReadable(): void {
    if (this.mode === 'CLOSED') throw inProgress();
  }

  /**
   * Runs a mutating command. `work` starts synchronously (the command's
   * ordering is unchanged); its completion is tracked for `drain()`.
   */
  async runWrite<T>(work: () => T | Promise<T>): Promise<T> {
    this.assertWritable();
    this.inFlight += 1;
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        for (const resolve of this.idle.splice(0)) resolve();
      }
    }
  }

  /** Starts maintenance; throws RESTORE_IN_PROGRESS when already active. */
  blockWrites(): void {
    if (this.mode !== 'OPEN') throw inProgress();
    this.mode = 'WRITES_BLOCKED';
  }

  /** Resolves true once no write is running, false after `timeoutMs`. */
  drain(timeoutMs: number): Promise<boolean> {
    if (this.inFlight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onIdle = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.idle = this.idle.filter((entry) => entry !== onIdle);
        resolve(false);
      }, timeoutMs);
      this.idle.push(onIdle);
    });
  }

  /** The live connection is being closed: refuse every command. */
  close(): void {
    this.mode = 'CLOSED';
  }

  /** A restore failed before the swap: back to normal. */
  reopen(): void {
    this.mode = 'OPEN';
  }
}
