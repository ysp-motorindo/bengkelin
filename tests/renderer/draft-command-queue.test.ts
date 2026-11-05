import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DraftCommandQueue,
  type QueueNotice,
  type SaveState,
} from '@/renderer/features/workspace/draft-command-queue';
import { useDraftCommands } from '@/renderer/features/workspace/use-draft-commands';
import { flushAll } from '@/renderer/lib/flush-registry';
import type { DraftCommand, DraftView } from '@/shared/contracts';
import type { Result } from '@/shared/primitives';

const INVOICE = '7d8f5a3e-1c2b-4a55-9c5b-0a8f3f0b9d11';

function makeView(version: number, extra: Partial<DraftView> = {}): DraftView {
  return {
    stockLocation: {
      id: '11111111-1111-4111-8111-111111111119',
      code: '01',
      label: 'Gudang',
    },
    cashReceived: '0',
    invoiceNumber: 'INV-20260930-0001',
    taxInvoiceNumber: null,
    id: INVOICE,
    status: 'DRAFT',
    version,
    channelId: 'c1',
    channelLabel: 'Bengkel',
    invoiceDate: '2026-09-30',
    pricingAt: '2026-09-30T03:00:00.000Z',
    topDays: 0,
    dueDate: '2026-09-30',
    sales: null,
    expedition: null,
    customer: null,
    vehicle: null,
    customerOutstandingAmount: null,
    ownerMismatch: false,
    odometerKm: null,
    note: null,
    lines: [],
    invoiceDiscounts: [],
    checkoutAllocations: [],
    checkoutTenders: [],
    paymentSummary: {
      receivedAmount: '0',
      cashReceived: '0',
      changeAmount: '0',
      nonCashExcess: '0',
    },
    totals: {
      subtotal: '0',
      itemDiscountAmount: '0',
      invoiceDiscountAmount: '0',
      discountAmount: '0',
      amount: '0',
      allocatedAmount: '0',
      unallocatedAmount: '0',
    },
    allocationsExceedAmount: false,
    createdBy: { id: 'a', displayName: 'Siti' },
    lastEditedBy: { id: 'a', displayName: 'Siti' },
    createdAt: '2026-09-30T03:00:00.000Z',
    updatedAt: '2026-09-30T03:00:00.000Z',
    discardedAt: null,
    ...extra,
  };
}

const ok = (value: DraftView): Result<DraftView> => ({ ok: true, value });
const fail = (code: string): Result<DraftView> => ({
  ok: false,
  error: { code, messageKey: `errors.${code}` },
});

interface Deferred {
  command: DraftCommand;
  resolve(result: Result<DraftView>): void;
  reject(error: unknown): void;
}

/** A fake server: every apply call is parked until the test settles it. */
function fakeServer() {
  const calls: Deferred[] = [];
  const apply = vi.fn(
    (command: DraftCommand) =>
      new Promise<Result<DraftView>>((resolve, reject) => {
        calls.push({ command, resolve, reject });
      }),
  );
  const get = vi.fn(async (_id: string) => ok(makeView(1)));
  let counter = 0;
  const newRequestId = () => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  };
  return { calls, apply, get, newRequestId };
}

function setup(initialVersion = 1) {
  const server = fakeServer();
  const views: DraftView[] = [];
  const states: SaveState[] = [];
  const notices: QueueNotice[] = [];
  const queue = new DraftCommandQueue(
    makeView(initialVersion),
    {
      apply: server.apply,
      get: server.get,
      newRequestId: server.newRequestId,
      retryDelayMs: 0,
    },
    {
      view: (view) => views.push(view),
      state: (state) => states.push(state),
      notice: (notice) => notices.push(notice),
    },
  );
  return { server, queue, views, states, notices };
}

