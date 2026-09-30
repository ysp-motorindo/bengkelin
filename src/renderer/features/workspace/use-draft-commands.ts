import { useCallback, useEffect, useRef, useState } from 'react';
import { registerFlusher } from '@/renderer/lib/flush-registry';
import { notifyUnauthenticated } from '@/renderer/lib/session-events';
import type { DraftOperation, DraftView } from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
import {
  DraftCommandQueue,
  type QueueNotice,
  type SaveState,
  type SendOptions,
} from './draft-command-queue';

export interface UseDraftCommandsOptions {
  initialView: DraftView;
  /** Conflict reloads, closed drafts and failures, for the UI to announce. */
  onNotice?: (notice: QueueNotice) => void;
}

export interface DraftCommands {
  view: DraftView;
  saveState: SaveState;
  send(op: DraftOperation, options?: SendOptions): Promise<Result<DraftView>>;
  edit(key: string, op: DraftOperation): void;
  isDirty(key: string): boolean;
  /** Registers client-invalid input: state 'unsaved', flush() false. */
  markInvalid(key: string, invalid: boolean): void;
  flush(): Promise<boolean>;
  retry(): void;
  /** Reloads from main (e.g. after an ownership transfer elsewhere). */
  reload(): Promise<void>;
}

const unavailable: Result<DraftView> = {
  ok: false,
  error: { code: 'QUEUE_CLOSED', messageKey: 'errors.INTERNAL_ERROR' },
};

/**
 * React binding of the per-draft command queue. One queue per `invoiceId`;
 * it registers itself as a flusher so logout and normal exit wait for it.
 */
export function useDraftCommands(
  invoiceId: string,
  options: UseDraftCommandsOptions,
): DraftCommands {
  const [view, setView] = useState(options.initialView);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const queueRef = useRef<DraftCommandQueue | null>(null);
  const latestView = useRef(options.initialView);
  latestView.current = view.id === invoiceId ? view : options.initialView;
  const noticeRef = useRef(options.onNotice);
  noticeRef.current = options.onNotice;

  useEffect(() => {
    const start = latestView.current;
    setView(start);
    setSaveState('saved');
    const queue = new DraftCommandQueue(
      start,
      {
        apply: (command) => window.bengkelin.drafts.apply(command),
        get: (id) => window.bengkelin.drafts.get(id),
        newRequestId: () => crypto.randomUUID(),
      },
      {
        view: setView,
        state: setSaveState,
        notice: (notice) => {
          if (notice.kind === 'unauthenticated') notifyUnauthenticated();
          noticeRef.current?.(notice);
        },
      },
    );
    queueRef.current = queue;
    const unregister = registerFlusher(() => queue.flush());
    return () => {
      unregister();
      // Unmount/switch: send what is pending, then stop.
      void queue.flush().finally(() => queue.close());
      if (queueRef.current === queue) queueRef.current = null;
    };
  }, [invoiceId]);

  const send = useCallback(
    (op: DraftOperation, sendOptions?: SendOptions) =>
      queueRef.current?.send(op, sendOptions) ?? Promise.resolve(unavailable),
    [],
  );
  const edit = useCallback((key: string, op: DraftOperation) => {
    queueRef.current?.edit(key, op);
  }, []);
  const isDirty = useCallback(
    (key: string) => queueRef.current?.isDirty(key) ?? false,
    [],
  );
  const markInvalid = useCallback((key: string, invalid: boolean) => {
    queueRef.current?.markInvalid(key, invalid);
  }, []);
  const flush = useCallback(
    () => queueRef.current?.flush() ?? Promise.resolve(true),
    [],
  );
  const retry = useCallback(() => queueRef.current?.retry(), []);
  const reload = useCallback(
    () => queueRef.current?.refresh() ?? Promise.resolve(),
    [],
  );

  const current = view.id === invoiceId ? view : options.initialView;
  return {
    view: current,
    saveState,
    send,
    edit,
    isDirty,
    markInvalid,
    flush,
    retry,
    reload,
  };
}
