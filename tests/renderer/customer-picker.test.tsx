import { act, render, screen, waitFor } from '@testing-library/react';
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
test('initial active customers, current-query toggle, inactive selection and reset', async () => {
  const search = vi.fn(
    async (input: { query: string; includeInactive?: boolean }) =>
      ok({ results: input.includeInactive ? [inactive] : [] }),
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
    onClose: vi.fn(),
  };
  const view = render(<CustomerVehicleDialog {...props} />);
  await waitFor(() =>
    expect(search).toHaveBeenCalledWith({ query: '', includeInactive: false }),
  );
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
