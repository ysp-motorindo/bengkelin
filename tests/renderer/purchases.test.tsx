import { render, screen, within, waitFor } from '@testing-library/react';
import { test, expect, vi } from 'vitest';
import { Shell } from '@/renderer/features/shell/Shell';
import { PurchasesScreen } from '@/renderer/features/purchases/PurchasesScreen';
import { workspaceBridge } from './helpers/workspace-bridge';
import type {
  PurchaseDraftView,
  PurchaseDraftCommand,
  CashierSession,
} from '@/shared/contracts';
const supplier = {
  version: 1,
  id: 's',
  name: 'Supplier A',
  phoneNumber: null,
  email: null,
  address: null,
  isActive: true,
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
};
const draft: PurchaseDraftView = {
  id: 'p',
  version: 1,
  status: 'DRAFT',
  supplier,
  supplierBillReference: null,
  billDate: '2026-09-30',
  topDays: 0,
  dueDate: '2026-09-30',
  note: null,
  vatRateBps: 0,
  discountStages: [],
  lines: [
    {
      id: 'l',
      catalogItemId: 'item',
      type: 'STOCK_ITEM',
      title: 'Oil',
      itemCode: null,
      unitLabel: 'Bottle',
      trackInventory: true,
      quantity: 1,
      unitPrice: null,
      discountStages: [],
      amount: null,
      taxSubtotal: null,
      vatAmount: null,
      receivedQuantity: 0,
      creditedQuantity: 0,
      remainingQuantity: 1,
    },
  ],
  payments: [],
  totals: null,
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
  discardedAt: null,
};
const ok = <T,>(value: T) => ({ ok: true as const, value });
function bridge() {
  return {
    ...workspaceBridge(),
    suppliers: { search: vi.fn(async () => ok({ results: [supplier] })) },
    purchaseDrafts: {
      list: vi.fn(async () => ok([draft])),
      get: vi.fn(async () => ok(draft)),
      apply: vi.fn(async (_command: PurchaseDraftCommand) => ok(draft)),
    },
  };
}
for (const role of ['ADMIN', 'CASHIER'] as const)
  test(`purchase follows sales for ${role}`, async () => {
    (window as unknown as { bengkelin: unknown }).bengkelin = bridge();
    const session: CashierSession = {
      cashierId: 'actor',
      username: 'cashier',
      displayName: 'Cashier',
      role,
      language: 'id',
      appearance: 'LIGHT',
      numberFormat: 'ID',
    };
    render(<Shell session={session} shopName="Shop" onLoggedOut={() => {}} />);
    const buttons = within(
      screen.getByRole('navigation', { name: 'Navigasi utama' }),
    ).getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('Penjualan');
    expect(buttons[1]).toHaveTextContent('Pembelian');
  });
test('purchase price starts blank and an incomplete bill cannot be reviewed', async () => {
  (window as unknown as { bengkelin: unknown }).bengkelin = bridge();
  render(<PurchasesScreen active={true} />);
  const input = await screen.findByRole('textbox', { name: /Harga beli.*Oil/ });
  expect(input).toHaveValue('');
  expect(
    screen.getByRole('button', { name: 'Tinjau pembelian' }),
  ).toBeDisabled();
  expect(
    screen.getByText('Lengkapi harga beli untuk menghitung total.'),
  ).toBeVisible();
});

