import { render, screen, within } from '@testing-library/react';
import { test, expect, vi } from 'vitest';
import { Shell } from '@/renderer/features/shell/Shell';
import { PurchasesScreen } from '@/renderer/features/purchases/PurchasesScreen';
import { workspaceBridge } from './helpers/workspace-bridge';
import type { PurchaseDraftView, CashierSession } from '@/shared/contracts';
const supplier = {
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
      apply: vi.fn(async () => ok(draft)),
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
    const buttons = within(screen.getByRole('navigation')).getAllByRole(
      'button',
    );
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
  b.purchaseDrafts.apply = vi.fn(async (command) => {
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
