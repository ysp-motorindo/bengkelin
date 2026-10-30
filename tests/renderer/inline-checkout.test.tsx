import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { EditableLineRow } from '@/renderer/features/workspace/EditableLineRow';
import { CheckoutPanel } from '@/renderer/features/workspace/checkout/CheckoutPanel';
import { useDraftCommands } from '@/renderer/features/workspace/use-draft-commands';
import type { DraftView } from '@/shared/contracts';
import { draftView, workspaceBridge, ok } from './helpers/workspace-bridge';
import { customLine } from './helpers/transaction-line';
const initial = draftView({
  lines: [customLine()],
  totals: {
    ...draftView().totals,
    subtotal: '50000',
    amount: '50000',
    unallocatedAmount: '50000',
  },
});
function Harness() {
  const commands = useDraftCommands(initial.id, { initialView: initial });
  return (
    <>
      <table>
        <tbody>
          <EditableLineRow
            line={commands.view.lines[0]!}
            commands={commands}
            mechanics={[]}
            onRemove={() => true}
          />
        </tbody>
      </table>
      <CheckoutPanel
        commands={commands}
        onReview={() => {}}
        onError={() => {}}
      />
    </>
  );
}
test('Pay Full uses the acknowledged total after an inline quantity save', async () => {
  const bridge = workspaceBridge();
  Object.assign(window, { bengkelin: bridge });
  bridge.drafts.apply.mockImplementation(async () => ok(initial));
  let resolve!: (
    value: import('@/shared/primitives').Result<DraftView>,
  ) => void;
  bridge.drafts.apply.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const user = userEvent.setup();
  render(<Harness />);
  const qty = screen.getByRole('textbox', { name: 'Jumlah: Servis CVT' });
  await user.clear(qty);
  await user.type(qty, '2');
  const cash = screen.getByRole('textbox', { name: 'Pembayaran' });
  await user.clear(cash);
  await user.type(cash, '100000');
  resolve(
    ok({
      ...initial,
      version: 2,
      lines: [{ ...customLine(), quantity: 2 }],
      totals: {
        ...initial.totals,
        subtotal: '100000',
        amount: '100000',
        unallocatedAmount: '100000',
      },
    }),
  );
  await waitFor(() =>
    expect(bridge.drafts.apply.mock.calls.at(-1)![0].op).toMatchObject({
      kind: 'setCashPayment',
      amount: '100000',
    }),
  );
});

test('nominal cash input shows change and hides down payment at TOP zero', async () => {
  const bridge = workspaceBridge();
  Object.assign(window, { bengkelin: bridge });
  render(<Harness />);
  const cash = screen.getByRole('textbox', { name: 'Pembayaran' });
  await userEvent.clear(cash);
  await userEvent.type(cash, '60000');
  expect(screen.getByTestId('cash-change')).toHaveTextContent('10.000');
  expect(screen.queryByText('Uang Muka')).not.toBeInTheDocument();
});

test('legacy checkout remains unchanged until its cash and discount replacements are chosen', async () => {
  const legacy: DraftView = {
    ...initial,
    cashReceived: null,
    invoiceDiscounts: [
      { sequence: 1, percentageBps: 5000, amount: '25000' },
      { sequence: 2, percentageBps: 5000, amount: '12500' },
    ],
    checkoutAllocations: [
      {
        sequence: 1,
        method: 'CASH',
        amount: '5000',
        reference: null,
        note: null,
      },
      {
        sequence: 2,
        method: 'QRIS',
        amount: '7500',
        reference: 'QR-1',
        note: null,
      },
    ],
    totals: {
      ...initial.totals,
      invoiceDiscountAmount: '37500',
      amount: '12500',
      allocatedAmount: '12500',
      unallocatedAmount: '0',
    },
  };
  const bridge = workspaceBridge();
  bridge.drafts.apply.mockResolvedValueOnce(
    ok({
      ...legacy,
      version: 2,
      cashReceived: '12500',
      checkoutAllocations: [
        {
          sequence: 1,
          method: 'CASH',
          amount: '12500',
          reference: null,
          note: null,
        },
      ],
    }),
  );
  bridge.drafts.apply.mockResolvedValueOnce(
    ok({
      ...legacy,
      version: 3,
      cashReceived: '12500',
      invoiceDiscounts: [],
      checkoutAllocations: [
        {
          sequence: 1,
          method: 'CASH',
          amount: '12500',
          reference: null,
          note: null,
        },
      ],
      totals: {
        ...legacy.totals,
        invoiceDiscountAmount: '0',
        amount: '50000',
        unallocatedAmount: '37500',
      },
    }),
  );
  Object.assign(window, { bengkelin: bridge });
  function LegacyHarness() {
    const commands = useDraftCommands(legacy.id, { initialView: legacy });
    return (
      <CheckoutPanel
        commands={commands}
        onReview={() => {}}
        onError={() => {}}
      />
    );
  }
  render(<LegacyHarness />);
  expect(screen.getByTestId('total-amount')).toHaveTextContent('12.500');
  expect(
    screen.queryByRole('textbox', { name: 'Pembayaran' }),
  ).not.toBeInTheDocument();
  expect(bridge.drafts.apply).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole('button', { name: 'Ganti dengan tunai' }),
  );
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Pembayaran' })).toHaveValue(
      '12.500',
    ),
  );
  expect(bridge.drafts.apply.mock.calls[0]![0].op).toEqual({
    kind: 'setCashPayment',
    amount: '12500',
  });
  await userEvent.click(screen.getByRole('button', { name: 'Ganti diskon' }));
  await waitFor(() =>
    expect(screen.getByTestId('total-amount')).toHaveTextContent('50.000'),
  );
  expect(bridge.drafts.apply.mock.calls[1]![0].op).toEqual({
    kind: 'setInvoiceDiscounts',
    stages: [],
  });
});