test('explicit zero requires warning acknowledgment before posting the purchase', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const b = bridge();
  let saved = structuredClone(draft);
  b.purchaseDrafts.apply = vi.fn(async (command: PurchaseDraftCommand) => {
    saved = {
      ...saved,
      version: saved.version + 1,
      lines: saved.lines.map((l) => ({
        ...l,
        unitPrice:
          command.op.kind === 'updateLine'
            ? (command.op.changes.unitPrice ?? null)
            : l.unitPrice,
        amount: '0',
        taxSubtotal: '0',
        vatAmount: '0',
      })),
      totals: {
        itemDiscountAmount: '0',
        billDiscountAmount: '0',
        subtotal: '0',
        discountAmount: '0',
        amount: '0',
        taxSubtotal: '0',
        vatAmount: '0',
      },
    };
    return ok(saved);
  });
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    ...b,
    purchases: {
      previewFinalize: async () =>
        ok({
          purchaseId: 'p',
          version: 2,
          totals: {
            itemDiscountAmount: '0',
            billDiscountAmount: '0',
            subtotal: '0',
            discountAmount: '0',
            amount: '0',
            taxSubtotal: '0',
            vatAmount: '0',
          },
          errors: [],
          warnings: [
            { code: 'ZERO_UNIT_PRICE', params: { lineId: 'l', title: 'Oil' } },
          ],
        }),
    },
  };
  render(<PurchasesScreen active={true} />);
  const user = userEvent.setup();
  const price = await screen.findByRole('textbox', { name: /Harga beli.*Oil/ });
  await user.type(price, '0');
  await user.tab();
  const review = await screen.findByRole('button', {
    name: 'Tinjau pembelian',
  });
  const { waitFor } = await import('@testing-library/react');
  await waitFor(() => expect(review).toBeEnabled());
  await user.click(review);
  const confirm = await screen.findByRole('button', {
    name: 'Catat faktur pemasok',
  });
  expect(confirm).toBeDisabled();
  await user.click(
    screen.getByRole('checkbox', {
      name: 'Saya telah meninjau dan menyetujui peringatan ini',
    }),
  );
  expect(confirm).toBeEnabled();
});

test('an unrelated unsaved sales field does not block creating a purchase', async () => {
  const { registerFlusher } = await import('@/renderer/lib/flush-registry');
  const { default: userEvent } = await import('@testing-library/user-event');
  const { waitFor } = await import('@testing-library/react');
  const unregister = registerFlusher(async () => false);
  const create = vi.fn(async () => ok(draft));
  const b = bridge();
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    ...b,
    purchaseDrafts: { ...b.purchaseDrafts, list: async () => ok([]), create },
  };
  try {
    render(<PurchasesScreen active={true} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Pembelian baru' }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  } finally {
    unregister();
  }
});

test('the draft switcher shows the supplier selected on the current draft', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const { waitFor } = await import('@testing-library/react');
  let latest = { ...draft, supplier: null as typeof draft.supplier };
  const b = bridge();
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    ...b,
    purchaseDrafts: {
      ...b.purchaseDrafts,
      list: async () => ok([latest]),
      apply: async () => {
        latest = { ...draft, version: 2 };
        return ok(latest);
      },
    },
  };
  render(<PurchasesScreen active={true} />);
  const picker = await screen.findByRole('combobox', {
    name: 'Pemasok',
  });
  await userEvent.click(picker);
  await userEvent.click(
    await screen.findByRole('option', { name: 'Supplier A' }),
  );
  await waitFor(() => expect(picker).toHaveValue('Supplier A'));
  await userEvent.click(screen.getByRole('button', { name: 'Draf tersimpan' }));
  expect(
    await screen.findByRole('dialog', { name: 'Draf tersimpan' }),
  ).toHaveTextContent('Supplier A');
});

test('the custom-item shortcut from purchase history opens the purchase editor dialog', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const { getWorkspaceActions } =
    await import('@/renderer/features/workspace/workspace-actions');
  const { act } = await import('@testing-library/react');
  const b = bridge();
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    ...b,
    purchases: {
      search: async () =>
        ok({
          items: [],
          page: 1,
          hasMore: false,
          payableAmount: '0',
          refundDue: '0',
        }),
    },
  };
  render(<PurchasesScreen active={true} />);
  await screen.findByRole('textbox', { name: /Harga beli.*Oil/ });
  await userEvent.click(
    screen.getByRole('button', { name: 'Riwayat Pembelian' }),
  );
  await act(async () => {
    getWorkspaceActions()?.addCustomItem();
  });
  expect(
    await screen.findByRole('dialog', { name: 'Item khusus' }),
  ).toBeVisible();
});

