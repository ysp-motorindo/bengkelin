import {
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ReferencesScreen } from '@/renderer/features/references/ReferencesScreen';
import { CashiersScreen } from '@/renderer/features/cashiers/CashiersScreen';
import { CustomerEditForm } from '@/renderer/features/customers/CustomerEditForm';
import { VehicleDetail } from '@/renderer/features/customers/VehicleDetail';
import { useFilterOptions } from '@/renderer/features/history/use-filter-options';
import { AdHocReferencesPanel } from '@/renderer/features/references/AdHocReferencesPanel';
import { ShopSettingsSection } from '@/renderer/features/settings/ShopSettingsSection';
import type {
  AdHocReferenceDto,
  CashierDto,
  CashierSession,
  CustomerDto,
  VehicleDetailDto,
} from '@/shared/contracts';
import { ok } from './helpers/workspace-bridge';

/** T17 ADMIN screens and the T5/T11 carried UI. */

const install = (bridge: Record<string, unknown>) => {
  (window as unknown as { bengkelin: unknown }).bengkelin = bridge;
  return bridge;
};
const fail = (code: string) => ({
  ok: false as const,
  error: { code, messageKey: `errors.${code}` },
});
afterEach(() => vi.restoreAllMocks());

const NOW = '2026-09-30T03:00:00.000Z';
const cashierDto = (extra: Partial<CashierDto>): CashierDto => ({
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: 'Pak Budi',
  role: 'ADMIN',
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});

describe('cashier management', () => {
  test('lists cashiers, creates one, and shows LAST_ACTIVE_ADMIN clearly', async () => {
    const admin = cashierDto({});
    const siti = cashierDto({
      id: '22222222-2222-4222-8222-222222222222',
      username: 'siti',
      displayName: 'Siti',
      role: 'CASHIER',
    });
    const joko = cashierDto({
      id: '33333333-3333-4333-8333-333333333333',
      username: 'joko',
      displayName: 'Joko',
      role: 'CASHIER',
    });
    const cashiers = {
      list: vi.fn(async () => ok([admin, siti])),
      create: vi.fn(async () => ok(joko)),
      changeRole: vi.fn(async () => fail('LAST_ACTIVE_ADMIN')),
      updateDisplayName: vi.fn(),
      deactivate: vi.fn(),
      reactivate: vi.fn(),
      resetPassword: vi.fn(),
    };
    install({ cashiers });
    render(<CashiersScreen />);
    expect(await screen.findAllByTestId('cashier-row')).toHaveLength(2);

    const user = userEvent.setup();
    const form = screen.getByRole('form', { name: 'Tambah kasir' });
    await user.type(within(form).getByLabelText('Nama pengguna'), 'joko');
    await user.type(within(form).getByLabelText('Nama tampilan'), 'Joko');
    await user.type(
      within(form).getByLabelText('Kata sandi'),
      'joko-password-1',
    );
    await user.click(
      within(form).getByRole('button', { name: 'Tambah kasir' }),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('cashier-row')).toHaveLength(3),
    );
    expect(cashiers.create).toHaveBeenCalledWith({
      username: 'joko',
      displayName: 'Joko',
      password: 'joko-password-1',
      role: 'CASHIER',
      language: 'id',
      appearance: 'SYSTEM',
    });

    await user.click(screen.getByRole('button', { name: 'Kelola: Pak Budi' }));
    const dialog = screen.getByRole('dialog', { name: /Pak Budi/ });
    await user.selectOptions(within(dialog).getByLabelText('Peran'), 'CASHIER');
    await user.click(
      within(dialog).getByRole('button', { name: 'Simpan peran' }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Admin aktif terakhir',
    );
  });
});

describe('shop settings', () => {
  const shop = {
    name: 'Bengkel Maju',
    address: 'Jl. A',
    phoneNumber: null,
    email: null,
    invoiceFooter: null,
    complaintPhoneNumber: null,
    socialMediaUrl: null,
    timezone: 'Asia/Jakarta',
  };

  test('edits identity; warns about a timezone change; refuses an unknown zone locally', async () => {
    const settings = {
      getShop: vi.fn(async () => ok(shop)),
      updateShop: vi.fn(async () => ok(undefined)),
      getPublic: vi.fn(async () =>
        ok({
          setupCompleted: true,
          language: 'id',
          appearance: 'SYSTEM',
          shopName: 'Bengkel Maju Jaya',
        }),
      ),
    };
    install({ settings });
    const onSaved = vi.fn();
    render(<ShopSettingsSection onSaved={onSaved} />);
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Nama bengkel');
    await waitFor(() => expect(name).toHaveValue('Bengkel Maju'));
    expect(screen.queryByTestId('timezone-warning')).not.toBeInTheDocument();

    await user.type(
      screen.getByLabelText('Nomor keluhan pelanggan'),
      '0878-1640-9387',
    );
    await user.type(
      screen.getByLabelText('Tautan media sosial'),
      'https://s.id/mitramotorbersama?s=qr',
    );
    const zone = screen.getByLabelText('Zona waktu');
    await user.clear(zone);
    await user.type(zone, 'Mars/Olympus');
    await user.click(
      screen.getByRole('button', { name: 'Simpan informasi bengkel' }),
    );
    expect(
      await screen.findByText('Zona waktu tidak dikenal.'),
    ).toBeInTheDocument();
    expect(settings.updateShop).not.toHaveBeenCalled();

    await user.clear(zone);
    await user.type(zone, 'Asia/Makassar');
    expect(screen.getByTestId('timezone-warning')).toBeInTheDocument();
    await user.clear(name);
    await user.type(name, 'Bengkel Maju Jaya');
    await user.type(
      screen.getByLabelText('Catatan kaki faktur'),
      'Terima kasih',
    );
    await user.click(
      screen.getByRole('button', { name: 'Simpan informasi bengkel' }),
    );
    await waitFor(() =>
      expect(settings.updateShop).toHaveBeenCalledWith({
        name: 'Bengkel Maju Jaya',
        address: 'Jl. A',
        phoneNumber: '',
        email: '',
        invoiceFooter: 'Terima kasih',
        complaintPhoneNumber: '0878-1640-9387',
        socialMediaUrl: 'https://s.id/mitramotorbersama?s=qr',
        timezone: 'Asia/Makassar',
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/tersimpan/i);
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ shopName: 'Bengkel Maju Jaya' }),
    );
  }, 30_000);
});

