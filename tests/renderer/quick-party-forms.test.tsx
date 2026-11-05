import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { QuickCustomerForm } from '@/renderer/features/customers/QuickCustomerForm';
import { QuickVehicleForm } from '@/renderer/features/customers/QuickVehicleForm';
import type { CustomerDto, VehicleDto } from '@/shared/contracts';

const customer: CustomerDto = {
  id: 'customer',
  name: 'Budi',
  phoneNumber: '0812',
  isActive: true,
  externalId: null,
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
const vehicle = { id: 'vehicle', plateNumber: 'B 1234 XY' } as VehicleDto;
const ok = <T,>(value: T) => ({ ok: true as const, value });
function install() {
  const api = {
    customers: { save: vi.fn(async () => ok({ saved: true, customer })) },
    vehicles: {
      save: vi.fn(async () => ok({ reusedExisting: false, vehicle })),
    },
    references: { listActive: vi.fn(async () => ok([])) },
  };
  Object.assign(window, { bengkelin: api });
  return api;
}

for (const mode of ['customer', 'vehicle'] as const) {
  test(`${mode} modal owns one heading and submits from a persistent footer`, async () => {
    const api = install();
    const selected = vi.fn();
    render(
      mode === 'customer' ? (
        <QuickCustomerForm onSelected={selected} onClose={() => {}} />
      ) : (
        <QuickVehicleForm
          customer={customer}
          onSelected={selected}
          onClose={() => {}}
        />
      ),
    );
    const dialog = screen.getByRole('dialog');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(dialog).getAllByRole('heading')).toHaveLength(1);
    expect(dialog.querySelector('.shadow-sm')).toBeNull();
    const submit = within(dialog).getByRole('button', {
      name: mode === 'customer' ? 'Simpan pelanggan' : 'Simpan kendaraan',
    });
    expect(submit.closest('.dialog-scroll-area')).toBeNull();
    expect((submit as HTMLButtonElement).form).toBe(
      dialog.querySelector('form'),
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(mode === 'customer' ? 'Nama' : 'Nomor plat'),
      mode === 'customer' ? 'Budi' : 'B 1234 XY',
    );
    await user.click(submit);
    await waitFor(() =>
      expect(selected).toHaveBeenCalledWith(
        mode === 'customer' ? customer : vehicle,
      ),
    );
    expect(
      mode === 'customer' ? api.customers.save : api.vehicles.save,
    ).toHaveBeenCalledOnce();
  });

  for (const dismissal of ['Batal', 'Tutup', 'Escape']) {
    test(`${mode} ${dismissal} dismisses and restores focus`, async () => {
      install();
      function Harness() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button onClick={() => setOpen(true)}>Open</button>
            {open ? (
              mode === 'customer' ? (
                <QuickCustomerForm
                  onSelected={() => {}}
                  onClose={() => setOpen(false)}
                />
              ) : (
                <QuickVehicleForm
                  customer={null}
                  onSelected={() => {}}
                  onClose={() => setOpen(false)}
                />
              )
            ) : null}
          </>
        );
      }
      render(<Harness />);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Open' }));
      expect(screen.getByRole('dialog')).toBeVisible();
      if (dismissal === 'Escape') await user.keyboard('{Escape}');
      else await user.click(screen.getByRole('button', { name: dismissal }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus(),
      );
    });
  }

  test(`${mode} modal displays server field validation`, async () => {
    const api = install();
    const save = mode === 'customer' ? api.customers.save : api.vehicles.save;
    save.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        messageKey: 'errors.VALIDATION_ERROR',
        fieldErrors: {
          [mode === 'customer' ? 'name' : 'plateNumber']: 'validation.required',
        },
      },
    } as never);
    render(
      mode === 'customer' ? (
        <QuickCustomerForm onSelected={() => {}} onClose={() => {}} />
      ) : (
        <QuickVehicleForm
          customer={null}
          onSelected={() => {}}
          onClose={() => {}}
        />
      ),
    );
    await userEvent.setup().click(
      screen.getByRole('button', {
        name: mode === 'customer' ? 'Simpan pelanggan' : 'Simpan kendaraan',
      }),
    );
    await screen.findByRole('alert');
    expect(
      screen.getByLabelText(mode === 'customer' ? 'Nama' : 'Nomor plat'),
    ).toHaveAttribute('aria-invalid', 'true');
  });
}

test('inline quick forms keep cards and independent unique form associations', async () => {
  const api = install();
  render(
    <>
      <QuickCustomerForm onSelected={() => {}} />
      <QuickVehicleForm customer={null} onSelected={() => {}} />
      <QuickCustomerForm onSelected={() => {}} />
    </>,
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getAllByRole('heading')).toHaveLength(3);
  const forms = screen.getAllByRole('form');
  const ids = forms.map((form) => form.id);
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(3);
  const user = userEvent.setup();
  await user.type(within(forms[1]!).getByLabelText('Nomor plat'), 'B123');
  await user.click(
    within(forms[1]!).getByRole('button', { name: 'Simpan kendaraan' }),
  );
  await waitFor(() => expect(api.vehicles.save).toHaveBeenCalledOnce());
  expect(api.customers.save).not.toHaveBeenCalled();
});

for (const reuse of [false, true]) {
  test(`customer duplicate modal ${reuse ? 'reuses match' : 'acknowledges in footer'}`, async () => {
    const api = install();
    api.customers.save.mockResolvedValueOnce(
      ok({ saved: false, warning: { matches: [customer] } }) as never,
    );
    const selected = vi.fn();
    render(<QuickCustomerForm onSelected={selected} onClose={() => {}} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Telepon'), '0812');
    await user.click(screen.getByRole('button', { name: 'Simpan pelanggan' }));
    const acknowledge = await screen.findByRole('button', {
      name: 'Tetap simpan sebagai pelanggan baru',
    });
    expect(acknowledge.closest('.dialog-scroll-area')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Simpan pelanggan' }),
    ).not.toBeInTheDocument();
    if (reuse)
      await user.click(
        screen.getByRole('button', { name: 'Pakai pelanggan ini' }),
      );
    else await user.click(acknowledge);
    await waitFor(() => expect(selected).toHaveBeenCalledWith(customer));
    expect(api.customers.save).toHaveBeenCalledTimes(reuse ? 1 : 2);
    if (!reuse)
      expect(api.customers.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ acknowledgeDuplicates: true }),
      );
  });
}

test('vehicle reuse replaces footer submit and selects without another save', async () => {
  const api = install();
  api.vehicles.save.mockResolvedValueOnce(
    ok({ reusedExisting: true, vehicle }),
  );
  const selected = vi.fn();
  render(
    <QuickVehicleForm
      customer={null}
      onSelected={selected}
      onClose={() => {}}
    />,
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Nomor plat'), 'B1234XY');
  await user.click(screen.getByRole('button', { name: 'Simpan kendaraan' }));
  const reuse = await screen.findByRole('button', {
    name: 'Pakai kendaraan ini',
  });
  expect(reuse.closest('.dialog-scroll-area')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Simpan kendaraan' }),
  ).not.toBeInTheDocument();
  await user.click(reuse);
  expect(selected).toHaveBeenCalledWith(vehicle);
  expect(api.vehicles.save).toHaveBeenCalledOnce();
});