test('returning to Purchase refreshes added and deactivated receiving locations', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const { waitFor } = await import('@testing-library/react');
  const b = bridge();
  const a = {
    id: 'A',
    entity: 'stockLocation',
    code: 'A',
    label: 'Warehouse A',
    isActive: true,
    isDefault: true,
    phoneNumber: null,
    brandId: null,
    address: null,
    city: null,
  };
  const other = { ...a, id: 'B', code: 'B', label: 'Warehouse B' };
  let activeLocations = [a];
  const bill: import('@/shared/contracts').PurchaseView = {
    ...draft,
    status: 'FINALIZED',
    lines: draft.lines.map((l) => ({
      ...l,
      unitPrice: '10000',
      amount: '10000',
      taxSubtotal: '10000',
      vatAmount: '0',
    })),
    totals: {
      itemDiscountAmount: '0',
      billDiscountAmount: '0',
      subtotal: '10000',
      discountAmount: '0',
      amount: '10000',
      taxSubtotal: '10000',
      vatAmount: '0',
    },
    documentNumber: 'PUR-20260930-0001',
    finalizedAt: draft.createdAt,
    shop: { name: 'Shop', address: null, phoneNumber: null },
    outgoingPayments: [],
    refunds: [],
    receipts: [],
    credits: [],
    creditedAmount: '0',
    netAmount: '10000',
    paidAmount: '0',
    refundedAmount: '0',
    outstandingAmount: '10000',
    refundDue: '0',
    settlementStatus: 'UNPAID',
    receivingStatus: 'NOT_RECEIVED',
    void: null,
  };
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    ...b,
    references: {
      ...b.references,
      listActive: async (input: { entity: string }) =>
        input.entity === 'stockLocation'
          ? ok(activeLocations)
          : b.references.listActive(input),
    },
    purchases: {
      search: async () =>
        ok({
          items: [bill],
          page: 1,
          hasMore: false,
          payableAmount: '10000',
          refundDue: '0',
        }),
    },
  };
  const rendered = render(<PurchasesScreen active={true} />);
  await screen.findByRole('textbox', { name: /Harga beli.*Oil/ });
  rendered.rerender(<PurchasesScreen active={false} />);
  activeLocations = [other];
  rendered.rerender(<PurchasesScreen active={true} />);
  await userEvent.click(
    screen.getByRole('button', { name: 'Riwayat Pembelian' }),
  );
  await userEvent.click(
    await screen.findByRole('button', { name: bill.documentNumber }),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Catat penerimaan barang / jasa' }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('option', { name: 'Warehouse B' }),
    ).toBeInTheDocument(),
  );
  expect(
    screen.queryByRole('option', { name: 'Warehouse A' }),
  ).not.toBeInTheDocument();
});

test('supplier conflict keeps edits until the user chooses to load saved details', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const { SupplierForm } =
    await import('@/renderer/features/purchases/Suppliers');
  const save = vi.fn(async () => ({
    ok: false as const,
    error: {
      code: 'SUPPLIER_VERSION_CONFLICT',
      messageKey: 'errors.SUPPLIER_VERSION_CONFLICT',
    },
  }));
  const saved = {
    ...supplier,
    version: 2,
    name: 'Latest supplier',
    isActive: false,
  };
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    ...bridge(),
    suppliers: { save, get: async () => ok(saved) },
  };
  render(
    <SupplierForm initial={supplier} onSaved={vi.fn()} onClose={vi.fn()} />,
  );
  const name = screen.getByRole('textbox', { name: 'Nama' });
  await userEvent.clear(name);
  await userEvent.type(name, 'My unsaved name');
  await userEvent.click(screen.getByRole('button', { name: 'Simpan' }));
  expect(
    await screen.findByText(/Pemasok berubah saat Anda mengedit/),
  ).toBeVisible();
  expect(name).toHaveValue('My unsaved name');
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedVersion: 1, name: 'My unsaved name' }),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Muat data terbaru (ganti isian)' }),
  );
  expect(name).toHaveValue('Latest supplier');
  expect(screen.getByRole('checkbox', { name: 'Aktif' })).not.toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'Simpan' }));
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedVersion: 2, isActive: false }),
  );
});

