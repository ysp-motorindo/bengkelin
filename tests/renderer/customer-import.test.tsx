import { NumberFormatProvider } from '@/renderer/lib/number-format';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { CustomersScreen } from '@/renderer/features/customers/CustomersScreen';
import type { CustomerImportReadyDto } from '@/shared/contracts';
const ok = <T,>(value: T) => ({ ok: true as const, value });
const preview: CustomerImportReadyDto = {
  outcome: 'READY',
  token: '11111111-1111-4111-8111-111111111111',
  expiresAt: '2026-10-17T10:00:00.000Z',
  fileName: 'customers.csv',
  summary: { creates: 2, updates: 0, unchanged: 0 },
  totalRows: 2,
  rows: [],
  rowsTruncated: false,
  errors: [],
  errorCount: 0,
  warnings: [
    {
      row: 2,
      column: 'phone_number',
      externalId: 'C1',
      error: { code: 'DUPLICATE_PHONE', messageKey: 'errors.DUPLICATE_PHONE' },
    },
  ],
  warningCount: 1,
  requiresDuplicatePhoneAcknowledgement: true,
  canCommit: true,
};
function install() {
  const b = {
    references: { listActive: vi.fn(async () => ok([])) },
    customerTransfer: {
      previewImport: vi.fn(async () => ok(preview)),
      commitImport: vi.fn(async () =>
        ok({
          ...preview.summary,
          importedAt: '2026-10-17T10:00:00.000Z',
          fileName: 'customers.csv',
          backupFileName: 'safe.sqlite',
        }),
      ),
    },
    customers: { search: vi.fn(async () => ok({ results: [] })) },
    vehicles: { searchByPlate: vi.fn(async () => ok({ results: [] })) },
  };
  (window as unknown as { bengkelin: unknown }).bengkelin = b;
  return b;
}
test('admin import requires duplicate acknowledgement and refreshes management', async () => {
  const b = install();
  render(<CustomersScreen role="ADMIN" />);
  await userEvent.click(screen.getByRole('button', { name: 'Impor CSV...' }));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Pilih CSV...' }),
  );
  const commit = await screen.findByRole('button', { name: 'Impor sekarang' });
  expect(commit).toBeDisabled();
  await userEvent.click(
    screen.getByRole('checkbox', {
      name: 'Saya memahami nomor telepon dipakai beberapa pelanggan',
    }),
  );
  await userEvent.click(commit);
  expect(await screen.findByTestId('customer-import-result')).toHaveTextContent(
    'safe.sqlite',
  );
  expect(b.customerTransfer.commitImport).toHaveBeenCalledWith({
    token: preview.token,
    acknowledgeDuplicatePhones: true,
  });
  await waitFor(() =>
    expect(b.customers.search).toHaveBeenCalledWith({
      query: '',
      includeInactive: true,
    }),
  );
});
test('cashier cannot see admin import', () => {
  install();
  render(<CustomersScreen role="CASHIER" />);
  expect(screen.queryByRole('button', { name: 'Impor CSV...' })).toBeNull();
});

test('invalid preview shows row errors and blocks commit', async () => {
  const b = install();
  b.customerTransfer.previewImport.mockResolvedValueOnce(
    ok({
      ...preview,
      canCommit: false,
      errorCount: 1,
      errors: [
        {
          row: 2,
          column: 'external_id',
          externalId: '',
          error: {
            code: 'CUSTOMER_IMPORT_INVALID_ROW',
            messageKey: 'errors.CUSTOMER_IMPORT_INVALID_ROW',
          },
        },
      ],
    }),
  );
  render(<CustomersScreen role="ADMIN" />);
  await userEvent.click(screen.getByRole('button', { name: 'Impor CSV...' }));
  await userEvent.click(screen.getByRole('button', { name: 'Pilih CSV...' }));
  expect(
    await screen.findByRole('button', { name: 'Impor sekarang' }),
  ).toBeDisabled();
  expect(screen.getByTestId('customer-import-preview')).toHaveTextContent(
    'Baris pelanggan tidak valid',
  );
  expect(b.customerTransfer.commitImport).not.toHaveBeenCalled();
});

test('customer summary counts follow the selected number format', async () => {
  const bridge = install();
  bridge.customerTransfer.previewImport.mockResolvedValueOnce(
    ok({
      ...preview,
      totalRows: 1234,
      summary: { ...preview.summary, creates: 1234 },
    }),
  );
  render(
    <NumberFormatProvider format="US">
      <CustomersScreen role="ADMIN" />
    </NumberFormatProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Impor CSV...' }));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Pilih CSV...' }),
  );
  expect(
    await screen.findByText('1,234', { selector: 'dd' }),
  ).toBeInTheDocument();
});
