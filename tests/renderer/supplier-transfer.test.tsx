import { render, screen } from '@testing-library/react';
import { test, expect, vi } from 'vitest';
import { SuppliersScreen } from '@/renderer/features/purchases/Suppliers';
test('only admins see supplier import', () => {
  window.bengkelin = {
    suppliers: {
      search: vi.fn().mockResolvedValue({ ok: true, value: { results: [] } }),
    },
  } as any;
  const view = render(<SuppliersScreen role="CASHIER" />);
  expect(
    screen.queryByRole('button', { name: 'Impor CSV pemasok' }),
  ).toBeNull();
  view.rerender(<SuppliersScreen role="ADMIN" />);
  expect(
    screen.getByRole('button', { name: 'Impor CSV pemasok' }),
  ).toBeVisible();
});
import { SupplierImportDialog } from '@/renderer/features/purchases/SupplierImportDialog';
import userEvent from '@testing-library/user-event';
test('preview labels suppliers and formats opening money', async () => {
  window.bengkelin = {
    supplierTransfer: {
      previewImport: async () => ({
        ok: true,
        value: {
          outcome: 'READY',
          token: 't',
          fileName: 's.csv',
          summary: {
            suppliers: { creates: 3, updates: 0, unchanged: 0 },
            openings: { creates: 3, unchanged: 0, skipped: 0 },
          },
          totalOpeningAmount: '1284002694',
          totalRows: 3,
          rows: [],
          errors: [],
          warnings: [],
          errorCount: 0,
          warningCount: 0,
          canCommit: true,
        },
      }),
    },
  } as any;
  render(<SupplierImportDialog onClose={vi.fn()} onImported={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Pilih CSV...' }));
  expect(await screen.findByText('Pemasok baru')).toBeVisible();
  expect(screen.getByText(/1\.284\.002\.694/)).toBeVisible();
});

import { within } from '@testing-library/react';
import type {
  SupplierImportReadyDto,
  SupplierImportRowDto,
} from '@/shared/contracts';

async function previewRow(
  openingBalance: string | null,
  openingAction: SupplierImportRowDto['openingAction'],
  code = 'SUPPLIER_IMPORT_OPENING',
) {
  const invalid = openingAction === 'INVALID';
  const preview: SupplierImportReadyDto = {
    outcome: 'READY',
    token: '11111111-1111-4111-8111-111111111111',
    expiresAt: '2026-11-09T04:00:00.000Z',
    fileName: 'supplier.csv',
    summary: {
      suppliers: { creates: 1, updates: 0, unchanged: 0 },
      openings: { creates: 0, unchanged: 0, skipped: 0 },
    },
    totalOpeningAmount: '0',
    totalRows: 1,
    rows: [
      {
        row: 2,
        externalId: 'SU-1',
        name: 'Alpha',
        action: invalid ? 'INVALID' : 'CREATE',
        openingAction,
        asOfDate: '2026-10-31',
        openingBalance,
        changedFields: [],
      },
    ],
    rowsTruncated: false,
    errors: invalid
      ? [
          {
            row: 2,
            column: 'opening_balance',
            externalId: 'SU-1',
            error: { code, messageKey: 'errors.' + code },
          },
        ]
      : [],
    errorCount: invalid ? 1 : 0,
    warnings: [],
    warningCount: 0,
    requiresDuplicatePhoneAcknowledgement: false,
    canCommit: !invalid,
  };
  window.bengkelin = {
    supplierTransfer: {
      previewImport: async () => ({ ok: true, value: preview }),
    },
  } as any;
  render(<SupplierImportDialog onClose={vi.fn()} onImported={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Pilih CSV...' }));
  const table = within(
    await screen.findByTestId('supplier-import-preview'),
  ).getByRole('table');
  return within(within(table).getAllByRole('row')[1]!).getAllByRole('cell')[4]!;
}

test.each(['1.5', 'abc', '1,000', '-1', '001', '9223372036854775808'])(
  'invalid opening %s stays readable with its validation error',
  async (amount) => {
    const cell = await previewRow(amount, 'INVALID');
    expect(cell.textContent).toBe(amount);
    expect(
      screen.getByText(/Tanggal\/jumlah saldo awal tidak valid/),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Impor sekarang' }),
    ).toBeDisabled();
  },
);
test('an early-rejected contact row does not format its unvalidated amount', async () => {
  expect(
    (await previewRow('abc', 'INVALID', 'SUPPLIER_IMPORT_INVALID_ROW'))
      .textContent,
  ).toBe('abc');
  expect(screen.getByRole('button', { name: 'Impor sekarang' })).toBeDisabled();
});
test.each(['CREATE', 'UNCHANGED'] as const)(
  '%s openings preserve zero and large integer precision',
  async (action) => {
    const cell = await previewRow('9007199254740993', action);
    expect(cell.textContent).toBe('Rp 9.007.199.254.740.993');
  },
);
test.each(['CREATE', 'UNCHANGED'] as const)(
  '%s zero opening displays rupiah',
  async (action) => {
    expect((await previewRow('0', action)).textContent).toBe('Rp 0');
  },
);
test('a skipped opening displays an em dash', async () => {
  expect((await previewRow(null, 'SKIPPED')).textContent).toBe('—');
});