test('Purchase portals its navigation only while active and returns to its existing editor', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const b = bridge();
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    ...b,
    purchases: {
      search: async () =>
        ok({
          items: [],
          page: 1,
          hasMore: false,
          payableAmount: '0',
          refundDue: '0',
        }),
    },
  };
  const slot = document.createElement('div');
  document.body.append(slot);
  const rendered = render(
    <PurchasesScreen active={true} navigationSlot={slot} />,
  );
  await screen.findByRole('textbox', { name: /Harga beli.*Oil/ });
  expect(within(slot).getAllByRole('button')).toHaveLength(5);
  await userEvent.click(
    within(slot).getByRole('button', { name: 'Riwayat Pembelian' }),
  );
  expect(
    within(slot).getByRole('button', { name: 'Riwayat Pembelian' }),
  ).toHaveAttribute('aria-current', 'page');
  rendered.rerender(<PurchasesScreen active={false} navigationSlot={slot} />);
  expect(slot).toBeEmptyDOMElement();
  rendered.rerender(<PurchasesScreen active={true} navigationSlot={slot} />);
  expect(
    await within(slot).findByRole('button', { name: 'Buat Pembelian' }),
  ).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('textbox', { name: /Harga beli.*Oil/ })).toHaveValue(
    '',
  );
  rendered.unmount();
  slot.remove();
});

test('failed Purchase saves retain the entered price across area changes', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const b = bridge();
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    ...b,
    purchaseDrafts: {
      ...b.purchaseDrafts,
      apply: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'INTERNAL_ERROR', messageKey: 'errors.INTERNAL_ERROR' },
      })),
    },
  };
  const rendered = render(<PurchasesScreen active={true} />);
  const price = await screen.findByRole('textbox', { name: /Harga beli.*Oil/ });
  await userEvent.type(price, '12500');
  await userEvent.tab();
  rendered.rerender(<PurchasesScreen active={false} />);
  rendered.rerender(<PurchasesScreen active={true} />);
  expect(price).toHaveValue('12.500');
  await waitFor(() =>
    expect(screen.getByTestId('save-state')).toHaveAttribute(
      'data-state',
      'failed',
    ),
  );
  expect(price).toHaveValue('12.500');
  expect(price).toBeVisible();
});

test('purchase payments keep invalid rows open and persist corrected entries on Apply', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const b = bridge();
  let saved = structuredClone(draft);
  b.purchaseDrafts.apply = vi.fn(async (command: PurchaseDraftCommand) => {
    if (command.op.kind === 'setPayments')
      saved = {
        ...saved,
        version: saved.version + 1,
        payments: command.op.payments,
      };
    return ok(saved);
  });
  (window as unknown as { bengkelin: unknown }).bengkelin = b;
  render(<PurchasesScreen active />);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Pembayaran keluar' }),
  );
  const dialog = screen.getByRole('dialog', { name: 'Pembayaran keluar' });
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Terapkan' }),
  );
  expect(dialog).toBeVisible();
  await userEvent.type(within(dialog).getByLabelText('Jumlah dana'), '25000');
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Terapkan' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole('button', { name: 'Pembayaran keluar' }),
  ).toHaveTextContent('25.000');
  await userEvent.click(
    screen.getByRole('button', { name: 'Pembayaran keluar' }),
  );
  expect(
    within(screen.getByRole('dialog')).getByLabelText('Jumlah dana'),
  ).toHaveValue('25.000');
});

test('purchase payment failure preserves amount and can retry before closing', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const b = bridge();
  let failed = true;
  let saved = structuredClone(draft);
  b.purchaseDrafts.apply = vi.fn(async (command: PurchaseDraftCommand) => {
    if (failed) throw new Error('connection failed');
    if (command.op.kind === 'setPayments')
      saved = {
        ...saved,
        version: saved.version + 1,
        payments: command.op.payments,
      };
    return ok(saved);
  });
  (window as unknown as { bengkelin: unknown }).bengkelin = b;
  render(<PurchasesScreen active />);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Pembayaran keluar' }),
  );
  const dialog = screen.getByRole('dialog', { name: 'Pembayaran keluar' });
  await userEvent.type(within(dialog).getByLabelText('Jumlah dana'), '10000');
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Terapkan' }),
  );
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'Coba simpan lagi' }),
    ).toBeVisible(),
  );
  expect(within(dialog).getByLabelText('Jumlah dana')).toHaveValue('10.000');
  failed = false;
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Coba simpan lagi' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
});

