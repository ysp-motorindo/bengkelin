import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { InvoiceDetail } from '@/renderer/features/history/InvoiceDetail';
import type { InvoiceView, PaymentDto } from '@/shared/contracts';

const ID = '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11';
const SITI = {
  id: '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d12',
  displayName: 'Siti',
};

function view(overrides: Partial<InvoiceView> = {}): InvoiceView {
  return {
    id: ID,
    invoiceNumber: 'INV-20260930-0001',
    taxInvoiceNumber: null,
    cashReceived: null,
    status: 'FINALIZED',
    version: 2,
    invoiceDate: '2026-09-30',
    pricingAt: '2026-09-30T03:00:00.000Z',
    topDays: 7,
    dueDate: '2026-10-07',
    finalizedAt: '2026-09-30T03:00:00.000Z',
    channel: { id: ID, label: 'Bengkel' },
    sales: null,
    expedition: null,
    customer: { id: ID, name: 'Andi', phoneNumber: '0812' },
    vehicle: { id: ID, plateNumber: 'B 1234 XYZ', description: 'Honda Beat' },
    odometerKm: 12000,
    note: null,
    cashier: SITI,
    createdBy: SITI,
    shop: {
      name: 'Bengkel Maju',
      address: 'Jl. A',
      phoneNumber: null,
      email: null,
      invoiceFooter: null,
      logo: null,
    },
    lines: [
      {
        id: ID,
        position: 1,
        catalogItemId: ID,
        adHocItemReferenceId: null,
        itemType: 'STOCK_ITEM',
        title: 'Oli MPX2',
        unitLabel: 'PCS',
        mechanicId: null,
        mechanicName: null,
        quantity: 1,
        listedUnitPrice: '100000',
        unitPrice: '100000',
        manualPriceOverride: false,
        subtotal: '100000',
        discountAmount: '0',
        amount: '100000',
        discounts: [],
      },
    ],
    invoiceDiscounts: [],
    totals: {
      subtotal: '100000',
      itemDiscountAmount: '0',
      invoiceDiscountAmount: '0',
      discountAmount: '0',
      amount: '100000',
    },
    payments: [],
    paidAmount: '0',
    outstandingAmount: '100000',
    paymentStatus: 'UNPAID',
    void: null,
    ...overrides,
  };
}

const payment: PaymentDto = {
  id: ID,
  method: 'CASH',
  amount: '40000',
  paidAt: '2026-09-30T04:00:00.000Z',
  reference: null,
  note: null,
  receivedBy: SITI,
  source: 'LATER',
};

function bridge(
  initial: InvoiceView,
  recordPayment = vi.fn(),
  voidInvoice = vi.fn(),
) {
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    invoices: {
      get: vi.fn(async () => ({ ok: true, value: initial })),
      recordPayment,
      void: voidInvoice,
    },
  };
}

