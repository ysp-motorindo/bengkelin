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