test('purchase toolbar replaces sale controls and leaves history normally scrollable', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const b = bridge();
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    ...b,
    purchases: {
      search: async () =>
        ok({
          items: [],
          page: 1,
          hasMore: false,
          payableAmount: '0',
          refundDue: '0',
        }),
    },
  };
  const session: CashierSession = {
    cashierId: 'actor',
    username: 'cashier',
    displayName: 'Cashier',
    role: 'CASHIER',
    language: 'id',
    appearance: 'LIGHT',
    numberFormat: 'ID',
  };
  render(<Shell session={session} shopName="Shop" onLoggedOut={() => {}} />);
  await screen.findByRole('button', { name: 'Buat Baru' });
  await userEvent.click(
    within(
      screen.getByRole('navigation', { name: 'Navigasi utama' }),
    ).getByRole('button', { name: 'Pembelian' }),
  );
  await screen.findByRole('textbox', { name: /Harga beli.*Oil/ });
  const header = screen
    .getByText('Cashier', { exact: true })
    .closest('header')!;
  expect(
    within(header).getByRole('button', { name: 'Pembelian baru' }),
  ).toBeVisible();
  expect(
    within(header).queryByRole('button', { name: 'Buat Baru' }),
  ).not.toBeInTheDocument();
  expect(
    within(header).getByRole('button', { name: 'Draf tersimpan' }),
  ).toBeVisible();
  await userEvent.click(
    screen.getByRole('button', { name: 'Riwayat Pembelian' }),
  );
  expect(
    within(header).queryByRole('button', { name: 'Pembelian baru' }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    within(
      screen.getByRole('navigation', { name: 'Navigasi utama' }),
    ).getByRole('button', { name: 'Penjualan' }),
  );
  expect(
    within(header).getByRole('button', { name: 'Buat Baru' }),
  ).toBeVisible();
  expect(
    within(header).queryByRole('button', { name: 'Pembelian baru' }),
  ).not.toBeInTheDocument();
});

test('purchase notes support multiline text and preserve it after saving', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const b = bridge();
  let saved = structuredClone(draft);
  b.purchaseDrafts.apply = vi.fn(async (command: PurchaseDraftCommand) => {
    if (command.op.kind === 'updateHeader')
      saved = { ...saved, ...command.op.changes, version: saved.version + 1 };
    return ok(saved);
  });
  (window as unknown as { bengkelin: unknown }).bengkelin = b;
  render(<PurchasesScreen active />);
  const note = await screen.findByRole('textbox', { name: 'Catatan' });
  expect(note.tagName).toBe('TEXTAREA');
  await userEvent.type(note, 'First line{Enter}Second line');
  await userEvent.tab();
  await waitFor(() => expect(saved.note).toBe('First line\nSecond line'));
  expect(note).toHaveValue('First line\nSecond line');
});

test('purchase table exposes twelve independently resizable columns', async () => {
  Object.assign(window, { bengkelin: bridge() });
  render(<PurchasesScreen active={true} />);
  await screen.findByRole('textbox', { name: /Harga beli.*Oil/ });
  const table = screen.getByRole('table', { name: 'Barang / jasa' });
  expect(within(table).getAllByRole('columnheader')).toHaveLength(12);
  expect(within(table).getAllByRole('separator')).toHaveLength(12);
});

test('Escape cancels an unsent purchase quantity edit', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const b = bridge();
  Object.assign(window, { bengkelin: b });
  render(<PurchasesScreen active={true} />);
  const quantity = await screen.findByRole('textbox', { name: /Jumlah.*Oil/ });
  await userEvent.clear(quantity);
  await userEvent.type(quantity, '7');
  await userEvent.keyboard('{Escape}');
  expect(quantity).toHaveValue('1');
  expect(b.purchaseDrafts.apply).not.toHaveBeenCalled();
});

