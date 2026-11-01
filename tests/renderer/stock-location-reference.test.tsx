import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { ReferencesScreen } from '@/renderer/features/references/ReferencesScreen';
import { ok } from './helpers/workspace-bridge';

test('stock locations use immutable codes and an editable default checkbox', async () => {
  const saved = {
    entity: 'stockLocation',
    id: 'loc',
    code: '01',
    label: 'Gudang',
    isActive: true,
    isDefault: true,
    phoneNumber: null,
    brandId: null,
    address: null,
    city: null,
  };
  const save = vi.fn(async () => ok(saved));
  Object.assign(window, {
    bengkelin: {
      references: { list: vi.fn(async () => ok([])), save },
      referenceTransfer: {},
    },
  });
  const user = userEvent.setup();
  render(<ReferencesScreen />);
  await user.click(screen.getByRole('tab', { name: 'Lokasi stok' }));
  expect(screen.getByRole('button', { name: 'Impor CSV' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Tambah' }));
  await user.type(screen.getByLabelText('Kode'), '01');
  await user.type(screen.getByLabelText('Label'), 'Gudang');
  await user.click(screen.getByRole('checkbox', { name: 'Default' }));
  await user.click(screen.getByRole('button', { name: 'Simpan' }));
  expect(save).toHaveBeenCalledWith({
    entity: 'stockLocation',
    code: '01',
    label: 'Gudang',
    isDefault: true,
  });
  await user.click(await screen.findByRole('button', { name: 'Ubah: Gudang' }));
  expect(screen.getByLabelText('Kode')).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'Default' })).toBeChecked();
});
