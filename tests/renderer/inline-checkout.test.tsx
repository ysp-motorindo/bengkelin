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
  await user.click(screen.getByRole('button', { name: 'Bayar Penuh Tunai' }));
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
      kind: 'setCheckoutAllocations',
      allocations: [{ method: 'CASH', amount: '100000' }],
    }),
  );
});
