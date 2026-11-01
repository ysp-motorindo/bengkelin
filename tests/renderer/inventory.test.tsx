import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { InventoryScreen } from '@/renderer/features/inventory/InventoryScreen';
import type { StockChangeDto } from '@/shared/contracts';

const LOCATION = {
  id: '11111111-1111-4111-8111-111111111119',
  code: '01',
  label: 'Gudang',
};
const LOCATION_REF = {
  ...LOCATION,
  entity: 'stockLocation',
  isActive: true,
  isDefault: true,
};
const ITEM = '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11';

function bridge(setStock: ReturnType<typeof vi.fn>) {
  const listed = {
    stockLocation: LOCATION,
    items: [
      {
        catalogItemId: ITEM,
        title: 'Oli MPX2',
        sku: 'OLI',
        unitLabel: 'PCS',
        isActive: true,
        quantity: 30,
        isNegative: false,
      },
    ],
  };
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    references: {
      list: vi.fn(async () => ({ ok: true, value: [LOCATION_REF] })),
      listActive: vi.fn(async () => ({ ok: true, value: [LOCATION_REF] })),
    },
    inventory: {
      listStock: vi.fn(async () => ({ ok: true, value: listed })),
      getStock: vi.fn(async () => ({
        ok: true,
        value: { stockLocation: LOCATION, catalogItemId: ITEM, quantity: 30 },
      })),
      history: vi.fn(async () => ({
        ok: true,
        value: {
          stockLocation: LOCATION,
          catalogItemId: ITEM,
          timezone: 'Asia/Jakarta',
          entries: [],
        },
      })),
      setStock,
    },
  };
}

async function openItem() {
  await userEvent.click(
    await screen.findByRole('button', { name: /Buka: Oli MPX2/ }),
  );
}

