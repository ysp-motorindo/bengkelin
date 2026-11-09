import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DraftCommandQueue,
  type QueueNotice,
  type SaveState,
} from '@/renderer/features/workspace/draft-command-queue';
import { registerFlusher } from '@/renderer/lib/flush-registry';
import { notifyUnauthenticated } from '@/renderer/lib/session-events';
import type {
  PurchaseDraftView,
  PurchaseDraftOperation,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
export function usePurchaseDraft(
  initial: PurchaseDraftView,
  onNotice: (notice: QueueNotice) => void,
) {
  const [view, setView] = useState(initial);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const queue = useRef<DraftCommandQueue<
    PurchaseDraftView,
    PurchaseDraftOperation
  > | null>(null);
  const notices = useRef(onNotice);
  notices.current = onNotice;
  useEffect(() => {
    setView(initial);
    const q = new DraftCommandQueue<PurchaseDraftView, PurchaseDraftOperation>(
      initial,
      {
        apply: ({ invoiceId, ...command }) =>
          window.bengkelin.purchaseDrafts.apply({
            ...command,
            purchaseId: invoiceId,
          }),
        get: (id) => window.bengkelin.purchaseDrafts.get({ purchaseId: id }),
        newRequestId: () => crypto.randomUUID(),
      },
      {
        view: setView,
        state: setSaveState,
        notice: (n) => {
          if (n.kind === 'unauthenticated') notifyUnauthenticated();
          notices.current(n);
        },
      },
    );
    queue.current = q;
    const unregister = registerFlusher(() => q.flush());
    return () => {
      unregister();
      void q.flush().finally(() => q.close());
      if (queue.current === q) queue.current = null;
    };
  }, [initial.id]);
  const send = useCallback(
    (op: PurchaseDraftOperation): Promise<Result<PurchaseDraftView>> =>
      queue.current?.send(op) ??
      Promise.resolve({
        ok: false,
        error: { code: 'QUEUE_CLOSED', messageKey: 'errors.DRAFT_DISCARDED' },
      }),
    [],
  );
  const edit = useCallback(
    (key: string, op: PurchaseDraftOperation) => queue.current?.edit(key, op),
    [],
  );
  const invalid = useCallback(
    (key: string, value: boolean) => queue.current?.markInvalid(key, value),
    [],
  );
  const dirty = useCallback(
    (key: string) => queue.current?.isDirty(key) ?? false,
    [],
  );
  const flush = useCallback(
    () => queue.current?.flush() ?? Promise.resolve(true),
    [],
  );
  const refresh = useCallback(
    () => queue.current?.refresh() ?? Promise.resolve(),
    [],
  );
  const current = useCallback(() => queue.current?.view ?? initial, [initial]);
  const retry = useCallback(() => queue.current?.retry(), []);
  const cancelPending = useCallback(
    (key: string) => queue.current?.cancelPending(key),
    [],
  );
  return {
    view: view.id === initial.id ? view : initial,
    saveState,
    send,
    edit,
    invalid,
    dirty,
    flush,
    refresh,
    current,
    retry,
    cancelPending,
  };
}