describe('cashier filters (T11 carry)', () => {
  test('a CASHIER gets every cashier name from the names-only listing', async () => {
    const session: CashierSession = {
      numberFormat: 'ID',
      cashierId: '22222222-2222-4222-8222-222222222222',
      username: 'siti',
      displayName: 'Siti',
      role: 'CASHIER',
      language: 'id',
      appearance: 'SYSTEM',
    };
    install({
      references: { listActive: vi.fn(async () => ok([])) },
      cashiers: {
        listNames: vi.fn(async () =>
          ok([
            { id: 'a', displayName: 'Pak Budi', isActive: true },
            { id: session.cashierId, displayName: 'Siti', isActive: true },
            { id: 'c', displayName: 'Joko', isActive: false },
          ]),
        ),
      },
    });
    const { result } = renderHook(() => useFilterOptions(session));
    await waitFor(() => expect(result.current.cashiers).toHaveLength(3));
    expect(result.current.cashiers.map((c) => c.label)).toEqual([
      'Pak Budi',
      'Siti',
      'Joko',
    ]);
  });
});

describe('ad-hoc references (spec 12)', () => {
  test('ADMIN lists, deactivates and edits the description', async () => {
    const reference: AdHocReferenceDto = {
      id: '44444444-4444-4444-8444-444444444444',
      type: 'SERVICE',
      title: 'Jasa las bracket',
      description: null,
      unitId: null,
      defaultPrice: '35000',
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const api = {
      list: vi.fn(async () => ok([reference])),
      deactivate: vi.fn(async () => ok({ ...reference, isActive: false })),
      reactivate: vi.fn(),
      update: vi.fn(async () =>
        ok({ ...reference, description: 'Las ringan' }),
      ),
    };
    install({ adHocReferences: api });
    render(<AdHocReferencesPanel />);
    const row = await screen.findByTestId('adhoc-row');
    expect(row).toHaveTextContent('Jasa las bracket');
    const user = userEvent.setup();
    await user.click(
      within(row).getByRole('button', {
        name: 'Nonaktifkan: Jasa las bracket',
      }),
    );
    await waitFor(() => expect(row).toHaveTextContent('Nonaktif'));
    expect(api.deactivate).toHaveBeenCalledWith({ id: reference.id });

    await user.click(
      within(row).getByRole('button', { name: 'Ubah: Jasa las bracket' }),
    );
    const description = screen.getByLabelText('Keterangan');
    await user.type(description, 'Las ringan');
    await user.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith({
        id: reference.id,
        description: 'Las ringan',
      }),
    );
  });
});

