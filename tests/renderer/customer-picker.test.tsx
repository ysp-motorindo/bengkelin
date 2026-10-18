import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { CustomerVehicleDialog } from '@/renderer/features/workspace/CustomerVehicleDialog';
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
test('initial active customers, current-query toggle, inactive selection and reset', async () => {
  const search = vi.fn(
    async (input: { query: string; includeInactive?: boolean }) =>
      ok({ results: input.includeInactive ? [inactive] : [active] }),
  );
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    customers: { search },
    references: { listActive: vi.fn(async () => ok([])) },
  };
  const select = vi.fn(async () => true);
  const props = {
    view: draftView(),
    selectCustomer: select,
    selectVehicle: vi.fn(async () => true),
    clearParty: vi.fn(async () => ok(null)),
    onClose: vi.fn(),
  };
  const view = render(<CustomerVehicleDialog {...props} />);
  await waitFor(() =>
    expect(search).toHaveBeenCalledWith({ query: '', includeInactive: false }),
  );
  expect(await screen.findByText('Active')).toBeVisible();
  await userEvent.type(
    screen.getByPlaceholderText('Cari nama atau telepon'),
    'Dorm',
  );
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Tampilkan Pelanggan Nonaktif' }),
  );
  await waitFor(() =>
    expect(search).toHaveBeenLastCalledWith({
      query: 'Dorm',
      includeInactive: true,
    }),
  );
  expect(await screen.findByText(/Dormant.*Nonaktif/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Pilih: Dormant' }));
  expect(select).toHaveBeenCalledWith('c1');
  view.unmount();
  render(<CustomerVehicleDialog {...props} />);
  expect(
    screen.getByRole('checkbox', { name: 'Tampilkan Pelanggan Nonaktif' }),
  ).not.toBeChecked();
});
test('older search responses cannot overwrite a newer filter result', async () => {
  let resolveOld!: (
    value: ReturnType<typeof ok<{ results: CustomerDto[] }>>,
  ) => void;
  const old = new Promise<ReturnType<typeof ok<{ results: CustomerDto[] }>>>(
    (resolve) => {
      resolveOld = resolve;
    },
  );
  const search = vi
    .fn()
    .mockImplementationOnce(() => old)
    .mockResolvedValue(ok({ results: [inactive] }));
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    customers: { search },
    references: { listActive: vi.fn(async () => ok([])) },
  };
  render(
    <CustomerVehicleDialog
      view={draftView()}
      selectCustomer={vi.fn(async () => true)}
      selectVehicle={vi.fn(async () => true)}
      clearParty={vi.fn(async () => ok(null))}
      onClose={vi.fn()}
    />,
  );
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Tampilkan Pelanggan Nonaktif' }),
  );
  expect(await screen.findByText(/Dormant.*Nonaktif/)).toBeVisible();
  await act(async () => {
    resolveOld(ok({ results: [] }));
  });
  expect(screen.getByText(/Dormant.*Nonaktif/)).toBeVisible();
});

test('customer and plate search update after typing without search buttons', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const search = vi.fn(async () => ok({ results: [] }));
  const searchByPlate = vi.fn(async () => ok({ results: [] }));
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    customers: { search },
    vehicles: { searchByPlate },
    references: { listActive: vi.fn(async () => ok([])) },
  };
  render(
    <CustomerVehicleDialog
      view={draftView()}
      selectCustomer={vi.fn(async () => true)}
      selectVehicle={vi.fn(async () => true)}
      clearParty={vi.fn(async () => ok(null))}
      onClose={vi.fn()}
    />,
  );
  await userEvent.type(
    screen.getByPlaceholderText('Cari nama atau telepon'),
    'Ayu',
  );
  await userEvent.type(screen.getByPlaceholderText('Cari plat nomor'), 'B123');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(search).toHaveBeenLastCalledWith({
    query: 'Ayu',
    includeInactive: false,
  });
  expect(searchByPlate).toHaveBeenLastCalledWith({ query: 'B123' });
  expect(
    screen.queryByRole('button', { name: 'Cari' }),
  ).not.toBeInTheDocument();
  vi.useRealTimers();
});

test('clearing customer search restores the unfiltered results', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const search = vi.fn(async ({ query }: { query: string }) =>
    ok({ results: query ? [] : [active] }),
  );
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    customers: { search },
    references: { listActive: vi.fn(async () => ok([])) },
  };
  render(
    <CustomerVehicleDialog
      view={draftView()}
      selectCustomer={vi.fn(async () => true)}
      selectVehicle={vi.fn(async () => true)}
      clearParty={vi.fn(async () => ok(null))}
      onClose={vi.fn()}
    />,
  );
  const input = screen.getByPlaceholderText('Cari nama atau telepon');
  expect(await screen.findByText('Active')).toBeVisible();
  await userEvent.type(input, 'missing');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(await screen.findByText('Tidak ditemukan.')).toBeVisible();
  await userEvent.clear(input);
  expect(await screen.findByText('Active')).toBeVisible();
  vi.useRealTimers();
});

test('walk-in clears customer and vehicle together and closes only after success', async () => {
  const clearParty = vi.fn(async () => ok(null));
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    customers: { search: vi.fn(async () => ok({ results: [] })) },
    vehicles: { searchByPlate: vi.fn(async () => ok({ results: [] })) },
    references: { listActive: vi.fn(async () => ok([])) },
  };
  const onClose = vi.fn();
  render(
    <CustomerVehicleDialog
      view={draftView()}
      selectCustomer={vi.fn(async () => true)}
      selectVehicle={vi.fn(async () => true)}
      clearParty={clearParty}
      onClose={onClose}
    />,
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Gunakan pelanggan umum' }),
  );
  expect(clearParty).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

test('failed walk-in keeps the dialog open and shows the returned error', async () => {
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    customers: { search: vi.fn(async () => ok({ results: [] })) },
    vehicles: { searchByPlate: vi.fn(async () => ok({ results: [] })) },
    references: { listActive: vi.fn(async () => ok([])) },
  };
  const onClose = vi.fn();
  render(
    <CustomerVehicleDialog
      view={draftView()}
      selectCustomer={vi.fn(async () => true)}
      selectVehicle={vi.fn(async () => true)}
      clearParty={vi.fn(async () => ({
        ok: false as const,
        error: { code: 'FAILED', messageKey: 'errors.INTERNAL_ERROR' },
      }))}
      onClose={onClose}
    />,
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Gunakan pelanggan umum' }),
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(await screen.findByRole('alert')).toBeInTheDocument();
});

test('blank plate input clears its previous no-results state immediately', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    customers: { search: vi.fn(async () => ok({ results: [] })) },
    vehicles: { searchByPlate: vi.fn(async () => ok({ results: [] })) },
    references: { listActive: vi.fn(async () => ok([])) },
  };
  render(
    <CustomerVehicleDialog
      view={draftView()}
      selectCustomer={vi.fn(async () => true)}
      selectVehicle={vi.fn(async () => true)}
      clearParty={vi.fn(async () => ok(null))}
      onClose={vi.fn()}
    />,
  );
  const vehicles = screen.getByRole('region', { name: 'Kendaraan' });
  const input = screen.getByPlaceholderText('Cari plat nomor');
  await userEvent.type(input, 'B123');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(
    await within(vehicles).findByText('Tidak ditemukan.'),
  ).toBeInTheDocument();
  await userEvent.clear(input);
  expect(
    within(vehicles).queryByText('Tidak ditemukan.'),
  ).not.toBeInTheDocument();
  vi.useRealTimers();
});
