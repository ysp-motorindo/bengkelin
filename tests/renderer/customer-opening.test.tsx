import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { ReceivablesScreen } from '@/renderer/features/history/ReceivablesScreen';
import { CustomersScreen } from '@/renderer/features/customers/CustomersScreen';
import type {
  CustomerOpeningDetail,
  OpeningImportPreview,
} from '@/shared/contracts';
const ok = <T,>(value: T) => ({ ok: true as const, value });
const detail: CustomerOpeningDetail = {
  customerId: 'c1',
  externalId: 'CU-1',
  customerName: 'Alpha',
  asOfDate: '2026-09-30',
  originalAmount: '100000',
  paidAmount: '0',
  outstandingAmount: '100000',
  paymentStatus: 'UNPAID',
  payments: [],
};
const partiallyPaid: CustomerOpeningDetail = {
  ...detail,
  paidAmount: '30000',
  outstandingAmount: '70000',
  paymentStatus: 'PARTIALLY_PAID',
  payments: [
    {
      id: 'p1',
      method: 'CASH',
      amount: '30000',
      paidAt: '2026-10-01T03:00:00.000Z',
      receivedBy: { id: 'a', displayName: 'Admin' },
      reference: null,
      note: null,
    },
  ],
};
function install() {
  const b = {
    settings: { getShop: vi.fn(async () => ok({ timezone: 'Asia/Jakarta' })) },
    references: { listActive: vi.fn(async () => ok([])) },
    customers: { search: vi.fn(async () => ok({ results: [] })) },
    vehicles: { searchByPlate: vi.fn(async () => ok({ results: [] })) },
    invoices: {
      receivables: vi.fn(async () =>
        ok({
          kind: 'OUTSTANDING',
          items: [],
          total: 0,
          totalOutstanding: '0',
          today: '2026-10-01',
          pageNumber: 1,
          pageSize: 25,
          hasMore: false,
        }),
      ),
    },
    customerReceivables: {
      list: vi.fn(async () =>
        ok({
          items: [detail],
          total: 1,
          pageNumber: 1,
          pageSize: 25,
          hasMore: false,
          totalOriginal: '100000',
          totalPaid: '0',
          totalOutstanding: '100000',
        }),
      ),
      get: vi.fn(async () => ok(detail)),
      recordPayment: vi.fn(async (_input: unknown) => ok(partiallyPaid)),
      previewImport: vi.fn(async () =>
        ok<OpeningImportPreview>({
          outcome: 'READY',
          token: 'token',
          expiresAt: '2026-10-01T04:00:00.000Z',
          fileName: 'opening.csv',
          summary: { creates: 1, unchanged: 0 },
          totalAmount: '100000',
          totalRows: 1,
          rows: [],
          rowsTruncated: false,
          errors: [],
          errorCount: 0,
          canCommit: true,
        }),
      ),
      commitImport: vi.fn(async () =>
        ok({
          creates: 1,
          unchanged: 0,
          totalAmount: '100000',
          importedAt: '2026-10-01T03:00:00.000Z',
          fileName: 'opening.csv',
          backupFileName: 'backup.sqlite',
        }),
      ),
    },
  };
  (window as unknown as { bengkelin: unknown }).bengkelin = b;
  return b;
}
test('admin imports opening balances and cashier cannot see import', async () => {
  install();
  const { unmount } = render(<CustomersScreen role="CASHIER" />);
  expect(
    screen.queryByRole('button', { name: 'Impor saldo awal...' }),
  ).not.toBeInTheDocument();
  unmount();
  render(<CustomersScreen role="ADMIN" />);
  await userEvent.click(
    screen.getByRole('button', { name: 'Impor saldo awal...' }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Pilih CSV...' }));
  expect(await screen.findByText('Rp 100.000')).toBeInTheDocument();
  expect(screen.getByText(/Saldo baru: 1/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Impor sekarang' }));
  expect(await screen.findByText(/backup.sqlite/)).toBeInTheDocument();
});
test('blocked opening import disables commit and explains the error', async () => {
  const b = install();
  b.customerReceivables.previewImport.mockResolvedValueOnce(
    ok({
      outcome: 'READY',
      token: 't',
      expiresAt: 'x',
      fileName: 'bad.csv',
      summary: { creates: 0, unchanged: 0 },
      totalAmount: '0',
      totalRows: 1,
      rows: [],
      rowsTruncated: false,
      errors: [
        {
          row: 2,
          column: 'external_id',
          externalId: 'X',
          error: {
            code: 'OPENING_IMPORT_UNKNOWN_CUSTOMER',
            messageKey: 'errors.OPENING_IMPORT_UNKNOWN_CUSTOMER',
          },
        },
      ],
      errorCount: 1,
      canCommit: false,
    }),
  );
  render(<CustomersScreen role="ADMIN" />);
  await userEvent.click(
    screen.getByRole('button', { name: 'Impor saldo awal...' }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Pilih CSV...' }));
  expect(
    await screen.findByRole('button', { name: 'Impor sekarang' }),
  ).toBeDisabled();
});
test('opening tab supports payment retry, history and refreshed totals', async () => {
  const b = install();
  render(<ReceivablesScreen />);
  await userEvent.click(screen.getByRole('tab', { name: 'Saldo awal' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Alpha' }));
  await userEvent.click(
    screen.getByRole('button', { name: 'Catat pembayaran' }),
  );
  const amount = screen.getByLabelText('Jumlah (Rp)');
  await userEvent.clear(amount);
  await userEvent.type(amount, '30000');
  b.customerReceivables.recordPayment.mockRejectedValueOnce(
    Error('lost response'),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Simpan pembayaran' }),
  );
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  b.customerReceivables.get.mockResolvedValueOnce(ok(partiallyPaid));
  expect(screen.getByLabelText('Catatan (opsional)')).toBeDisabled();
  expect(
    screen.getAllByRole('button', { name: 'Batal' }).at(-1),
  ).toBeDisabled();
  await userEvent.type(screen.getByLabelText('Catatan (opsional)'), 'changed');
  await userEvent.keyboard('{Escape}');
  expect(screen.getByRole('dialog')).toBeInTheDocument();

  await userEvent.click(
    screen.getByRole('button', { name: 'Simpan pembayaran' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(b.customerReceivables.recordPayment.mock.calls[1]![0]).toEqual(
    b.customerReceivables.recordPayment.mock.calls[0]![0],
  );
  expect(screen.getByText('Rp 70.000')).toBeInTheDocument();
  expect(screen.getByText('Admin')).toBeInTheDocument();
});

test('keyboard tabs reach opening balances and full repayment locks duplicate submissions', async () => {
  const b = install();
  b.customerReceivables.recordPayment.mockImplementationOnce(async () => ({
    ...ok({
      ...detail,
      paidAmount: '100000',
      outstandingAmount: '0',
      paymentStatus: 'PAID' as const,
      payments: [],
    }),
  }));
  render(<ReceivablesScreen />);
  const first = screen.getByRole('tab', { name: 'Faktur belum lunas' });
  first.focus();
  await userEvent.keyboard('{ArrowLeft}');
  expect(screen.getByRole('tab', { name: 'Saldo awal' })).toHaveFocus();
  await userEvent.click(await screen.findByRole('button', { name: 'Alpha' }));
  b.customerReceivables.get.mockResolvedValueOnce(
    ok({
      ...detail,
      paidAmount: '100000',
      outstandingAmount: '0',
      paymentStatus: 'PAID',
    }),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Catat pembayaran' }),
  );
  await userEvent.dblClick(
    screen.getByRole('button', { name: 'Simpan pembayaran' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole('button', { name: 'Catat pembayaran' }),
  ).toBeDisabled();
  expect(b.customerReceivables.recordPayment).toHaveBeenCalledTimes(1);
});

test('payment recovery reloads current detail instead of showing its stored receipt snapshot', async () => {
  const b = install();
  render(<ReceivablesScreen />);
  await userEvent.click(screen.getByRole('tab', { name: 'Saldo awal' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Alpha' }));
  const current: CustomerOpeningDetail = {
    ...detail,
    paidAmount: '50000',
    outstandingAmount: '50000',
    paymentStatus: 'PARTIALLY_PAID',
    payments: [
      {
        id: 'p1',
        method: 'CASH',
        amount: '30000',
        paidAt: '2026-10-01T03:00:00.000Z',
        receivedBy: { id: 'a', displayName: 'Admin' },
        reference: null,
        note: null,
      },
      {
        id: 'p2',
        method: 'CASH',
        amount: '20000',
        paidAt: '2026-10-01T03:01:00.000Z',
        receivedBy: { id: 'b', displayName: 'Other cashier' },
        reference: null,
        note: null,
      },
    ],
  };
  b.customerReceivables.get.mockResolvedValueOnce(ok(current));
  b.customerReceivables.list.mockResolvedValue(
    ok({
      items: [current],
      total: 1,
      pageNumber: 1,
      pageSize: 25,
      hasMore: false,
      totalOriginal: '100000',
      totalPaid: '50000',
      totalOutstanding: '50000',
    }),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Catat pembayaran' }),
  );
  const amount = screen.getByLabelText('Jumlah (Rp)');
  await userEvent.clear(amount);
  await userEvent.type(amount, '30000');
  await userEvent.click(
    screen.getByRole('button', { name: 'Simpan pembayaran' }),
  );
  expect(await screen.findAllByText('Rp 50.000')).toHaveLength(2);
  expect(screen.getByText('Other cashier')).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole('button', { name: 'Kembali ke daftar' }),
  );
  expect(await screen.findByTestId('opening-total')).toHaveTextContent(
    'Rp 50.000',
  );
});