test('supplier search supports keyboard selection and opens saved drafts as a dialog', async () => {
  const { default: user } = await import('@testing-library/user-event');
  const b = bridge();
  const next = { ...supplier, id: 'second', name: 'Supplier B' };
  b.suppliers.search.mockResolvedValue(ok({ results: [next] }));
  b.purchaseDrafts.apply.mockResolvedValue(
    ok({ ...draft, supplier: next, version: 2 }),
  );
  Object.assign(window, { bengkelin: b });
  render(<PurchasesScreen active={true} />);
  const picker = await screen.findByRole('combobox', {
    name: 'Pemasok',
  });
  await user.click(picker);
  await user.type(picker, 'Supplier B');
  await screen.findByRole('option', { name: /Supplier B/ });
  await user.keyboard('{ArrowDown}{Enter}');
  await waitFor(() => expect(picker).toHaveValue('Supplier B'));
  await user.click(screen.getByRole('button', { name: 'Draf tersimpan' }));
  expect(
    await screen.findByRole('dialog', { name: 'Draf tersimpan' }),
  ).toBeVisible();
});

test('opening Purchase with no drafts creates one using the shop date', async () => {
  const b = bridge();
  const create = vi.fn(async () => ok(draft));
  Object.assign(window, {
    bengkelin: {
      ...b,
      purchaseDrafts: { ...b.purchaseDrafts, list: async () => ok([]), create },
    },
  });
  render(<PurchasesScreen active />);
  await screen.findByRole('textbox', { name: /Harga beli.*Oil/ });
  expect(create).toHaveBeenCalledTimes(1);
});

test('supplier search failure retains its query and supports retry', async () => {
  const { default: user } = await import('@testing-library/user-event');
  const { SupplierPicker } =
    await import('@/renderer/features/purchases/SupplierPicker');
  const b = bridge();
  b.suppliers.search.mockRejectedValue(new Error('offline'));
  Object.assign(window, { bengkelin: b });
  render(
    <SupplierPicker
      supplier={null}
      disabled={false}
      onSelect={async () => true}
      onAdd={() => {}}
    />,
  );
  const picker = screen.getByRole('combobox', { name: 'Pemasok' });
  await user.type(picker, 'Supplier A');
  const retry = await screen.findByRole('button', { name: 'Coba lagi' });
  b.suppliers.search.mockResolvedValue(ok({ results: [supplier] }));
  await user.click(retry);
  expect(picker).toHaveValue('Supplier A');
  expect(
    await screen.findByRole('option', { name: 'Supplier A' }),
  ).toBeVisible();
});

test('purchase bill has one Disc percentage and writes one stage', async () => {
  const { default: user } = await import('@testing-library/user-event');
  const b = bridge();
  Object.assign(window, { bengkelin: b });
  render(<PurchasesScreen active />);
  const disc = await screen.findByRole('textbox', { name: 'Disc' });
  await user.type(disc, '2,5');
  await waitFor(() =>
    expect(b.purchaseDrafts.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        op: { kind: 'setDiscounts', lineId: null, stages: [250] },
      }),
    ),
  );
});

