import { render, screen, waitFor, within } from '@testing-library/react';
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
            rowNumber={1}
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
test('opening payments flushes pending quantity edits and uses the acknowledged total', async () => {
  const bridge = workspaceBridge();
  Object.assign(window, { bengkelin: bridge });
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
  await user.click(screen.getByRole('button', { name: 'Pembayaran' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Rp 100.000')).toBeVisible();
  expect(bridge.drafts.apply.mock.calls[0]![0].op).toMatchObject({
    kind: 'updateLine',
    quantity: 2,
  });
});

test('a failed flush leaves payments closed', async () => {
  const bridge = workspaceBridge();
  Object.assign(window, { bengkelin: bridge });
  bridge.drafts.apply.mockResolvedValueOnce({
    ok: false,
    error: { code: 'INTERNAL_ERROR', messageKey: 'errors.INTERNAL_ERROR' },
  });
  const user = userEvent.setup();
  render(<Harness />);
  const qty = screen.getByRole('textbox', { name: 'Jumlah: Servis CVT' });
  await user.clear(qty);
  await user.type(qty, '2');
  await user.click(screen.getByRole('button', { name: 'Pembayaran' }));
  await waitFor(() => expect(bridge.drafts.apply).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('legacy sequential discounts still require explicit replacement', async () => {
  const legacy = draftView({
    ...initial,
    invoiceDiscounts: [
      { sequence: 1, percentageBps: 5000, amount: '25000' },
      { sequence: 2, percentageBps: 5000, amount: '12500' },
    ],
  });
  const bridge = workspaceBridge();
  bridge.drafts.apply.mockResolvedValueOnce(
    ok({ ...legacy, version: 2, invoiceDiscounts: [] }),
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
  expect(bridge.drafts.apply).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Ganti diskon' }));
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Disc' })).toBeVisible(),
  );
  expect(bridge.drafts.apply.mock.calls[0]![0].op).toEqual({
    kind: 'setInvoiceDiscounts',
    stages: [],
  });
});

test('details are collapsed until the accessible icon is toggled', async () => {
  Object.assign(window, { bengkelin: workspaceBridge() });
  render(<Harness />);
  const toggle = screen.getByRole('button', { name: /detail/i });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
});

test('invoice discount uses a separate percent suffix', () => {
  Object.assign(window, { bengkelin: workspaceBridge() });
  render(<Harness />);
  const discount = screen.getByRole('textbox', { name: 'Disc' });
  expect(discount.nextElementSibling).toHaveTextContent('%');
  expect(discount).toHaveAccessibleDescription('%');
});