describe('invoice detail', () => {
  beforeEach(() => vi.restoreAllMocks());

  test('shows calendar dates in DD/MM/YYYY and timestamps in shop time', async () => {
    bridge(view());
    render(
      <InvoiceDetail invoiceId={ID} timezone="Asia/Jakarta" onBack={vi.fn()} />,
    );
    const detail = await screen.findByTestId('invoice-detail');
    expect(within(detail).getByRole('heading', { level: 1 })).toHaveTextContent(
      'INV-20260930-0001',
    );
    expect(within(detail).getByText('30/09/2026')).toBeInTheDocument();
    expect(within(detail).getByText('07/10/2026')).toBeInTheDocument();
    expect(within(detail).getByText('30/09/2026 10:00')).toBeInTheDocument();
  });

  test('record payment defaults to the outstanding amount and reuses the requestId on retry', async () => {
    const ids: string[] = [];
    const recordPayment = vi.fn(
      async (input: { requestId: string; amount: string }) => {
        ids.push(input.requestId);
        if (ids.length === 1) throw new Error('ipc down');
        return {
          ok: true,
          value: view({
            payments: [{ ...payment, amount: input.amount }],
            paidAmount: input.amount,
            outstandingAmount: '60000',
            paymentStatus: 'PARTIALLY_PAID',
          }),
        };
      },
    );
    bridge(view(), recordPayment);
    render(
      <InvoiceDetail invoiceId={ID} timezone="Asia/Jakarta" onBack={vi.fn()} />,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Catat pembayaran' }),
    );
    const dialog = screen.getByRole('dialog');
    const amount = within(dialog).getByLabelText('Jumlah (Rp)');
    expect(amount).toHaveValue('100.000');
    await userEvent.clear(amount);
    await userEvent.type(amount, '40.000');
    const submit = within(dialog).getByRole('button', {
      name: 'Simpan pembayaran',
    });
    await userEvent.click(submit);
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    await userEvent.click(submit);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(recordPayment.mock.calls[1]![0]).toMatchObject({
      invoiceId: ID,
      method: 'CASH',
      amount: '40000',
    });
    expect(await screen.findByTestId('payment-status')).toHaveTextContent(
      'Dibayar sebagian',
    );
    expect(screen.getByTestId('payment-row')).toHaveTextContent('Siti');
  });

  test('an amount above the outstanding balance is refused before sending', async () => {
    const recordPayment = vi.fn();
    bridge(view(), recordPayment);
    render(
      <InvoiceDetail invoiceId={ID} timezone="Asia/Jakarta" onBack={vi.fn()} />,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Catat pembayaran' }),
    );
    const dialog = screen.getByRole('dialog');
    const amount = within(dialog).getByLabelText('Jumlah (Rp)');
    await userEvent.clear(amount);
    await userEvent.type(amount, '100001');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Simpan pembayaran' }),
    );
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(recordPayment).not.toHaveBeenCalled();
  });

  test('void is disabled with an explanation once any payment exists', async () => {
    bridge(
      view({
        payments: [payment],
        paidAmount: '40000',
        outstandingAmount: '60000',
        paymentStatus: 'PARTIALLY_PAID',
      }),
    );
    render(
      <InvoiceDetail invoiceId={ID} timezone="Asia/Jakarta" onBack={vi.fn()} />,
    );
    const voidButton = await screen.findByRole('button', {
      name: 'Batalkan (VOID)',
    });
    expect(voidButton).toBeDisabled();
    expect(voidButton).toHaveAccessibleDescription(
      'Faktur yang sudah menerima pembayaran tidak bisa dibatalkan.',
    );
    // Payment time is shown in the shop timezone (04:00Z = 11:00 WIB).
    expect(screen.getByTestId('payment-row')).toHaveTextContent(
      '30/09/2026 11:00',
    );
  });

  test('void needs a reason and a confirmation; the VOID marking shows reason, voider and time', async () => {
    const voidInvoice = vi.fn(async (input: { reason: string }) => ({
      ok: true,
      value: view({
        status: 'VOID',
        version: 3,
        void: {
          voidedAt: '2026-09-30T05:30:00.000Z',
          voidedBy: SITI,
          reason: input.reason,
        },
      }),
    }));
    bridge(view(), vi.fn(), voidInvoice);
    render(
      <InvoiceDetail invoiceId={ID} timezone="Asia/Jakarta" onBack={vi.fn()} />,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Batalkan (VOID)' }),
    );
    const dialog = screen.getByRole('alertdialog');
    const submit = within(dialog).getByRole('button', {
      name: 'Batalkan faktur',
    });
    expect(submit).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText('Alasan pembatalan'),
      '  Salah input ',
    );
    expect(submit).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(submit);
    expect(voidInvoice).toHaveBeenCalledWith({
      requestId: expect.any(String),
      invoiceId: ID,
      reason: 'Salah input',
    });
    const marking = await screen.findByTestId('void-marking');
    expect(marking).toHaveTextContent('Salah input');
    expect(marking).toHaveTextContent('Siti');
    expect(marking).toHaveTextContent('30/09/2026 12:30');
    expect(
      screen.getByRole('button', { name: 'Catat pembayaran' }),
    ).toBeDisabled();
  });
});