test('purchase payment Cancel discards unapplied amount', async () => {
  const { default: user } = await import('@testing-library/user-event');
  const b = bridge();
  Object.assign(window, { bengkelin: b });
  render(<PurchasesScreen active />);
  await user.click(
    await screen.findByRole('button', { name: 'Pembayaran keluar' }),
  );
  const dialog = screen.getByRole('dialog');
  await user.type(within(dialog).getByLabelText('Jumlah dana'), '25000');
  await user.click(within(dialog).getByRole('button', { name: 'Batal' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(b.purchaseDrafts.apply).not.toHaveBeenCalled();
});

test('legacy purchase bill discounts require explicit replacement', async () => {
  const { default: user } = await import('@testing-library/user-event');
  const b = bridge();
  const legacy = { ...draft, discountStages: [5000, 5000] };
  b.purchaseDrafts.list.mockResolvedValue(ok([legacy]));
  b.purchaseDrafts.apply.mockResolvedValue(
    ok({ ...legacy, version: 2, discountStages: [] }),
  );
  Object.assign(window, { bengkelin: b });
  render(<PurchasesScreen active />);
  const replace = await screen.findByRole('button', { name: 'Ganti diskon' });
  expect(
    screen.queryByRole('textbox', { name: 'Disc' }),
  ).not.toBeInTheDocument();
  expect(b.purchaseDrafts.apply).not.toHaveBeenCalled();
  await user.click(replace);
  expect(await screen.findByRole('textbox', { name: 'Disc' })).toBeVisible();
  expect(b.purchaseDrafts.apply).toHaveBeenCalledWith(
    expect.objectContaining({
      op: { kind: 'setDiscounts', lineId: null, stages: [] },
    }),
  );
});

function recordedPurchaseBridge() {
  const totals = {
    subtotal: '100000',
    discountAmount: '0',
    itemDiscountAmount: '0',
    billDiscountAmount: '0',
    amount: '100000',
    taxSubtotal: '100000',
    vatAmount: '0',
  };
  const ready = {
    ...draft,
    supplierBillReference: 'BILL-42',
    totals,
    lines: draft.lines.map((l) => ({
      ...l,
      unitPrice: '100000',
      amount: '100000',
      taxSubtotal: '100000',
      vatAmount: '0',
    })),
  };
  const recorded = {
    ...ready,
    status: 'FINALIZED' as const,
    documentNumber: 'PUR-20260930-1',
    finalizedAt: ready.updatedAt,
    shop: { name: 'Shop', address: null, phoneNumber: null },
    outgoingPayments: [],
    refunds: [],
    receipts: [],
    credits: [],
    creditedAmount: '0',
    netAmount: '100000',
    paidAmount: '0',
    refundedAmount: '0',
    outstandingAmount: '100000',
    refundDue: '0',
    settlementStatus: 'UNPAID' as const,
    receivingStatus: 'NOT_RECEIVED' as const,
    void: null,
  };
  const b = bridge();
  b.purchaseDrafts.list.mockResolvedValue(ok([ready]));
  const finalize = vi.fn(
    async (): Promise<import('@/shared/primitives').Result<typeof recorded>> =>
      ok(recorded),
  );
  const create = vi.fn(async () => ok({ ...draft, id: 'next' }));
  const print = vi.fn(async () =>
    ok({ outcome: 'PRINTED', format: 'A4', isReprint: false }),
  );
  return {
    finalize,
    create,
    print,
    b: {
      ...b,
      purchaseDrafts: { ...b.purchaseDrafts, create },
      purchases: {
        previewFinalize: vi.fn(async () =>
          ok({
            purchaseId: ready.id,
            version: ready.version,
            totals,
            errors: [],
            warnings: [],
          }),
        ),
        finalize,
      },
      printing: {
        getOptions: async () =>
          ok({
            defaultInvoiceFormat: 'A4',
            thermalFormat: 'THERMAL_58',
            autoPrintAfterFinalize: true,
          }),
      },
      purchasePrinting: { print },
    },
  };
}

test('recording keeps a result dialog and viewing the bill does not auto-print again', async () => {
  const { default: user } = await import('@testing-library/user-event');
  const fixture = recordedPurchaseBridge();
  Object.assign(window, { bengkelin: fixture.b });
  render(<PurchasesScreen active />);
  await user.click(
    await screen.findByRole('button', { name: 'Tinjau pembelian' }),
  );
  const review = screen.getByRole('dialog');
  expect(review).toHaveTextContent('BILL-42');
  await user.click(
    within(review).getByRole('button', { name: 'Catat faktur pemasok' }),
  );
  const result = await screen.findByRole('dialog', {
    name: 'Pembelian tercatat',
  });
  expect(result).toHaveTextContent('PUR-20260930-1');
  await waitFor(() => expect(fixture.print).toHaveBeenCalledTimes(1));
  await user.click(
    within(result).getByRole('button', { name: 'Lihat faktur' }),
  );
  expect(
    await screen.findByRole('heading', { name: 'PUR-20260930-1' }),
  ).toBeVisible();
  expect(fixture.print).toHaveBeenCalledTimes(1);
  expect(fixture.finalize).toHaveBeenCalledTimes(1);
});

test('failed next-purchase creation retains the recorded result for retry', async () => {
  const { default: user } = await import('@testing-library/user-event');
  const fixture = recordedPurchaseBridge();
  fixture.create.mockRejectedValueOnce(Error('offline'));
  Object.assign(window, { bengkelin: fixture.b });
  render(<PurchasesScreen active />);
  await user.click(
    await screen.findByRole('button', { name: 'Tinjau pembelian' }),
  );
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Catat faktur pemasok',
    }),
  );
  const result = await screen.findByRole('dialog', {
    name: 'Pembelian tercatat',
  });
  await user.click(
    within(result).getByRole('button', { name: 'Pembelian baru' }),
  );
  expect(result).toBeVisible();
  expect(await within(result).findByRole('alert')).toBeVisible();
  await user.click(
    within(result).getByRole('button', { name: 'Pembelian baru' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(fixture.finalize).toHaveBeenCalledTimes(1);
  expect(fixture.create).toHaveBeenCalledTimes(2);
});

test('failed conflict preview blocks recording until refreshed successfully', async () => {
  const { default: user } = await import('@testing-library/user-event');
  const fixture = recordedPurchaseBridge();
  fixture.finalize.mockResolvedValueOnce({
    ok: false,
    error: {
      code: 'DRAFT_VERSION_CONFLICT',
      messageKey: 'errors.DRAFT_VERSION_CONFLICT',
    },
  });
  Object.assign(window, { bengkelin: fixture.b });
  render(<PurchasesScreen active />);
  await user.click(
    await screen.findByRole('button', { name: 'Tinjau pembelian' }),
  );
  fixture.b.purchases.previewFinalize.mockRejectedValueOnce(Error('offline'));
  const dialog = screen.getByRole('dialog');
  await user.click(
    within(dialog).getByRole('button', { name: 'Catat faktur pemasok' }),
  );
  await within(dialog).findByRole('alert');
  expect(
    within(dialog).getByRole('button', { name: 'Catat faktur pemasok' }),
  ).toBeDisabled();
  await user.click(within(dialog).getByRole('button', { name: 'Coba lagi' }));
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'Catat faktur pemasok' }),
    ).toBeEnabled(),
  );
  expect(fixture.finalize).toHaveBeenCalledTimes(1);
});

