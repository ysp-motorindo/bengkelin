import { render, screen, within } from '@testing-library/react';
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
  const empty = { ...draft, supplier: null };
  const b = bridge();
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    ...b,
    purchaseDrafts: {
      ...b.purchaseDrafts,
      list: async () => ok([empty]),
      apply: async () => ok({ ...draft, version: 2 }),
    },
  };
  render(<PurchasesScreen active={true} />);
  await screen.findByRole('option', { name: 'Supplier A' });
  await userEvent.selectOptions(
    await screen.findByLabelText('Pemasok', { exact: true }),
    's',
  );
  await waitFor(() =>
    expect(
      within(screen.getByLabelText('Draf tersimpan')).getByRole('option', {
        selected: true,
      }),
    ).toHaveTextContent('Supplier A'),
  );
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
    screen.getByRole('button', { name: 'Riwayat pembelian' }),
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
    screen.getByRole('button', { name: 'Riwayat pembelian' }),
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
    within(slot).getByRole('button', { name: 'Riwayat pembelian' }),
  );
  expect(
    within(slot).getByRole('button', { name: 'Riwayat pembelian' }),
  ).toHaveAttribute('aria-current', 'page');
  rendered.rerender(<PurchasesScreen active={false} navigationSlot={slot} />);
  expect(slot).toBeEmptyDOMElement();
  rendered.rerender(<PurchasesScreen active={true} navigationSlot={slot} />);
  expect(
    await within(slot).findByRole('button', { name: 'Buat pembelian' }),
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
  b.purchaseDrafts.apply = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'INTERNAL_ERROR', messageKey: 'errors.INTERNAL_ERROR' },
  })) as typeof b.purchaseDrafts.apply;
  (window as unknown as { bengkelin: unknown }).bengkelin = b;
  const rendered = render(<PurchasesScreen active={true} />);
  const price = await screen.findByRole('textbox', { name: /Harga beli.*Oil/ });
  await userEvent.type(price, '12500');
  await userEvent.tab();
  rendered.rerender(<PurchasesScreen active={false} />);
  rendered.rerender(<PurchasesScreen active={true} />);
  expect(price).not.toHaveValue('');
  expect(price).toBeVisible();
});