describe('customer and vehicle master data (T5 carry)', () => {
  test('the full customer form edits every spec 6 field', async () => {
    const customer: CustomerDto = {
      isActive: true,
      externalId: null,
      id: '55555555-5555-4555-8555-555555555555',
      name: 'Budi',
      phoneNumber: '0812',
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
      createdAt: NOW,
      updatedAt: NOW,
    };
    const save = vi.fn(async () =>
      ok({ saved: true as const, customer: { ...customer, rt: '003' } }),
    );
    install({ customers: { save } });
    const onSaved = vi.fn();
    render(
      <CustomerEditForm
        customer={customer}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    const fields: [string, string][] = [
      ['Email', 'budi@example.com'],
      ['Tanggal lahir', '1990-05-01'],
      ['Alamat', 'Jl. Merdeka 1'],
      ['RT', '003'],
      ['RW', '004'],
      ['Kelurahan', 'Sukajadi'],
      ['Kecamatan', 'Sukasari'],
      ['Kota/Kabupaten', 'Bandung'],
      ['Provinsi', 'Jawa Barat'],
      ['Kode pos', '40162'],
    ];
    for (const [label, text] of fields) {
      await user.type(screen.getByLabelText(label), text);
    }
    await user.click(screen.getByRole('button', { name: 'Simpan pelanggan' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith({
      id: customer.id,
      isActive: true,
      name: 'Budi',
      phoneNumber: '0812',
      email: 'budi@example.com',
      birthdate: '1990-05-01',
      address: 'Jl. Merdeka 1',
      rt: '003',
      rw: '004',
      kelurahan: 'Sukajadi',
      kecamatan: 'Sukasari',
      cityOrRegency: 'Bandung',
      province: 'Jawa Barat',
      postalCode: '40162',
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  test('ADMIN can deactivate a vehicle from its detail', async () => {
    const detail: VehicleDetailDto = {
      vehicle: {
        id: '66666666-6666-4666-8666-666666666666',
        plateNumber: 'B 1234 XYZ',
        normalizedPlateNumber: 'B1234XYZ',
        brandId: null,
        brandName: null,
        vehicleModelId: null,
        modelName: null,
        year: null,
        color: null,
        notes: null,
        isActive: true,
        activeOwnerId: null,
        activeOwner: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      ownerships: [],
    };
    const deactivate = vi.fn(async () =>
      ok({ ...detail.vehicle, isActive: false }),
    );
    install({ vehicles: { deactivate, reactivate: vi.fn() } });
    const onChanged = vi.fn();
    render(
      <VehicleDetail
        detail={detail}
        customer={null}
        role="ADMIN"
        onTransferred={onChanged}
      />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Nonaktifkan kendaraan' }),
    );
    await waitFor(() =>
      expect(deactivate).toHaveBeenCalledWith({ id: detail.vehicle.id }),
    );
    await waitFor(() =>
      expect(onChanged).toHaveBeenCalledWith({
        ...detail,
        vehicle: { ...detail.vehicle, isActive: false },
      }),
    );
  });

  test('a CASHIER sees no vehicle deactivation', () => {
    install({});
    render(
      <VehicleDetail
        detail={{
          vehicle: {
            id: '66666666-6666-4666-8666-666666666666',
            plateNumber: 'B 1234 XYZ',
            normalizedPlateNumber: 'B1234XYZ',
            brandId: null,
            brandName: null,
            vehicleModelId: null,
            modelName: null,
            year: null,
            color: null,
            notes: null,
            isActive: true,
            activeOwnerId: null,
            activeOwner: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
          ownerships: [],
        }}
        customer={null}
        role="CASHIER"
        onTransferred={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'Nonaktifkan kendaraan' }),
    ).not.toBeInTheDocument();
  });
});

describe.each(['Sales', 'Ekspedisi'])('%s reference management', (name) => {
  test('creates a coded master with contact fields', async () => {
    const entity = name === 'Sales' ? 'sales' : 'expedition';
    const references = {
      list: vi.fn(async () => ok([])),
      save: vi.fn(async (input) =>
        ok({ ...input, id: 'new-id', isActive: true }),
      ),
    };
    install({ references });
    render(<ReferencesScreen />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name }));
    await user.click(screen.getByRole('button', { name: 'Tambah' }));
    const form = screen.getByRole('form');
    await user.type(within(form).getByLabelText('Kode'), '001');
    await user.type(within(form).getByLabelText('Label'), 'Master name');
    await user.type(within(form).getByLabelText('Alamat'), 'Street');
    await user.type(within(form).getByLabelText('Kota'), 'Bandung');
    await user.click(within(form).getByRole('button', { name: 'Simpan' }));
    await waitFor(() =>
      expect(references.save).toHaveBeenCalledWith({
        entity,
        code: '001',
        label: 'Master name',
        address: 'Street',
        city: 'Bandung',
        ...(entity === 'sales' ? { phoneNumber: '' } : {}),
      }),
    );
  });
});

test('switching reference rows loads the selected row fields before saving', async () => {
  const base = {
    entity: 'sales',
    code: '001',
    phoneNumber: null,
    brandId: null,
    address: null,
    city: null,
    isActive: true,
  };
  const a = { ...base, id: 'a', label: 'Alpha', address: 'Alpha Street' };
  const b = {
    ...base,
    code: '002',
    id: 'b',
    label: 'Beta',
    address: 'Beta Street',
  };
  const save = vi.fn(async (input) => ok({ ...b, ...input }));
  install({ references: { list: vi.fn(async () => ok([a, b])), save } });
  render(<ReferencesScreen />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: 'Sales' }));
  await user.click(await screen.findByRole('button', { name: 'Ubah: Alpha' }));
  await user.click(screen.getByRole('button', { name: 'Ubah: Beta' }));
  const form = screen.getByRole('form');
  expect(within(form).getByLabelText('Label')).toHaveValue('Beta');
  expect(within(form).getByLabelText('Alamat')).toHaveValue('Beta Street');
  await user.click(within(form).getByRole('button', { name: 'Simpan' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'b',
        label: 'Beta',
        address: 'Beta Street',
      }),
    ),
  );
  await user.click(screen.getByRole('button', { name: 'Ubah: Alpha' }));
  await user.click(screen.getByRole('button', { name: 'Tambah' }));
  expect(within(screen.getByRole('form')).getByLabelText('Label')).toHaveValue(
    '',
  );
});