/** Lets pending promise callbacks run (microtasks) without advancing timers. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('DraftCommandQueue', () => {
  test('serializes commands: one in flight, each with the latest acknowledged version and its own requestId', async () => {
    const { server, queue } = setup(1);
    const first = queue.send({ kind: 'addCatalogLine', barcode: '111' });
    const second = queue.send({ kind: 'addCatalogLine', barcode: '222' });
    await settle();
    expect(server.apply).toHaveBeenCalledTimes(1);
    expect(server.calls[0]!.command.expectedVersion).toBe(1);

    server.calls[0]!.resolve(ok(makeView(2)));
    await settle();
    expect(server.apply).toHaveBeenCalledTimes(2);
    expect(server.calls[1]!.command.expectedVersion).toBe(2);
    expect(server.calls[1]!.command.op).toMatchObject({ barcode: '222' });
    expect(server.calls[1]!.command.requestId).not.toBe(
      server.calls[0]!.command.requestId,
    );
    server.calls[1]!.resolve(ok(makeView(3)));
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(queue.version).toBe(3);
    expect(queue.saveState).toBe('saved');
  });

  test('reports Saving until acknowledged, never Saved early', async () => {
    const { server, queue, states } = setup(1);
    void queue.send({ kind: 'removeLine', lineId: INVOICE });
    expect(queue.saveState).toBe('saving');
    await settle();
    expect(queue.saveState).toBe('saving');
    server.calls[0]!.resolve(ok(makeView(2)));
    await settle();
    expect(queue.saveState).toBe('saved');
    expect(states).toEqual(['saving', 'saved']);
  });

  test('a transport failure is retried with the SAME requestId, then reconciled with drafts.get', async () => {
    const { server, queue } = setup(1);
    server.get.mockResolvedValueOnce(ok(makeView(2, { note: 'fresh' })));
    const result = queue.send({ kind: 'removeLine', lineId: INVOICE });
    await settle();
    server.calls[0]!.reject(new Error('ipc down'));
    await vi.runAllTimersAsync();
    expect(server.apply).toHaveBeenCalledTimes(2);
    expect(server.calls[1]!.command.requestId).toBe(
      server.calls[0]!.command.requestId,
    );
    expect(server.calls[1]!.command.expectedVersion).toBe(1);
    // The replayed view may be stale; the queue reconciles with get.
    server.calls[1]!.resolve(ok(makeView(2)));
    await expect(result).resolves.toMatchObject({ ok: true });
    await settle();
    expect(server.get).toHaveBeenCalledWith(INVOICE);
    expect(queue.view.note).toBe('fresh');
  });

  test('exhausted transport retries show Failed; retry() resends the same requestId', async () => {
    const { server, queue, notices } = setup(1);
    void queue.send({ kind: 'removeLine', lineId: INVOICE });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.runAllTimersAsync();
      server.calls[attempt]!.reject(new Error('ipc down'));
    }
    await vi.runAllTimersAsync();
    expect(queue.saveState).toBe('failed');
    expect(notices.some((n) => n.kind === 'failed')).toBe(true);
    const flushed = await queue.flush();
    expect(flushed).toBe(false);

    queue.retry();
    await vi.runAllTimersAsync();
    const last = server.calls.at(-1)!;
    expect(last.command.requestId).toBe(server.calls[0]!.command.requestId);
    last.resolve(ok(makeView(2)));
    await vi.runAllTimersAsync();
    expect(queue.saveState).toBe('saved');
  });

  test('an older response never overwrites newer state (stale views are dropped)', async () => {
    const { server, queue, views } = setup(5);
    server.get.mockResolvedValueOnce(ok(makeView(9, { note: 'newest' })));
    // A replay returns the stored (older) view.
    const pending = queue.send({ kind: 'removeLine', lineId: INVOICE });
    await settle();
    server.calls[0]!.reject(new Error('timeout'));
    await vi.runAllTimersAsync();
    server.calls[1]!.resolve(ok(makeView(4, { note: 'old replay' })));
    await pending;
    await vi.runAllTimersAsync();
    expect(views.map((v) => v.note)).not.toContain('old replay');
    expect(queue.view.note).toBe('newest');
    expect(queue.version).toBe(9);
  });

  test('free text is debounced 300 ms and only the latest value is sent', async () => {
    const { server, queue } = setup(1);
    queue.edit('note', {
      kind: 'updateHeader',
      changes: { note: 'G' },
    });
    queue.edit('note', {
      kind: 'updateHeader',
      changes: { note: 'Ganti' },
    });
    expect(queue.isDirty('note')).toBe(true);
    expect(queue.saveState).toBe('saving');
    await vi.advanceTimersByTimeAsync(299);
    expect(server.apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(server.apply).toHaveBeenCalledTimes(1);
    expect(server.calls[0]!.command.op).toEqual({
      kind: 'updateHeader',
      changes: { note: 'Ganti' },
    });
    expect(queue.isDirty('note')).toBe(true); // sent, not yet acknowledged
    server.calls[0]!.resolve(ok(makeView(2, { note: 'Ganti' })));
    await settle();
    expect(queue.isDirty('note')).toBe(false);
    expect(queue.saveState).toBe('saved');
  });

  test('discrete actions go immediately, even while text is being debounced', async () => {
    const { server, queue } = setup(1);
    queue.edit('note', { kind: 'updateHeader', changes: { note: 'x' } });
    void queue.send({ kind: 'addCatalogLine', barcode: '111' });
    await settle();
    expect(server.apply).toHaveBeenCalledTimes(1);
    expect(server.calls[0]!.command.op.kind).toBe('addCatalogLine');
  });

  test('flush sends pending debounced text at once and resolves after acknowledgement', async () => {
    const { server, queue } = setup(1);
    queue.edit('odometer', {
      kind: 'updateHeader',
      changes: { odometerKm: 15200 },
    });
    const flushed = queue.flush();
    await settle();
    expect(server.apply).toHaveBeenCalledTimes(1);
    let done = false;
    void flushed.then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
    server.calls[0]!.resolve(ok(makeView(2, { odometerKm: 15200 })));
    await expect(flushed).resolves.toBe(true);
    expect(queue.saveState).toBe('saved');
  });

  test('DRAFT_VERSION_CONFLICT reloads, notifies, and re-applies unsent text once against the new version', async () => {
    const { server, queue, notices } = setup(1);
    server.get.mockResolvedValueOnce(
      ok(makeView(4, { note: 'theirs', odometerKm: 999 })),
    );
    queue.edit('note', { kind: 'updateHeader', changes: { note: 'mine' } });
    await vi.advanceTimersByTimeAsync(300);
    server.calls[0]!.resolve(fail('DRAFT_VERSION_CONFLICT'));
    await settle();
    expect(server.get).toHaveBeenCalledWith(INVOICE);
    expect(notices).toContainEqual({ kind: 'conflictReloaded' });
    await settle();
    expect(server.apply).toHaveBeenCalledTimes(2);
    const replay = server.calls[1]!.command;
    expect(replay.expectedVersion).toBe(4);
    expect(replay.op).toEqual({
      kind: 'updateHeader',
      changes: { note: 'mine' },
    });
    expect(replay.requestId).not.toBe(server.calls[0]!.command.requestId);
    expect(queue.isDirty('note')).toBe(true);

    // A second conflict is not replayed again.
    server.get.mockResolvedValueOnce(ok(makeView(6)));
    server.calls[1]!.resolve(fail('DRAFT_VERSION_CONFLICT'));
    await vi.runAllTimersAsync();
    expect(server.apply).toHaveBeenCalledTimes(2);
    expect(queue.saveState).toBe('failed');
    expect(queue.version).toBe(6);
  });

  test('a conflicting discrete action is not replayed; its caller gets the conflict', async () => {
    const { server, queue } = setup(1);
    server.get.mockResolvedValueOnce(ok(makeView(3)));
    const scan = queue.send({ kind: 'addCatalogLine', barcode: '111' });
    await settle();
    server.calls[0]!.resolve(fail('DRAFT_VERSION_CONFLICT'));
    await expect(scan).resolves.toMatchObject({
      ok: false,
      error: { code: 'DRAFT_VERSION_CONFLICT' },
    });
    await settle();
    expect(server.apply).toHaveBeenCalledTimes(1);
    expect(queue.version).toBe(3);
  });

  test('a queued command after a conflict uses the reloaded version', async () => {
    const { server, queue } = setup(1);
    server.get.mockResolvedValueOnce(ok(makeView(7)));
    void queue.send({ kind: 'addCatalogLine', barcode: '111' });
    void queue.send({ kind: 'addCatalogLine', barcode: '222' });
    await settle();
    server.calls[0]!.resolve(fail('DRAFT_VERSION_CONFLICT'));
    await settle();
    await settle();
    expect(server.calls[1]!.command.expectedVersion).toBe(7);
  });

  test.each(['DRAFT_DISCARDED', 'INVOICE_NOT_DRAFT'])(
    '%s closes the queue and reports it',
    async (code) => {
      const { server, queue, notices } = setup(1);
      const first = queue.send({ kind: 'addCatalogLine', barcode: '111' });
      const second = queue.send({ kind: 'addCatalogLine', barcode: '222' });
      await settle();
      server.calls[0]!.resolve(fail(code));
      await expect(first).resolves.toMatchObject({ ok: false });
      await expect(second).resolves.toMatchObject({ ok: false });
      expect(notices).toContainEqual({ kind: 'closed', code });
      expect(server.apply).toHaveBeenCalledTimes(1);
      expect(queue.closed).toBe(true);
    },
  );

  test('UNAUTHENTICATED is reported so the app can return to login', async () => {
    const { server, queue, notices } = setup(1);
    const result = queue.send({ kind: 'addCatalogLine', barcode: '111' });
    await settle();
    server.calls[0]!.resolve(fail('UNAUTHENTICATED'));
    await expect(result).resolves.toMatchObject({ ok: false });
    expect(notices).toContainEqual({ kind: 'unauthenticated' });
  });

  test('a rejected discrete action (e.g. UNKNOWN_BARCODE) returns to its caller and leaves the draft Saved', async () => {
    const { server, queue } = setup(1);
    const result = queue.send({ kind: 'addCatalogLine', barcode: '000' });
    await settle();
    server.calls[0]!.resolve(fail('UNKNOWN_BARCODE'));
    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_BARCODE' },
    });
    expect(queue.saveState).toBe('saved');
    expect(queue.version).toBe(1);
  });

  test('a rejected text edit shows Failed (the input was not saved)', async () => {
    const { server, queue } = setup(1);
    queue.edit('odometer', {
      kind: 'updateHeader',
      changes: { odometerKm: 1 },
    });
    await vi.advanceTimersByTimeAsync(300);
    server.calls[0]!.resolve(fail('VALIDATION_FAILED'));
    await settle();
    expect(queue.saveState).toBe('failed');
    // A later successful edit of the same field clears it.
    queue.edit('odometer', {
      kind: 'updateHeader',
      changes: { odometerKm: 2 },
    });
    await vi.advanceTimersByTimeAsync(300);
    server.calls[1]!.resolve(ok(makeView(2)));
    await settle();
    expect(queue.saveState).toBe('saved');
  });

  test('an explicit expectedVersion (reviewed repricing) is honoured', async () => {
    const { server, queue } = setup(3);
    void queue.send(
      {
        kind: 'applyPriceRefresh',
        lines: [
          {
            lineId: INVOICE,
            resolvedPriceId: INVOICE,
            proposedUnitPrice: '1',
          },
        ],
      },
      { expectedVersion: 2 },
    );
    await settle();
    expect(server.calls[0]!.command.expectedVersion).toBe(2);
  });
});

describe('DraftCommandQueue invalid unsent input (C1)', () => {
  const discountOp = (bps: number) => ({
    kind: 'setInvoiceDiscounts' as const,
    stages: [bps],
  });

  test('an invalid field is never "saved"; flush resolves false while it is invalid', async () => {
    const { server, queue, states } = setup(1);
    queue.edit('allocations', {
      kind: 'setCheckoutAllocations',
      allocations: [{ method: 'CASH', amount: '150' }],
    });
    await vi.advanceTimersByTimeAsync(300);
    server.calls[0]!.resolve(ok(makeView(2)));
    await settle();
    expect(queue.saveState).toBe('saved');

    queue.markInvalid('allocations', true);
    expect(queue.saveState).toBe('unsaved');
    expect(states.at(-1)).toBe('unsaved');
    expect(queue.isDirty('allocations')).toBe(true);
    await expect(queue.flush()).resolves.toBe(false);
    expect(server.apply).toHaveBeenCalledTimes(1);

    queue.markInvalid('allocations', false);
    expect(queue.saveState).toBe('saved');
    await expect(queue.flush()).resolves.toBe(true);
  });

  test('marking a field invalid drops its pending debounced (stale) value', async () => {
    const { server, queue } = setup(1);
    queue.edit('invoiceDiscounts', discountOp(1000));
    queue.markInvalid('invoiceDiscounts', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.apply).not.toHaveBeenCalled();
    expect(queue.saveState).toBe('unsaved');
  });

  test('a valid edit of the field clears its invalid mark', async () => {
    const { server, queue } = setup(1);
    queue.markInvalid('odometer', true);
    queue.edit('odometer', {
      kind: 'updateHeader',
      changes: { odometerKm: 12 },
    });
    const flushed = queue.flush();
    await settle();
    server.calls[0]!.resolve(ok(makeView(2)));
    await expect(flushed).resolves.toBe(true);
    expect(queue.saveState).toBe('saved');
  });

  test('flush still sends other pending fields but reports not flushed', async () => {
    const { server, queue } = setup(1);
    queue.edit('note', { kind: 'updateHeader', changes: { note: 'x' } });
    queue.markInvalid('topDays', true);
    const flushed = queue.flush();
    await settle();
    expect(server.apply).toHaveBeenCalledTimes(1);
    server.calls[0]!.resolve(ok(makeView(2)));
    await expect(flushed).resolves.toBe(false);
    expect(queue.saveState).toBe('unsaved');
  });
});

describe('useDraftCommands', () => {
  test('exposes the view and save state, and registers a flusher for exit/logout', async () => {
    const server = fakeServer();
    (window as unknown as { bengkelin: unknown }).bengkelin = {
      drafts: { apply: server.apply, get: server.get },
    };
    const { result } = renderHook(() =>
      useDraftCommands(INVOICE, { initialView: makeView(1) }),
    );
    expect(result.current.view.version).toBe(1);
    expect(result.current.saveState).toBe('saved');

    act(() => {
      result.current.edit('note', {
        kind: 'updateHeader',
        changes: { note: 'hi' },
      });
    });
    expect(result.current.saveState).toBe('saving');
    let flushed: Promise<boolean> | undefined;
    act(() => {
      flushed = flushAll();
    });
    await act(async () => {
      await settle();
    });
    expect(server.apply).toHaveBeenCalledTimes(1);
    await act(async () => {
      server.calls[0]!.resolve(ok(makeView(2, { note: 'hi' })));
      await settle();
    });
    await expect(flushed).resolves.toBe(true);
    expect(result.current.view.note).toBe('hi');
    expect(result.current.saveState).toBe('saved');
  });

  test('markInvalid makes the hook report "unsaved" and flushAll false', async () => {
    const server = fakeServer();
    (window as unknown as { bengkelin: unknown }).bengkelin = {
      drafts: { apply: server.apply, get: server.get },
    };
    const { result } = renderHook(() =>
      useDraftCommands(INVOICE, { initialView: makeView(1) }),
    );
    act(() => {
      result.current.markInvalid('allocations', true);
    });
    expect(result.current.saveState).toBe('unsaved');
    await expect(flushAll()).resolves.toBe(false);
    act(() => {
      result.current.markInvalid('allocations', false);
    });
    expect(result.current.saveState).toBe('saved');
  });
});

describe('deferred inline edits', () => {
  test('stage waits for flush and latest staged value wins', async () => {
    const { queue, server } = setup();
    queue.stage('qty', { kind: 'updateLine', lineId: 'line', quantity: 2 });
    queue.stage('qty', { kind: 'updateLine', lineId: 'line', quantity: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.apply).not.toHaveBeenCalled();
    expect(queue.isDirty('qty')).toBe(true);
    const flushed = queue.flush();
    expect(server.calls[0]!.command.op).toMatchObject({ quantity: 3 });
    server.calls[0]!.resolve(ok(makeView(2)));
    expect(await flushed).toBe(true);
    expect(queue.isDirty('qty')).toBe(false);
  });
  test('cancel removes staged input and invalid markers without sending', async () => {
    const { queue, server } = setup();
    queue.stage('qty', { kind: 'updateLine', lineId: 'line', quantity: 2 });
    queue.cancelPending('qty');
    queue.markInvalid('bad', true);
    queue.cancelPending('bad');
    expect(await queue.flush()).toBe(true);
    expect(server.apply).not.toHaveBeenCalled();
  });
  test('retry reuses the staged command identity', async () => {
    const { queue, server } = setup();
    queue.stage('qty', { kind: 'updateLine', lineId: 'line', quantity: 2 });
    const flushed = queue.flush();
    server.calls[0]!.reject(new Error('offline'));
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls[1]!.command).toEqual(server.calls[0]!.command);
    server.get.mockResolvedValue(ok(makeView(2)));
    server.calls[1]!.resolve(ok(makeView(2)));
    expect(await flushed).toBe(true);
  });
});

describe('inline cancellation and rejected saves', () => {
  test('Escape cancels a keyed edit queued behind an in-flight command', async () => {
    const { queue, server } = setup();
    const first = queue.send({ kind: 'addCatalogLine', barcode: '111' });
    queue.stage('qty', { kind: 'updateLine', lineId: 'line', quantity: 3 });
    const flushed = queue.flush();
    queue.cancelPending('qty');
    server.calls[0]!.resolve(ok(makeView(2)));
    await first;
    await settle();
    expect(server.calls).toHaveLength(1);
    expect(await flushed).toBe(true);
  });
  test('a rejected staged edit stays dirty and blocks flush until cancelled', async () => {
    const { queue, server } = setup();
    queue.stage('mechanic', {
      kind: 'updateLine',
      lineId: 'line',
      mechanicId: 'inactive',
    });
    const flushed = queue.flush();
    server.calls[0]!.resolve(fail('MECHANIC_INACTIVE'));
    expect(await flushed).toBe(false);
    expect(queue.isDirty('mechanic')).toBe(true);
    queue.cancelPending('mechanic');
    expect(queue.isDirty('mechanic')).toBe(false);
    expect(await queue.flush()).toBe(true);
    expect(queue.saveState).toBe('saved');
  });
  test('retry resubmits a definitively rejected staged edit', async () => {
    const { queue, server } = setup();
    queue.stage('mechanic', {
      kind: 'updateLine',
      lineId: 'line',
      mechanicId: 'reactivated',
    });
    const flushed = queue.flush();
    server.calls[0]!.resolve(fail('MECHANIC_INACTIVE'));
    await flushed;
    queue.retry();
    await settle();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]!.command.requestId).not.toBe(
      server.calls[0]!.command.requestId,
    );
    server.calls[1]!.resolve(ok(makeView(2)));
    await settle();
    expect(await queue.flush()).toBe(true);
    expect(queue.saveState).toBe('saved');
  });
});

test('refresh preserves invalid pending edits and reports reload failures', async () => {
  const { queue, server, notices } = setup();
  queue.markInvalid('note', true);
  await queue.refresh();
  expect(server.get).not.toHaveBeenCalled();
  queue.markInvalid('note', false);
  server.get.mockResolvedValueOnce({
    ok: false,
    error: { code: 'INTERNAL_ERROR', messageKey: 'errors.INTERNAL_ERROR' },
  });
  await queue.refresh();
  expect(notices).toContainEqual({
    kind: 'failed',
    error: { code: 'INTERNAL_ERROR', messageKey: 'errors.INTERNAL_ERROR' },
  });
});

test('older refresh cannot overwrite a newer balance at the same draft version', async () => {
  const { queue, server } = setup();
  let resolveOld!: (value: Result<DraftView>) => void;
  server.get
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce(
      ok(makeView(1, { customerOutstandingAmount: '70000' })),
    );
  const old = queue.refresh();
  await settle();
  await queue.refresh();
  resolveOld(ok(makeView(1, { customerOutstandingAmount: '90000' })));
  await old;
  expect(queue.view.customerOutstandingAmount).toBe('70000');
});
