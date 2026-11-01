import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { CheckoutPanel } from '@/renderer/features/workspace/checkout/CheckoutPanel';
import { useDraftCommands } from '@/renderer/features/workspace/use-draft-commands';
import type { DraftCommands } from '@/renderer/features/workspace/use-draft-commands';
import type { CheckoutAllocationDto, DraftView } from '@/shared/contracts';
import { calculateCheckoutPayments } from '@/shared/checkout-payments';
import { draftView, workspaceBridge, ok } from './helpers/workspace-bridge';

const row = (
  method: CheckoutAllocationDto['method'],
  amount: string,
  sequence = 1,
): CheckoutAllocationDto => ({
  sequence,
  method,
  amount,
  reference: null,
  note: null,
});
function start(tenders: CheckoutAllocationDto[] = []) {
  const bridge = workspaceBridge();
  let current = draftView({
    cashReceived: null,
    checkoutTenders: tenders,
    ...calculation(tenders),
  });
  bridge.drafts.get.mockImplementation(async () => ok(current));
  bridge.drafts.apply.mockImplementation(async (command) => {
    if (command.op.kind === 'setCheckoutAllocations') {
      const next = command.op.allocations.map((a, index) => ({
        ...a,
        sequence: index + 1,
        reference: a.reference ?? null,
        note: a.note ?? null,
      }));
      current = {
        ...current,
        version: current.version + 1,
        checkoutTenders: next,
        ...calculation(next),
      };
    }
    return ok(current);
  });
  Object.assign(window, { bengkelin: bridge });
  let commands!: DraftCommands;
  const notices = vi.fn();
  function Harness() {
    commands = useDraftCommands(current.id, {
      initialView: current,
      onNotice: notices,
    });
    return (
      <CheckoutPanel
        commands={commands}
        onReview={() => {}}
        onError={() => {}}
      />
    );
  }
  render(<Harness />);
  return { bridge, notices, commands: () => commands };
}
function calculation(tenders: CheckoutAllocationDto[]) {
  const result = calculateCheckoutPayments('100000', tenders);
  const allocated = result.allocations.reduce(
    (sum, a) => sum + BigInt(a.amount),
    0n,
  );
  return {
    checkoutAllocations: result.allocations,
    paymentSummary: result.summary,
    totals: {
      ...draftView().totals,
      amount: '100000',
      allocatedAmount: String(allocated),
      unallocatedAmount: String(100000n - allocated),
    },
  };
}
const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Pembayaran' }));
  return screen.findByRole('dialog', { name: 'Pembayaran' });
};

test('Apply saves repeated methods and metadata together, shows received/change, and restores focus', async () => {
  const { bridge } = start([
    { ...row('QRIS', '60000'), reference: 'QR-1', note: 'keep' },
    row('CASH', '50000', 2),
  ]);
  const dialog = await open();
  expect(within(dialog).getByLabelText('Nominal 2')).toHaveValue('50.000');
  expect(within(dialog).getByTestId('payments-change')).toHaveTextContent(
    '10.000',
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Tambah pembayaran' }),
  );
  expect(within(dialog).getByLabelText('Metode 3')).toHaveValue('CASH');
  await userEvent.type(within(dialog).getByLabelText('Nominal 3'), '10000');
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Terapkan' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(bridge.drafts.apply).toHaveBeenCalledTimes(1);
  expect(bridge.drafts.apply.mock.calls[0]![0].op).toEqual({
    kind: 'setCheckoutAllocations',
    allocations: [
      { method: 'QRIS', amount: '60000', reference: 'QR-1', note: 'keep' },
      { method: 'CASH', amount: '50000', reference: null, note: null },
      { method: 'CASH', amount: '10000', reference: null, note: null },
    ],
  });
  expect(screen.getByRole('button', { name: 'Pembayaran' })).toHaveTextContent(
    '120.000',
  );
  expect(screen.getByTestId('cash-change')).toHaveTextContent('20.000');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Pembayaran' })).toHaveFocus(),
  );
});

test.each(['cancel', 'escape', 'close'])(
  '%s discards local edits without a command',
  async (action) => {
    const { bridge } = start([row('CASH', '50000')]);
    const dialog = await open();
    await userEvent.clear(within(dialog).getByLabelText('Nominal 1'));
    await userEvent.type(within(dialog).getByLabelText('Nominal 1'), '90000');
    if (action === 'escape') await userEvent.keyboard('{Escape}');
    else
      await userEvent.click(
        within(dialog).getByRole('button', {
          name: action === 'cancel' ? 'Batal' : 'Tutup',
        }),
      );
    expect(bridge.drafts.apply).not.toHaveBeenCalled();
    const reopened = await open();
    expect(within(reopened).getByLabelText('Nominal 1')).toHaveValue('50.000');
  },
);