test('pending purchase line removal disables repeated activation', async () => {
  const { default: user } = await import('@testing-library/user-event');
  const b = bridge();
  let release!: (r: ReturnType<typeof ok<PurchaseDraftView>>) => void;
  b.purchaseDrafts.apply.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  Object.assign(window, { bengkelin: b });
  render(<PurchasesScreen active />);
  const remove = await screen.findByRole('button', { name: 'Hapus Oil' });
  await user.click(remove);
  const disabled = remove.hasAttribute('disabled');
  release(ok({ ...draft, version: 2, lines: [] }));
  expect(disabled).toBe(true);
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Hapus Oil' }),
    ).not.toBeInTheDocument(),
  );
});

test('keyboard supplier creation returns focus to the picker on cancel', async () => {
  const { default: user } = await import('@testing-library/user-event');
  const b = bridge();
  b.purchaseDrafts.list.mockResolvedValue(ok([{ ...draft, supplier: null }]));
  Object.assign(window, { bengkelin: b });
  render(<PurchasesScreen active />);
  const picker = await screen.findByRole('combobox', { name: 'Pemasok' });
  await user.click(picker);
  await screen.findByRole('option', { name: 'Supplier A' });
  await user.tab();
  expect(screen.getByRole('button', { name: 'Tambah pemasok' })).toHaveFocus();
  await user.keyboard('{Enter}');
  const form = await screen.findByRole('dialog', { name: 'Tambah pemasok' });
  await user.click(within(form).getByRole('button', { name: 'Batal' }));
  await waitFor(() => expect(picker).toHaveFocus());
});
