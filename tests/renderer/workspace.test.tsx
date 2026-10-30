import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { CashierWorkspace } from '@/renderer/features/workspace/CashierWorkspace';
import { cashChange } from '@/renderer/features/workspace/checkout/tender';
import { getWorkspaceActions } from '@/renderer/features/workspace/workspace-actions';
import { formatIdr, parseRupiahInput } from '@/renderer/lib/money';
import type { CatalogItemDto, DraftCommand } from '@/shared/contracts';
import { draftView, ok, workspaceBridge } from './helpers/workspace-bridge';

function install() {
  const bridge = workspaceBridge();
  (window as unknown as { bengkelin: unknown }).bengkelin = bridge;
  return bridge;
}

const ops = (bridge: ReturnType<typeof workspaceBridge>) =>
  bridge.drafts.apply.mock.calls.map(
    (call) => (call[0] as DraftCommand).op.kind,
  );

describe('cashier workspace', () => {
  test('starts a draft in the shop timezone and focuses "Cari barang"', async () => {
    const bridge = install();
    render(<CashierWorkspace />);
    const search = await screen.findByRole('combobox', { name: 'Cari barang' });
    await waitFor(() => expect(search).toHaveFocus());
    expect(bridge.drafts.create).toHaveBeenCalledOnce();
    const input = bridge.drafts.create.mock.calls[0]![0];
    expect(input.invoiceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(input.pricingAt).toMatch(/Z$/);
    expect(screen.getByTestId('header-customer')).toHaveTextContent('Umum');
  });

  test('keeps the due date compact and places odometer after the customer field', async () => {
    install();
    render(<CashierWorkspace />);
    await screen.findByRole('combobox', { name: 'Cari barang' });

    const customer = screen.getByLabelText('Pelanggan & kendaraan');
    const odometer = screen.getByLabelText('Odometer (km)');
    const dueDate = screen.getByTestId('header-due-date');
    const topDays = screen.getByLabelText('TOP (hari)');
    expect(dueDate).toHaveValue('30/09/2026');
    expect(dueDate).toHaveAttribute('readonly');
    const table = screen.getByRole('table');
    const note = screen.getByRole('textbox', { name: 'Catatan' });
    expect(
      customer.compareDocumentPosition(table) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      table.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      customer.compareDocumentPosition(odometer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      topDays.compareDocumentPosition(dueDate) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('scanner Enter in "Cari barang" adds by barcode and clears the field', async () => {
    const bridge = install();
    render(<CashierWorkspace />);
    const user = userEvent.setup();
    const search = await screen.findByRole('combobox', { name: 'Cari barang' });
    await user.click(search);
    await user.keyboard('8991234567890{Enter}');
    await waitFor(() => expect(bridge.drafts.apply).toHaveBeenCalledOnce());
    const command = bridge.drafts.apply.mock.calls[0]![0] as DraftCommand;
    expect(command.op).toEqual({
      kind: 'addCatalogLine',
      barcode: '8991234567890',
      quantity: 1,
    });
    expect(command.expectedVersion).toBe(1);
    expect(search).toHaveValue('');
  });

  test('digits + Enter typed into other fields are never treated as a scan', async () => {
    const bridge = install();
    render(<CashierWorkspace />);
    const user = userEvent.setup();
    await screen.findByRole('combobox', { name: 'Cari barang' });
    await user.click(screen.getByRole('textbox', { name: 'Catatan' }));
    await user.keyboard('8991234567890{Enter}');
    await user.click(screen.getByLabelText('Odometer (km)'));
    await user.keyboard('12345{Enter}');
    expect(getWorkspaceActions()).not.toBeNull();
    await getWorkspaceActions()!.saveDraft();
    expect(ops(bridge)).not.toContain('addCatalogLine');
    expect(ops(bridge)).toContain('updateHeader');
  });
});

describe('invalid unsent input is never labelled saved (C1)', () => {
  test('clearing a saved amount marks it unsaved and blocks checkout review', async () => {
    const bridge = install();
    render(<CashierWorkspace />);
    const user = userEvent.setup();
    await screen.findByRole('combobox', { name: 'Cari barang' });
    await user.click(screen.getByRole('button', { name: 'Tambah pembayaran' }));
    const amount = screen.getByRole('textbox', { name: 'Nominal 1' });
    await user.type(amount, '150');
    await waitFor(() =>
      expect(screen.getByTestId('save-state')).toHaveAttribute(
        'data-state',
        'saved',
      ),
    );
    const allocationOps = () =>
      bridge.drafts.apply.mock.calls
        .map((call) => (call[0] as DraftCommand).op)
        .filter((op) => op.kind === 'setCheckoutAllocations');
    expect(allocationOps().at(-1)).toMatchObject({
      allocations: [{ method: 'CASH', amount: '150' }],
    });

    await user.clear(amount);
    expect(screen.getByTestId('save-state')).toHaveAttribute(
      'data-state',
      'unsaved',
    );
    expect(screen.getByTestId('save-state')).not.toHaveTextContent('Tersimpan');
    const sent = allocationOps().length;
    await getWorkspaceActions()!.openCheckoutReview();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Perubahan belum tersimpan',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await getWorkspaceActions()!.saveDraft()).toBe(false);
    expect(allocationOps()).toHaveLength(sent);

    // Fixing the value sends it; then the state is Saved again.
    await user.clear(amount);
    await user.type(amount, '150.000');
    expect(await getWorkspaceActions()!.saveDraft()).toBe(true);
    expect(allocationOps().at(-1)).toMatchObject({
      allocations: [{ method: 'CASH', amount: '150000' }],
    });
    await waitFor(() =>
      expect(screen.getByTestId('save-state')).toHaveAttribute(
        'data-state',
        'saved',
      ),
    );
  });
});

describe('Pay Full replaces invalid allocation input (C1)', () => {
  test('an invalid amount, then "Bayar Penuh Tunai": the rows follow the server and the state is Saved', async () => {
    install();
    render(<CashierWorkspace />);
    const user = userEvent.setup();
    await screen.findByRole('combobox', { name: 'Cari barang' });
    await user.click(screen.getByRole('button', { name: 'Tambah pembayaran' }));
    const amount = screen.getByRole('textbox', { name: 'Nominal 1' });
    await user.type(amount, '1');
    await user.clear(amount);
    expect(screen.getByTestId('save-state')).toHaveAttribute(
      'data-state',
      'unsaved',
    );
    await user.click(screen.getByRole('button', { name: 'Bayar Penuh Tunai' }));
    await waitFor(() =>
      expect(screen.getByTestId('save-state')).toHaveAttribute(
        'data-state',
        'saved',
      ),
    );
    // The draft total is 0, so Pay Full plans no allocation: the invalid
    // row is gone with it.
    expect(screen.queryAllByTestId('allocation-row')).toHaveLength(0);
    expect(await getWorkspaceActions()!.saveDraft()).toBe(true);
  });
});

describe('scanner Enter after new input is a scan, never a highlighted pick', () => {
  const SERVICE: CatalogItemDto = {
    id: '3c9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11',
    type: 'SERVICE',
    title: 'Jasa Servis Ringan',
    description: null,
    sku: null,
    unitId: 'u',
    unitCode: 'SERVICE',
    unitLabel: 'Service',
    weight: null,
    trackInventory: false,
    isActive: true,
    barcodes: [],
    createdAt: '2026-09-30T03:00:00.000Z',
    updatedAt: '2026-09-30T03:00:00.000Z',
  };

  function installWithSearch() {
    const bridge = install();
    bridge.catalog.search = vi.fn(async () => ok({ results: [SERVICE] }));
    const apply = bridge.drafts.apply;
    bridge.drafts.apply = vi.fn(async (command: DraftCommand) => {
      const op = command.op as { kind: string; barcode?: string };
      if (op.kind === 'addCatalogLine' && op.barcode === 'servis') {
        return {
          ok: false as const,
          error: {
            code: 'UNKNOWN_BARCODE',
            messageKey: 'errors.UNKNOWN_BARCODE',
          },
        };
      }
      return apply(command);
    });
    return bridge;
  }

  const addOps = (bridge: ReturnType<typeof workspaceBridge>) =>
    bridge.drafts.apply.mock.calls
      .map((call) => (call[0] as DraftCommand).op)
      .filter((op) => op.kind === 'addCatalogLine');

  test('a result highlighted with ArrowDown, then a scan: the scanned barcode is added', async () => {
    const bridge = installWithSearch();
    render(<CashierWorkspace />);
    const user = userEvent.setup();
    const search = await screen.findByRole('combobox', { name: 'Cari barang' });
    await user.click(search);
    await user.keyboard('servis');
    await screen.findByRole('option', { name: /Jasa Servis Ringan/ });
    await user.keyboard('{ArrowDown}');
    expect(
      screen.getByRole('option', { name: /Jasa Servis Ringan/ }),
    ).toHaveAttribute('aria-selected', 'true');
    // The scanner types into the same field, then Enter.
    await user.keyboard('{Control>}a{/Control}8991234567890{Enter}');
    await waitFor(() => expect(addOps(bridge)).toHaveLength(1));
    expect(addOps(bridge)[0]).toEqual({
      kind: 'addCatalogLine',
      barcode: '8991234567890',
      quantity: 1,
    });
  });

  test('fallback results shown after non-barcode text, then a scan: the scanned barcode is added', async () => {
    const bridge = installWithSearch();
    render(<CashierWorkspace />);
    const user = userEvent.setup();
    const search = await screen.findByRole('combobox', { name: 'Cari barang' });
    await user.click(search);
    await user.keyboard('servis{Enter}');
    // Not a barcode: the results are offered, with nothing picked yet.
    await screen.findByText(/Bukan barcode/);
    expect(search).toHaveValue('');
    expect(
      screen.getByRole('option', { name: /Jasa Servis Ringan/ }),
    ).toHaveAttribute('aria-selected', 'false');
    await user.keyboard('8991234567890{Enter}');
    await waitFor(() => expect(addOps(bridge)).toHaveLength(2));
    expect(addOps(bridge)[1]).toEqual({
      kind: 'addCatalogLine',
      barcode: '8991234567890',
      quantity: 1,
    });
    expect(addOps(bridge).some((op) => 'catalogItemId' in op)).toBe(false);
  });

  test('Enter without new input still picks a result reached with the arrows', async () => {
    const bridge = installWithSearch();
    render(<CashierWorkspace />);
    const user = userEvent.setup();
    const search = await screen.findByRole('combobox', { name: 'Cari barang' });
    await user.click(search);
    await user.keyboard('servis');
    await screen.findByRole('option', { name: /Jasa Servis Ringan/ });
    await user.keyboard('{ArrowDown}{Enter}');
    expect(addOps(bridge)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Tambahkan' }));
    await waitFor(() => expect(addOps(bridge)).toHaveLength(1));
    expect(addOps(bridge)[0]).toEqual({
      kind: 'addCatalogLine',
      catalogItemId: SERVICE.id,
      quantity: 1,
    });
  });
});

describe('money helpers', () => {
  test('formats and parses Rupiah strings without Number', () => {
    expect(formatIdr('130000')).toBe('Rp 130.000');
    expect(formatIdr('0')).toBe('Rp 0');
    expect(formatIdr('-5000')).toBe('-Rp 5.000');
    expect(formatIdr('9223372036854775807')).toBe(
      'Rp 9.223.372.036.854.775.807',
    );
    expect(parseRupiahInput('65000')).toBe('65000');
    expect(parseRupiahInput('65.000')).toBe('65000');
    expect(parseRupiahInput('Rp 1.250.000')).toBe('1250000');
    expect(parseRupiahInput('007')).toBe('7');
    expect(parseRupiahInput('6.5')).toBeNull();
    expect(parseRupiahInput('-1')).toBeNull();
    expect(parseRupiahInput('1e5')).toBeNull();
    expect(parseRupiahInput('')).toBeNull();
  });

  test('cash change is UI arithmetic against planned cash, else the total', () => {
    const cash = {
      sequence: 1,
      method: 'CASH' as const,
      amount: '90000',
      reference: null,
      note: null,
    };
    expect(cashChange('100000', '90000', [cash])).toBe('10000');
    expect(cashChange('50000', '90000', [])).toBe('-40000');
    expect(
      cashChange('50000', '90000', [
        { ...cash, method: 'QRIS', amount: '40000' },
        { ...cash, sequence: 2, amount: '50000' },
      ]),
    ).toBe('0');
  });
});

test('optional sales and expedition pickers show codes and queue header changes', async () => {
  const bridge = install();
  const master = {
    entity: 'sales' as const,
    id: '11111111-1111-4111-8111-111111111111',
    code: '001',
    label: 'Sales name',
    phoneNumber: null,
    brandId: null,
    address: null,
    city: null,
    isActive: true,
  };
  bridge.references.listActive.mockImplementation(async ({ entity }) =>
    ok(entity === 'sales' ? [master] : []),
  );
  // Keep the pricing channel provided by the normal fixture.
  const normal = workspaceBridge();
  bridge.references.listActive.mockImplementation(async ({ entity }) =>
    entity === 'sales'
      ? ok([master])
      : normal.references.listActive({ entity }),
  );
  render(<CashierWorkspace />);
  const sales = await screen.findByRole('combobox', { name: 'Sales' });
  expect(sales).toHaveValue('');
  expect(screen.getByRole('combobox', { name: 'Ekspedisi' })).toHaveValue('');
  expect(
    screen.getByRole('option', { name: '001 · Sales name' }),
  ).toBeInTheDocument();
  await userEvent.setup().selectOptions(sales, master.id);
  await waitFor(() =>
    expect(bridge.drafts.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        op: { kind: 'updateHeader', changes: { salesId: master.id } },
      }),
    ),
  );
});

test('refreshes imported master options when returning to the mounted workspace', async () => {
  const bridge = install();
  const { rerender } = render(<CashierWorkspace active={false} />);
  await screen.findByRole('combobox', { name: 'Cari barang' });
  const normal = workspaceBridge();
  bridge.references.listActive.mockImplementation(async ({ entity }) =>
    entity === 'sales'
      ? ok([
          {
            entity: 'sales',
            id: 'new',
            code: '001',
            label: 'Imported Sales',
            address: null,
            city: null,
            phoneNumber: null,
            brandId: null,
            isActive: true,
          },
        ])
      : normal.references.listActive({ entity }),
  );
  rerender(<CashierWorkspace active />);
  expect(
    await screen.findByRole('option', { name: '001 · Imported Sales' }),
  ).toBeInTheDocument();
});

test('retains an inactive selection as a visible fallback and allows clearing', async () => {
  const bridge = install();
  bridge.drafts.create.mockResolvedValue(
    ok(draftView({ sales: { id: 'inactive-sales', name: 'Inactive Sales' } })),
  );
  render(<CashierWorkspace />);
  const sales = await screen.findByRole('combobox', { name: 'Sales' });
  expect(sales).toHaveValue('inactive-sales');
  expect(
    screen.getByRole('option', { name: 'Inactive Sales' }),
  ).toBeInTheDocument();
  await userEvent.setup().selectOptions(sales, '');
  await waitFor(() =>
    expect(bridge.drafts.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        op: { kind: 'updateHeader', changes: { salesId: null } },
      }),
    ),
  );
});

test.each(['sales', 'expedition'] as const)(
  'refreshes a renamed inactive %s selection when returning to a draft',
  async (entity) => {
    const bridge = install();
    bridge.drafts.create.mockResolvedValue(
      ok(
        draftView({ [entity]: { id: 'inactive-reference', name: 'Old name' } }),
      ),
    );
    const { rerender } = render(<CashierWorkspace active />);
    expect(
      await screen.findByRole('option', { name: 'Old name' }),
    ).toBeInTheDocument();
    rerender(<CashierWorkspace active={false} />);
    bridge.drafts.get.mockResolvedValue(
      ok(
        draftView({ [entity]: { id: 'inactive-reference', name: 'New name' } }),
      ),
    );
    rerender(<CashierWorkspace active />);
    expect(
      await screen.findByRole('option', { name: 'New name' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: 'Old name' }),
    ).not.toBeInTheDocument();
  },
);
