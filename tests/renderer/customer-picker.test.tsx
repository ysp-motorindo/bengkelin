import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { CustomerVehiclePicker } from '@/renderer/features/workspace/CustomerVehiclePicker';
import { useDraftCommands } from '@/renderer/features/workspace/use-draft-commands';
import { workspaceBridge } from './helpers/workspace-bridge';
import { draftView } from './helpers/workspace-bridge';
import type { CustomerDto } from '@/shared/contracts';
const ok = <T,>(value: T) => ({ ok: true as const, value });
const inactive: CustomerDto = {
  id: 'c1',
  name: 'Dormant',
  phoneNumber: null,
  isActive: false,
  externalId: 'OLD',
  email: null,
  birthdate: null,
  address: null,
  rt: null,
  rw: null,
  kelurahan: null,
  kecamatan: null,
  cityOrRegency: null,
  province: null,
  postalCode: null,
  createdAt: '',
  updatedAt: '',
};
const active: CustomerDto = {
  ...inactive,
  id: 'c2',
  name: 'Active',
  isActive: true,
};

function Harness({ mode = 'customer' as 'customer' | 'vehicle' }) {
  const commands = useDraftCommands(draftView().id, {
    initialView: draftView(),
  });
  return (
    <CustomerVehiclePicker mode={mode} commands={commands} onError={() => {}} />
  );
}
function install() {
  const bridge = workspaceBridge();
  const search = vi.fn(async () => ok({ results: [active] }));
  const api = {
    ...bridge,
    customers: { search, get: vi.fn() },
    vehicles: { searchByPlate: vi.fn(async () => ok({ results: [] })) },
  };
  Object.assign(window, { bengkelin: api });
  return api;
}
test('selects a customer directly from results without a dialog', async () => {
  const api = install();
  const user = userEvent.setup();
  render(<Harness />);
  const input = screen.getByRole('combobox', { name: 'Pelanggan' });
  await user.click(input);
  await screen.findByRole('option', { name: 'Active' });
  await user.keyboard('{ArrowDown}{Enter}');
  await waitFor(() =>
    expect(api.drafts.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        op: { kind: 'updateHeader', changes: { customerId: 'c2' } },
      }),
    ),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
test('Escape abandons only search text and creation is last result', async () => {
  install();
  const user = userEvent.setup();
  render(<Harness />);
  const input = screen.getByRole('combobox', { name: 'Pelanggan' });
  await user.type(input, 'missing');
  await user.keyboard('{Escape}');
  expect(input).toHaveValue('Umum');
  await user.click(input);
  await screen.findByRole('option', { name: 'Active' });
  const options = screen.getAllByRole('option');
  expect(options.at(-1)).toHaveTextContent('Tambah pelanggan');
  await user.click(options.at(-1)!);
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.getAllByRole('heading')).toHaveLength(1);
});
test('inactive filter uses current query and ignores an older response', async () => {
  const api = install();
  let resolve!: (
    value: ReturnType<typeof ok<{ results: CustomerDto[] }>>,
  ) => void;
  api.customers.search.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('combobox', { name: 'Pelanggan' }));
  api.customers.search.mockResolvedValue(ok({ results: [inactive] }));
  await user.click(
    screen.getByRole('checkbox', { name: 'Tampilkan Pelanggan Nonaktif' }),
  );
  expect(await screen.findByRole('option', { name: /Dormant/ })).toBeVisible();
  await act(async () => resolve(ok({ results: [active] })));
  expect(
    screen.queryByRole('option', { name: 'Active' }),
  ).not.toBeInTheDocument();
});
test('vehicle typing searches plates and supports explicit clearing', async () => {
  const api = install();
  const user = userEvent.setup();
  render(<Harness mode="vehicle" />);
  await user.type(
    screen.getByRole('combobox', { name: 'No. Kendaraan' }),
    'B123',
  );
  await waitFor(() =>
    expect(api.vehicles.searchByPlate).toHaveBeenCalledWith({ query: 'B123' }),
  );
  await user.click(screen.getByRole('option', { name: 'Tanpa kendaraan' }));
  expect(api.drafts.apply).toHaveBeenCalledWith(
    expect.objectContaining({
      op: { kind: 'updateHeader', changes: { vehicleId: null } },
    }),
  );
});

test('ArrowUp from an unselected picker reaches its final create action', async () => {
  install();
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('combobox', { name: 'Pelanggan' }));
  await screen.findByRole('option', { name: 'Active' });
  await user.keyboard('{ArrowUp}');
  expect(
    screen.getByRole('option', { name: 'Tambah pelanggan' }),
  ).toHaveAttribute('aria-selected', 'true');
});

test('closing quick creation restores the selected label and keeps results closed', async () => {
  install();
  const user = userEvent.setup();
  render(<Harness />);
  const input = screen.getByRole('combobox', { name: 'Pelanggan' });
  await user.click(input);
  await user.click(screen.getByRole('option', { name: 'Tambah pelanggan' }));
  await user.click(screen.getByRole('button', { name: 'Tutup' }));
  expect(input).toHaveFocus();
  expect(input).toHaveValue('Umum');
  expect(input).toHaveAttribute('aria-expanded', 'false');
});

test('a late result cannot retarget the highlighted create action', async () => {
  const api = install();
  let finish!: (
    value: ReturnType<typeof ok<{ results: CustomerDto[] }>>,
  ) => void;
  api.customers.search.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('combobox', { name: 'Pelanggan' }));
  await waitFor(() => expect(api.customers.search).toHaveBeenCalled());
  await user.keyboard('{ArrowUp}');
  await act(async () =>
    finish(
      ok({
        results: [
          { ...active, id: 'alice', name: 'Alice' },
          { ...active, id: 'bob', name: 'Bob' },
        ],
      }),
    ),
  );
  await user.keyboard('{Enter}');
  expect(api.drafts.apply).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeVisible();
});

test('keyboard can toggle inactive customers and select a result', async () => {
  const api = install();
  api.customers.search.mockImplementation(
    async (input?: { includeInactive?: boolean }) =>
      ok({ results: input?.includeInactive ? [inactive] : [active] }),
  );
  const user = userEvent.setup();
  render(<Harness />);
  await user.tab();
  await user.keyboard('{ArrowDown}');
  await screen.findByRole('option', { name: 'Active' });
  await user.tab();
  const checkbox = screen.getByRole('checkbox', {
    name: 'Tampilkan Pelanggan Nonaktif',
  });
  expect(checkbox).toHaveFocus();
  await user.keyboard(' ');
  await screen.findByRole('option', { name: /Dormant/ });
  expect(api.customers.search).toHaveBeenLastCalledWith(
    expect.objectContaining({ includeInactive: true }),
  );
  await user.tab({ shift: true });
  await user.keyboard('{ArrowDown}{Enter}');
  await waitFor(() =>
    expect(api.drafts.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        op: { kind: 'updateHeader', changes: { customerId: 'c1' } },
      }),
    ),
  );
});

test('keyboard can leave the filter or dismiss it with Escape', async () => {
  install();
  const user = userEvent.setup();
  render(
    <>
      <Harness />
      <button>Outside</button>
    </>,
  );
  const input = screen.getByRole('combobox', { name: 'Pelanggan' });
  await user.type(input, 'missing');
  await user.tab();
  expect(screen.getByRole('checkbox')).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(input).toHaveFocus();
  expect(input).toHaveValue('Umum');
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  await user.keyboard('{ArrowDown}');
  await user.tab();
  expect(screen.getByRole('checkbox')).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});
