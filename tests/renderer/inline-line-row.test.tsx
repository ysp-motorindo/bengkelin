import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { EditableLineRow } from '@/renderer/features/workspace/EditableLineRow';
import { useDraftCommands } from '@/renderer/features/workspace/use-draft-commands';
import { flushAll } from '@/renderer/lib/flush-registry';
import { draftView, workspaceBridge, ok } from './helpers/workspace-bridge';
import { customLine } from './helpers/transaction-line';

function install() {
  const bridge = workspaceBridge();
  let current = draftView({ lines: [customLine()] });
  bridge.drafts.apply.mockImplementation(async ({ op }) => {
    if (op.kind === 'updateLine')
      current = {
        ...current,
        lines: current.lines.map((line) =>
          line.id === op.lineId ? { ...line, ...op } : line,
        ),
      };
    if (op.kind === 'setLineDiscounts')
      current = {
        ...current,
        lines: current.lines.map((line) =>
          line.id === op.lineId
            ? {
                ...line,
                discounts: op.stages.map((percentageBps, index) => ({
                  sequence: index + 1,
                  percentageBps,
                  amount: '0',
                })),
              }
            : line,
        ),
      };
    current = { ...current, version: current.version + 1 };
    return ok(current);
  });
  Object.assign(window, { bengkelin: bridge });
  return bridge;
}
function Harness({ removeSucceeds = true }: { removeSucceeds?: boolean }) {
  const line = customLine();
  const commands = useDraftCommands(draftView().id, {
    initialView: draftView({ lines: [line] }),
  });
  return (
    <table>
      <tbody>
        <EditableLineRow
          line={commands.view.lines[0]!}
          commands={commands}
          mechanics={[]}
          onRemove={() => removeSucceeds}
        />
      </tbody>
    </table>
  );
}
test('quantity stages until blur and Escape cancels unsent input', async () => {
  const bridge = install();
  const user = userEvent.setup();
  render(<Harness />);
  const qty = screen.getByRole('textbox', { name: 'Jumlah: Servis CVT' });
  await user.clear(qty);
  await user.type(qty, '3');
  expect(bridge.drafts.apply).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(qty).toHaveValue('1');
  await user.clear(qty);
  await user.type(qty, '2');
  await user.tab();
  await waitFor(() => expect(bridge.drafts.apply).toHaveBeenCalled());
  expect(bridge.drafts.apply.mock.calls.at(-1)![0].op).toMatchObject({
    kind: 'updateLine',
    quantity: 2,
  });
});
test('invalid quantity blocks context flush and Escape releases the blocker', async () => {
  install();
  const user = userEvent.setup();
  render(<Harness />);
  const qty = screen.getByRole('textbox', { name: 'Jumlah: Servis CVT' });
  await user.clear(qty);
  expect(await flushAll()).toBe(false);
  await user.keyboard('{Escape}');
  expect(await flushAll()).toBe(true);
});
test('four sequential discounts reject a gap and send basis points', async () => {
  const bridge = install();
  const user = userEvent.setup();
  render(<Harness />);
  const first = screen.getByRole('textbox', {
    name: 'Diskon 1 (%): Servis CVT',
  });
  const second = screen.getByRole('textbox', {
    name: 'Diskon 2 (%): Servis CVT',
  });
  await user.type(second, '5');
  expect(await flushAll()).toBe(false);
  await user.type(first, '10');
  await user.tab();
  await waitFor(() => expect(bridge.drafts.apply).toHaveBeenCalled());
  expect(bridge.drafts.apply.mock.calls.at(-1)![0].op).toMatchObject({
    kind: 'setLineDiscounts',
    stages: [1000, 500],
  });
});

test('custom name and manual price reason use existing audited operations', async () => {
  const bridge = install();
  const user = userEvent.setup();
  render(<Harness />);
  const title = screen.getByRole('textbox', {
    name: 'Nama barang: Servis CVT',
  });
  await user.clear(title);
  await user.type(title, 'Servis lengkap');
  await user.tab();
  await waitFor(() => expect(bridge.drafts.apply).toHaveBeenCalled());
  expect(bridge.drafts.apply.mock.calls.at(-1)![0].op).toMatchObject({
    title: 'Servis lengkap',
  });
  expect(
    screen.queryByLabelText('Alasan perubahan harga (opsional)'),
  ).not.toBeInTheDocument();
  const price = screen.getByRole('textbox', {
    name: 'Harga jual: Servis lengkap',
  });
  await user.clear(price);
  await user.type(price, '60000');
  await user.tab();
  await waitFor(() =>
    expect(bridge.drafts.apply.mock.calls.at(-1)![0].op).toMatchObject({
      unitPrice: '60000',
    }),
  );
});
test('removing an invalid row clears its checkout blocker', async () => {
  install();
  const user = userEvent.setup();
  render(<Harness />);
  await user.clear(screen.getByRole('textbox', { name: 'Jumlah: Servis CVT' }));
  expect(await flushAll()).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Hapus: Servis CVT' }));
  expect(await flushAll()).toBe(true);
});

test('older acknowledgment does not replace newer focused quantity', async () => {
  const bridge = install();
  let resolve!: (
    value: import('@/shared/primitives').Result<
      import('@/shared/contracts').DraftView
    >,
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
  await user.tab();
  await user.click(qty);
  await user.clear(qty);
  await user.type(qty, '3');
  resolve(
    ok(draftView({ version: 2, lines: [{ ...customLine(), quantity: 2 }] })),
  );
  await waitFor(() => expect(qty).toHaveValue('3'));
  expect(qty).toHaveFocus();
});
test('service mechanic selection is staged until blur', async () => {
  const bridge = install();
  const user = userEvent.setup();
  function Service() {
    const line = customLine();
    const commands = useDraftCommands(draftView().id, {
      initialView: draftView({ lines: [line] }),
    });
    return (
      <table>
        <tbody>
          <EditableLineRow
            line={line}
            commands={commands}
            mechanics={[
              {
                id: 'mechanic',
                label: 'Andi',
              } as import('@/shared/contracts').ReferenceDto,
            ]}
            onRemove={() => true}
          />
        </tbody>
      </table>
    );
  }
  render(<Service />);
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Mekanik: Servis CVT' }),
    'mechanic',
  );
  expect(bridge.drafts.apply).not.toHaveBeenCalled();
  await user.tab();
  await waitFor(() =>
    expect(bridge.drafts.apply.mock.calls.at(-1)![0].op).toMatchObject({
      mechanicId: 'mechanic',
    }),
  );
});

test('failed removal preserves validation on the retained row', async () => {
  install();
  const user = userEvent.setup();
  render(<Harness removeSucceeds={false} />);
  await user.clear(screen.getByRole('textbox', { name: 'Jumlah: Servis CVT' }));
  await user.click(screen.getByRole('button', { name: 'Hapus: Servis CVT' }));
  expect(await flushAll()).toBe(false);
});
