import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { LineEntryRow } from '@/renderer/features/workspace/LineEntryRow';
import { useDraftCommands } from '@/renderer/features/workspace/use-draft-commands';
import { flushAll } from '@/renderer/lib/flush-registry';
import { draftView, workspaceBridge } from './helpers/workspace-bridge';
function install() {
  const bridge = workspaceBridge();
  Object.assign(window, { bengkelin: bridge });
  return bridge;
}
function Harness() {
  const commands = useDraftCommands(draftView().id, {
    initialView: draftView(),
  });
  return (
    <>
      <input aria-label="Other control" />
      <table>
        <tbody>
          <LineEntryRow commands={commands} units={[]} mechanics={[]} />
        </tbody>
      </table>
    </>
  );
}
test('barcode Enter adds once and returns focus to entry', async () => {
  const bridge = install();
  const user = userEvent.setup();
  render(<Harness />);
  const search = screen.getByRole('combobox', { name: 'Cari barang' });
  await user.type(search, '899123{Enter}');
  await waitFor(() => expect(bridge.drafts.apply).toHaveBeenCalledOnce());
  expect(bridge.drafts.apply.mock.calls[0]![0].op).toMatchObject({
    kind: 'addCatalogLine',
    barcode: '899123',
    quantity: 1,
  });
  expect(search).toHaveFocus();
});
test('unsubmitted search blocks transitions and Escape clears it', async () => {
  install();
  const user = userEvent.setup();
  render(<Harness />);
  const search = screen.getByRole('combobox', { name: 'Cari barang' });
  await user.type(search, 'oli');
  expect(await flushAll()).toBe(false);
  await user.keyboard('{Escape}');
  expect(await flushAll()).toBe(true);
});
test('custom action opens a modal and cancellation restores search focus', async () => {
  install();
  const user = userEvent.setup();
  render(<Harness />);
  const search = screen.getByRole('combobox', { name: 'Cari barang' });
  await user.click(search);
  await user.click(await screen.findByRole('option', { name: 'Item kustom' }));
  expect(screen.getByRole('dialog')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Batal' }));
  expect(search).toHaveFocus();
  expect(await flushAll()).toBe(true);
});

test('duplicate Enter while adding does not dispatch a second add', async () => {
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
  const search = screen.getByRole('combobox', { name: 'Cari barang' });
  await user.type(search, '899123{Enter}{Enter}');
  expect(bridge.drafts.apply).toHaveBeenCalledOnce();
  resolve({ ok: true, value: draftView({ version: 2 }) });
  await waitFor(() => expect(search).not.toBeDisabled());
});
test('selecting catalog search result immediately adds quantity one', async () => {
  const bridge = install();
  bridge.catalog.search.mockResolvedValue({
    ok: true,
    value: {
      results: [
        {
          id: 'item',
          title: 'Oli mesin',
          description: null,
          sku: null,
          unitId: 'unit',
          unitCode: 'PCS',
          unitLabel: 'PCS',
          weight: null,
          trackInventory: true,
          isActive: true,
          createdAt: '2026-10-30T00:00:00.000Z',
          updatedAt: '2026-10-30T00:00:00.000Z',
          barcodes: [],
          type: 'STOCK_ITEM',
        } as import('@/shared/contracts').CatalogItemDto,
      ],
    },
  });
  const user = userEvent.setup();
  render(<Harness />);
  const search = screen.getByRole('combobox', { name: 'Cari barang' });
  await user.type(search, 'Oli');
  await screen.findByRole('option', { name: /Oli mesin/ });
  await user.keyboard('{ArrowDown}{Enter}');
  await waitFor(() => expect(bridge.drafts.apply).toHaveBeenCalledOnce());
  expect(bridge.drafts.apply.mock.calls[0]![0].op).toMatchObject({
    kind: 'addCatalogLine',
    catalogItemId: 'item',
    quantity: 1,
  });
  expect(
    screen.queryByRole('button', { name: 'Tambahkan' }),
  ).not.toBeInTheDocument();
});

test('two complete barcode scans during a delayed add are both retained', async () => {
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
  const search = screen.getByRole('combobox', { name: 'Cari barang' });
  await user.type(search, '899123{Enter}');
  await user.type(search, '899123{Enter}');
  resolve({ ok: true, value: draftView({ version: 2 }) });
  await waitFor(() => expect(bridge.drafts.apply).toHaveBeenCalledTimes(2));
});

test('old add acknowledgment preserves a newer query and its transition blocker', async () => {
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
  const search = screen.getByRole('combobox', { name: 'Cari barang' });
  await user.type(search, '899123{Enter}');
  await user.type(search, 'New query');
  resolve({ ok: true, value: draftView({ version: 2 }) });
  await waitFor(() => expect(search).toHaveValue('New query'));
  await new Promise((done) => setTimeout(done, 20));
  expect(await flushAll()).toBe(false);
});
test('Escape cannot abandon a custom item submission in flight', async () => {
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
  await user.click(screen.getByRole('combobox', { name: 'Cari barang' }));
  await user.click(await screen.findByRole('option', { name: 'Item kustom' }));
  await user.type(
    screen.getByRole('combobox', { name: 'Nama item' }),
    'Demo service',
  );
  await user.type(screen.getByRole('textbox', { name: 'Harga' }), '35000');
  await user.click(screen.getByRole('button', { name: 'Tambahkan' }));
  await user.click(screen.getByRole('textbox', { name: 'Harga' }));
  await user.keyboard('{Escape}');
  expect(
    screen.getByRole('region', { name: 'Tambah item kustom' }),
  ).toBeInTheDocument();
  resolve({ ok: true, value: draftView({ version: 2 }) });
  await waitFor(() =>
    expect(
      screen.getByRole('combobox', { name: 'Cari barang' }),
    ).toBeInTheDocument(),
  );
});

test('a completed scan does not steal focus from a newer edit elsewhere', async () => {
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
  await user.type(
    screen.getByRole('combobox', { name: 'Cari barang' }),
    '899123{Enter}',
  );
  const other = screen.getByRole('textbox', { name: 'Other control' });
  await user.type(other, '15200');
  resolve({ ok: true, value: draftView({ version: 2 }) });
  await new Promise((done) => setTimeout(done, 20));
  expect(other).toHaveFocus();
  expect(other).toHaveValue('15200');
});

test('clicking an already-focused search reopens the custom action after a scan', async () => {
  install();
  const user = userEvent.setup();
  render(<Harness />);
  const search = screen.getByRole('combobox', { name: 'Cari barang' });
  await user.type(search, '899123{Enter}');
  await waitFor(() => expect(search).toHaveValue(''));
  await user.click(search);
  expect(screen.getByRole('option', { name: 'Item kustom' })).toBeVisible();
});

test('failed empty barcode entry can be cancelled with Escape', async () => {
  const api = install();
  api.drafts.apply.mockResolvedValue({
    ok: false,
    error: { code: 'UNKNOWN_BARCODE', messageKey: 'errors.UNKNOWN_BARCODE' },
  });
  const user = userEvent.setup();
  render(<Harness />);
  const input = screen.getByRole('combobox', { name: 'Cari barang' });
  await user.type(input, '12345{Enter}');
  await screen.findByRole('alert');
  expect(await flushAll()).toBe(false);
  await user.keyboard('{Escape}');
  expect(input).toHaveValue('');
  expect(await flushAll()).toBe(true);
});
test('custom transport exhaustion exposes an idempotent retry inside the modal', async () => {
  const api = install();
  api.drafts.apply.mockRejectedValue(new Error('transport'));
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('combobox', { name: 'Cari barang' }));
  await user.click(screen.getByRole('option', { name: 'Item kustom' }));
  await user.type(
    screen.getByRole('combobox', { name: 'Nama item' }),
    'Service',
  );
  await user.type(screen.getByRole('textbox', { name: 'Harga' }), '30000');
  await user.click(screen.getByRole('button', { name: 'Tambahkan' }));
  const modal = screen.getByRole('dialog');
  const retry = await within(modal).findByRole(
    'button',
    { name: 'Coba simpan lagi' },
    { timeout: 2500 },
  );
  const request = api.drafts.apply.mock.calls[0]![0].requestId;
  api.drafts.apply.mockResolvedValue({
    ok: true,
    value: draftView({ version: 2 }),
  });
  await user.click(retry);
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(api.drafts.apply.mock.calls.at(-1)![0].requestId).toBe(request);
});

test('search spans code and item columns', () => {
  install();
  render(<Harness />);
  expect(
    screen.getByRole('combobox', { name: 'Cari barang' }).closest('td'),
  ).toHaveAttribute('colspan', '2');
});
