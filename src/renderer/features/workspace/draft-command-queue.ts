import type {
  DraftCommand,
  DraftOperation,
  DraftView,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';

/**
 * Per-draft serialized command queue (T9 ruling; Part A review focus 1).
 *
 * - One command in flight at a time; responses are applied in order.
 * - Each command is built once, when it is first sent: `expectedVersion` =
 *   the latest ACKNOWLEDGED version, plus its own `requestId`. A transport
 *   retry resends the identical command (same requestId), so a retry can
 *   only replay, never apply twice. After a successful retry the queue
 *   reconciles with `drafts.get` (a replayed view may be stale).
 * - Discrete actions (`send`) go immediately; free text (`edit`) is debounced
 *   and coalesced per field key. While a key has unsent or unacknowledged
 *   input, `isDirty(key)` is true and the UI keeps its local value.
 * - Views never go backwards: a response older than the current version is
 *   dropped, so an older response can never overwrite newer state.
 * - DRAFT_VERSION_CONFLICT: reload via `get`, notify, and re-apply the
 *   conflicting debounced text ONCE against the new version. A conflicting
 *   discrete action is returned to its caller (never silently replayed).
 * - DRAFT_DISCARDED / INVOICE_NOT_DRAFT / DRAFT_NOT_FOUND close the queue.
 * - Fields that fail client validation register with `markInvalid(key)`.
 *   While any key is invalid the state is 'unsaved' (never 'saved'), the
 *   field counts as dirty, its stale debounced value is dropped, and
 *   `flush()` resolves false, so review/save/close cannot proceed on the
 *   older server value.
 *
 * Electron- and React-free so it can be tested with fake timers.
 */

export type SaveState = 'saved' | 'saving' | 'failed' | 'unsaved';

export type ClosedCode =
  | 'DRAFT_DISCARDED'
  | 'INVOICE_NOT_DRAFT'
  | 'DRAFT_NOT_FOUND';

export type QueueError = Extract<Result<never>, { ok: false }>['error'];

export type QueueNotice =
  | { kind: 'conflictReloaded' }
  | { kind: 'closed'; code: ClosedCode }
  | { kind: 'unauthenticated' }
  | { kind: 'failed'; error: QueueError };

export interface DraftQueueDeps {
  apply(command: DraftCommand): Promise<Result<DraftView>>;
  get(id: string): Promise<Result<DraftView>>;
  newRequestId(): string;
  /** Free-text debounce. Default 300 ms. */
  debounceMs?: number;
  /** Transport attempts per command before showing Failed. Default 3. */
  maxAttempts?: number;
  /** Base back-off between transport attempts. Default 250 ms. */
  retryDelayMs?: number;
}

export interface DraftQueueListener {
  view(view: DraftView): void;
  state(state: SaveState): void;
  notice(notice: QueueNotice): void;
}

export interface SendOptions {
  /** Reviewed repricing sends the preview's version instead. */
  expectedVersion?: number;
}

interface Item {
  op: DraftOperation;
  key: string | null;
  explicitVersion: number | undefined;
  /** Built once at the first attempt; reused verbatim on transport retry. */
  command: DraftCommand | null;
  replayed: boolean;
  retried: boolean;
  resolve(result: Result<DraftView>): void;
}

const CLOSING_CODES: readonly string[] = [
  'DRAFT_DISCARDED',
  'INVOICE_NOT_DRAFT',
  'DRAFT_NOT_FOUND',
];

const TRANSPORT_FAILED: QueueError = {
  code: 'TRANSPORT_FAILED',
  messageKey: 'errors.INTERNAL_ERROR',
};

const noop = () => undefined;

export class DraftCommandQueue {
  private current: DraftView;
  private readonly invoiceId: string;
  private readonly items: Item[] = [];
  private readonly timers = new Map<
    string,
    { handle: ReturnType<typeof setTimeout>; op: DraftOperation }
  >();
  private readonly failedKeys = new Set<string>();
  private readonly invalidKeys = new Set<string>();
  private idleWaiters: Array<(flushed: boolean) => void> = [];
  private running = false;
  private halted = false;
  private isClosed = false;
  private lastState: SaveState = 'saved';
  private readonly debounceMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(
    initialView: DraftView,
    private readonly deps: DraftQueueDeps,
    private readonly listener: DraftQueueListener,
  ) {
    this.current = initialView;
    this.invoiceId = initialView.id;
    this.debounceMs = deps.debounceMs ?? 300;
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? 3);
    this.retryDelayMs = deps.retryDelayMs ?? 250;
  }

  get view(): DraftView {
    return this.current;
  }

  get version(): number {
    return this.current.version;
  }

  get saveState(): SaveState {
    return this.lastState;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** A discrete action: queued immediately; resolves with its own result. */
  send(
    op: DraftOperation,
    options: SendOptions = {},
  ): Promise<Result<DraftView>> {
    if (this.isClosed) return Promise.resolve(this.closedResult());
    return new Promise((resolve) => {
      this.items.push({
        op,
        key: null,
        explicitVersion: options.expectedVersion,
        command: null,
        replayed: false,
        retried: false,
        resolve,
      });
      this.emitState();
      void this.pump();
    });
  }

  /** Free text for one field: debounced; only the latest value is sent. */
  edit(key: string, op: DraftOperation): void {
    if (this.isClosed) return;
    this.invalidKeys.delete(key);
    const pending = this.timers.get(key);
    if (pending) clearTimeout(pending.handle);
    const handle = setTimeout(() => {
      this.timers.delete(key);
      this.enqueueText(key, op);
    }, this.debounceMs);
    this.timers.set(key, { handle, op });
    this.emitState();
  }

  /** True while the field has input that is not yet acknowledged. */
  isDirty(key: string): boolean {
    return (
      this.invalidKeys.has(key) ||
      this.timers.has(key) ||
      this.items.some((item) => item.key === key)
    );
  }

  /**
   * Registers (or clears) client-side invalid input for a field. An invalid
   * field's pending debounced value is stale, so it is dropped, never sent.
   */
  markInvalid(key: string, invalid: boolean): void {
    if (this.isClosed) return;
    if (invalid) {
      const pending = this.timers.get(key);
      if (pending) {
        clearTimeout(pending.handle);
        this.timers.delete(key);
      }
      this.invalidKeys.add(key);
    } else {
      this.invalidKeys.delete(key);
    }
    this.emitState();
  }

  /**
   * Sends pending debounced text now and resolves once everything queued is
   * acknowledged: true, or false when the queue is stuck on a transport
   * failure (see `retry`) or a field still holds invalid (unsent) input.
   */
  flush(): Promise<boolean> {
    for (const [key, { handle, op }] of this.timers) {
      clearTimeout(handle);
      this.timers.delete(key);
      this.enqueueText(key, op);
    }
    if (this.halted) return Promise.resolve(false);
    if (this.isIdle()) return Promise.resolve(this.invalidKeys.size === 0);
    return new Promise<boolean>((resolve) => {
      this.idleWaiters.push(resolve);
      void this.pump();
    }).then((flushed) => flushed && this.invalidKeys.size === 0);
  }

  /**
   * Re-reads the draft after changes made outside this queue (for example an
   * ownership transfer that changes `ownerMismatch`). Pending input first.
   */
  async refresh(): Promise<void> {
    await this.flush();
    if (!this.isClosed) await this.reload(false);
  }

  /** Resumes after exhausted transport retries (same requestIds). */
  retry(): void {
    if (!this.halted || this.isClosed) return;
    this.halted = false;
    this.emitState();
    void this.pump();
  }

  /** Stops the queue: timers cleared; pending callers get QUEUE_CLOSED. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const { handle } of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    const closed = this.closedResult();
    for (const item of this.items.splice(0)) item.resolve(closed);
    this.settleWaiters(false);
  }

  // ---- internals ----

  private enqueueText(key: string, op: DraftOperation): void {
    if (this.isClosed) return;
    this.items.push({
      op,
      key,
      explicitVersion: undefined,
      command: null,
      replayed: false,
      retried: false,
      resolve: noop,
    });
    this.emitState();
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length > 0 && !this.halted && !this.isClosed) {
        await this.execute(this.items[0]!);
      }
    } finally {
      this.running = false;
      this.emitState();
      if (this.halted) this.settleWaiters(false);
      else if (this.isIdle()) this.settleWaiters(true);
    }
  }

  private async execute(item: Item): Promise<void> {
    item.command ??= {
      requestId: this.deps.newRequestId(),
      invoiceId: this.invoiceId,
      expectedVersion: item.explicitVersion ?? this.current.version,
      op: item.op,
    };
    const result = await this.withTransportRetry(
      () => this.deps.apply(item.command!),
      () => {
        item.retried = true;
      },
    );
    if (result === null) {
      // Exhausted: keep the command at the head for `retry()`.
      this.halted = true;
      this.listener.notice({ kind: 'failed', error: TRANSPORT_FAILED });
      return;
    }
    if (this.isClosed) return;
    this.items.shift();

    if (result.ok) {
      this.acceptView(result.value);
      if (item.key) this.failedKeys.delete(item.key);
      if (item.retried) await this.reload(false);
      item.resolve(result);
      return;
    }

    const { code } = result.error;
    if (code === 'DRAFT_VERSION_CONFLICT') {
      await this.reload(true);
      if (
        item.key &&
        !item.replayed &&
        !this.isClosed &&
        // A newer edit of the same field supersedes the conflicting one.
        !this.isDirty(item.key)
      ) {
        this.items.unshift({
          ...item,
          command: null,
          replayed: true,
          retried: false,
        });
      } else if (item.key) {
        this.failedKeys.add(item.key);
        this.listener.notice({ kind: 'failed', error: result.error });
      }
      item.resolve(result);
      return;
    }
    if (CLOSING_CODES.includes(code)) {
      item.resolve(result);
      this.closeWith(code as ClosedCode, result);
      return;
    }
    if (code === 'UNAUTHENTICATED') {
      this.listener.notice({ kind: 'unauthenticated' });
    }
    if (item.key) {
      this.failedKeys.add(item.key);
      this.listener.notice({ kind: 'failed', error: result.error });
    }
    item.resolve(result);
  }

  /** Reloads with `drafts.get`; used after conflicts and replays. */
  private async reload(notify: boolean): Promise<void> {
    const result = await this.withTransportRetry(
      () => this.deps.get(this.invoiceId),
      noop,
    );
    if (result === null || this.isClosed) return;
    if (result.ok) {
      this.acceptView(result.value);
      if (notify) this.listener.notice({ kind: 'conflictReloaded' });
      return;
    }
    if (CLOSING_CODES.includes(result.error.code)) {
      this.closeWith(result.error.code as ClosedCode, result);
    } else if (result.error.code === 'UNAUTHENTICATED') {
      this.listener.notice({ kind: 'unauthenticated' });
    }
  }

  private async withTransportRetry<T>(
    call: () => Promise<T>,
    onRetry: () => void,
  ): Promise<T | null> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call();
      } catch {
        if (attempt >= this.maxAttempts || this.isClosed) return null;
        onRetry();
        await new Promise((resolve) =>
          setTimeout(resolve, this.retryDelayMs * attempt),
        );
      }
    }
  }

  private acceptView(view: DraftView): void {
    if (view.id !== this.invoiceId) return;
    if (view.version < this.current.version) return; // stale: never go back
    this.current = view;
    this.listener.view(view);
  }

  private closeWith(code: ClosedCode, result: Result<DraftView>): void {
    this.isClosed = true;
    for (const { handle } of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    for (const item of this.items.splice(0)) item.resolve(result);
    this.listener.notice({ kind: 'closed', code });
    this.settleWaiters(true);
  }

  private closedResult(): Result<DraftView> {
    return {
      ok: false,
      error: { code: 'QUEUE_CLOSED', messageKey: 'errors.DRAFT_DISCARDED' },
    };
  }

  private isIdle(): boolean {
    return this.items.length === 0 && this.timers.size === 0 && !this.running;
  }

  private settleWaiters(flushed: boolean): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve(flushed);
  }

  private computeState(): SaveState {
    if (this.halted) return 'failed';
    if (this.invalidKeys.size > 0) return 'unsaved';
    if (this.items.length > 0 || this.timers.size > 0) return 'saving';
    return this.failedKeys.size > 0 ? 'failed' : 'saved';
  }

  private emitState(): void {
    const next = this.computeState();
    if (next === this.lastState) return;
    this.lastState = next;
    this.listener.state(next);
  }
}