describe('inventory screen', () => {
  beforeEach(() => vi.restoreAllMocks());

  test('opens stock in a dialog and closes it', async () => {
    bridge(vi.fn());
    render(<InventoryScreen role="CASHIER" />);
    await openItem();
    expect(
      within(screen.getByRole('dialog')).getAllByRole('heading', {
        name: 'Oli MPX2',
      }),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole('dialog')).getByTestId('stock-current'),
    ).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('a CASHIER sees stock but no stock actions', async () => {
    bridge(vi.fn());
    render(<InventoryScreen role="CASHIER" />);
    await openItem();
    expect(await screen.findByTestId('stock-current')).toHaveTextContent(
      'Stok saat ini: 30',
    );
    expect(
      screen.queryByRole('button', { name: 'Atur stok menjadi...' }),
    ).not.toBeInTheDocument();
  });

  test('set stock shows the computed delta and reuses the request id on a retry of the same submission only', async () => {
    const ids: string[] = [];
    const setStock = vi.fn(
      async (input: { requestId: string; targetQuantity: number }) => {
        ids.push(input.requestId);
        if (ids.length === 1) throw new Error('ipc down');
        const result: StockChangeDto = {
          stockLocation: LOCATION,
          entryId: 'e1',
          catalogItemId: ITEM,
          quantityDelta: input.targetQuantity - 30,
          newQuantity: input.targetQuantity,
        };
        return { ok: true, value: result };
      },
    );
    bridge(setStock);
    render(<InventoryScreen role="ADMIN" />);
    await openItem();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Atur stok menjadi...' }),
    );
    const form = screen.getByRole('form', { name: 'Atur stok menjadi...' });
    await userEvent.type(within(form).getByLabelText('Jumlah stok baru'), '25');
    expect(screen.getByTestId('set-stock-preview')).toHaveTextContent(
      'Perubahan: -5 (30 menjadi 25)',
    );
    await userEvent.type(
      within(form).getByLabelText('Alasan (wajib)'),
      'Stok opname',
    );

    // First attempt fails; the retry is the same submission.
    await userEvent.click(
      within(form).getByRole('button', { name: 'Konfirmasi' }),
    );
    await waitFor(() => expect(ids).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    await userEvent.click(
      within(form).getByRole('button', { name: 'Konfirmasi' }),
    );
    await waitFor(() => expect(ids).toHaveLength(2));
    expect(ids[1]).toBe(ids[0]);
    expect(await screen.findByTestId('stock-notice')).toHaveTextContent(
      'Perubahan: -5. Stok sekarang 25.',
    );
  });

  test('changing the input after a failure starts a new submission with a new request id', async () => {
    const ids: string[] = [];
    const setStock = vi.fn(async (input: { requestId: string }) => {
      ids.push(input.requestId);
      throw new Error('ipc down');
    });
    bridge(setStock);
    render(<InventoryScreen role="ADMIN" />);
    await openItem();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Atur stok menjadi...' }),
    );
    const form = screen.getByRole('form', { name: 'Atur stok menjadi...' });
    await userEvent.type(within(form).getByLabelText('Jumlah stok baru'), '25');
    await userEvent.type(within(form).getByLabelText('Alasan (wajib)'), 'a');
    await userEvent.click(
      within(form).getByRole('button', { name: 'Konfirmasi' }),
    );
    await waitFor(() => expect(ids).toHaveLength(1));
    await userEvent.type(within(form).getByLabelText('Alasan (wajib)'), 'b');
    await userEvent.click(
      within(form).getByRole('button', { name: 'Konfirmasi' }),
    );
    await waitFor(() => expect(ids).toHaveLength(2));
    expect(ids[1]).not.toBe(ids[0]);
  });

  test('a missing reason is caught before anything is sent', async () => {
    const setStock = vi.fn();
    bridge(setStock);
    render(<InventoryScreen role="ADMIN" />);
    await openItem();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Atur stok menjadi...' }),
    );
    const form = screen.getByRole('form', { name: 'Atur stok menjadi...' });
    await userEvent.type(within(form).getByLabelText('Jumlah stok baru'), '25');
    await userEvent.click(
      within(form).getByRole('button', { name: 'Konfirmasi' }),
    );
    expect(await screen.findByText('Isi alasan.')).toBeInTheDocument();
    expect(setStock).not.toHaveBeenCalled();
  });
});

test('location switching scopes stock requests and clears the previous item', async () => {
  bridge(vi.fn());
  const b = window.bengkelin;
  const locations = [
    { id: 'A', code: 'A', label: 'Alpha', isActive: true, isDefault: false },
    {
      id: 'B',
      code: 'B',
      label: 'Renamed depot',
      isActive: true,
      isDefault: true,
    },
  ];
  Object.assign(b, {
    references: {
      list: vi.fn(async () => ({ ok: true, value: locations })),
      listActive: vi.fn(async () => ({ ok: true, value: locations })),
    },
  });
  render(<InventoryScreen role="ADMIN" />);
  const selector = await screen.findByRole('combobox', { name: 'Lokasi stok' });
  await waitFor(() => expect(selector).toHaveValue('B'));
  await openItem();
  await userEvent.keyboard('{Escape}');
  await userEvent.selectOptions(selector, 'A');
  await waitFor(() =>
    expect(b.inventory.listStock).toHaveBeenLastCalledWith(
      expect.objectContaining({ stockLocationId: 'A' }),
    ),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
test('no active location gives setup guidance without querying unscoped stock', async () => {
  bridge(vi.fn());
  Object.assign(window.bengkelin, {
    references: {
      list: vi.fn(async () => ({ ok: true, value: [] })),
      listActive: vi.fn(async () => ({ ok: true, value: [] })),
    },
  });
  render(<InventoryScreen role="ADMIN" />);
  expect(
    await screen.findByText(/Siapkan lokasi stok aktif/),
  ).toBeInTheDocument();
  expect(window.bengkelin.inventory.listStock).not.toHaveBeenCalled();
});