test('empty Cash row requires positive money; removing all rows clears payments', async () => {
  const { bridge } = start();
  const dialog = await open();
  expect(within(dialog).getByLabelText('Metode 1')).toHaveValue('CASH');
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Terapkan' }),
  );
  expect(within(dialog).getByRole('alert')).toHaveTextContent('lebih dari 0');
  expect(bridge.drafts.apply).not.toHaveBeenCalled();
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Hapus pembayaran 1' }),
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Terapkan' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(bridge.drafts.apply.mock.calls[0]![0].op).toEqual({
    kind: 'setCheckoutAllocations',
    allocations: [],
  });
});

test('non-cash excess is explained immediately, with unavailable change, and can be saved', async () => {
  const { bridge } = start([row('QRIS', '110000')]);
  const dialog = await open();
  expect(within(dialog).getByRole('alert')).toHaveTextContent('10000');
  expect(within(dialog).getByTestId('payments-change')).toHaveTextContent('—');
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Terapkan' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(bridge.drafts.apply).toHaveBeenCalledTimes(1);
});

test.each(['INTERNAL_ERROR', 'DRAFT_VERSION_CONFLICT'])(
  '%s keeps local edits visible and allows correction/retry',
  async (code) => {
    const { bridge, notices } = start([row('CASH', '50000')]);
    bridge.drafts.apply.mockResolvedValueOnce({
      ok: false,
      error: { code, messageKey: `errors.${code}` },
    });
    const dialog = await open();
    const input = within(dialog).getByLabelText('Nominal 1');
    await userEvent.clear(input);
    await userEvent.type(input, '80000');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Terapkan' }),
    );
    expect(await within(dialog).findByRole('alert')).toBeVisible();
    expect(input).toHaveValue('80.000');
    if (code === 'DRAFT_VERSION_CONFLICT')
      expect(notices).toHaveBeenCalledWith({ kind: 'conflictReloaded' });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Terapkan' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  },
);

test('pending save prevents dismissal and duplicate submission', async () => {
  const { bridge } = start([row('CASH', '100000')]);
  let resolve!: (
    result: import('@/shared/primitives').Result<DraftView>,
  ) => void;
  bridge.drafts.apply.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const dialog = await open();
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Terapkan' }),
  );
  expect(within(dialog).getByRole('button', { name: 'Batal' })).toBeDisabled();
  await userEvent.keyboard('{Escape}');
  expect(dialog).toBeVisible();
  expect(
    within(dialog).queryByRole('button', { name: 'Tutup' }),
  ).not.toBeInTheDocument();
  resolve(ok(draftView()));
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(bridge.drafts.apply).toHaveBeenCalledTimes(1);
});

test('invalid pending draft edits prevent opening the payment dialog', async () => {
  start();
  const input = screen.getByRole('textbox', { name: 'Disc' });
  await userEvent.type(input, '101');
  await userEvent.click(screen.getByRole('button', { name: 'Pembayaran' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('limits received rows to ten and supports changing a repeated method', async () => {
  start(
    Array.from({ length: 10 }, (_, index) => row('CASH', '1000', index + 1)),
  );
  const dialog = await open();
  expect(
    within(dialog).getByRole('button', { name: 'Tambah pembayaran' }),
  ).toBeDisabled();
  await userEvent.selectOptions(
    within(dialog).getByLabelText('Metode 2'),
    'QRIS',
  );
  expect(within(dialog).getByLabelText('Metode 2')).toHaveValue('QRIS');
});

test('transport failure offers retry inside the dialog without changing the command identity', async () => {
  const { bridge } = start([row('CASH', '100000')]);
  bridge.drafts.apply
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline'));
  const dialog = await open();
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Terapkan' }),
  );
  const retry = await within(dialog).findByRole(
    'button',
    { name: 'Coba simpan lagi' },
    { timeout: 3000 },
  );
  expect(within(dialog).getByLabelText('Nominal 1')).toHaveValue('100.000');
  await userEvent.click(retry);
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  const calls = bridge.drafts.apply.mock.calls;
  expect(calls).toHaveLength(4);
  expect(calls[3]![0]).toEqual(calls[0]![0]);
});
