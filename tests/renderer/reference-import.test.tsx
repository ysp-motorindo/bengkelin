import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { ReferenceImportDialog } from '@/renderer/features/references/ReferenceImportDialog';
import { ok } from './helpers/workspace-bridge';
test('reviews counts and commits the chosen entity with its preview token', async () => {
  const previewImport = vi.fn(async () =>
    ok({
      outcome: 'READY',
      token: 'token',
      expiresAt: '2026-10-30',
      fileName: 'sales.csv',
      summary: { creates: 1, updates: 0, unchanged: 0 },
      totalRows: 1,
      rows: [
        {
          row: 2,
          code: '001',
          name: 'Alpha',
          action: 'CREATE',
          changedFields: [],
        },
      ],
      rowsTruncated: false,
      errors: [],
      warnings: [],
      errorCount: 0,
      warningCount: 0,
      canCommit: true,
    }),
  );
  const commitImport = vi.fn(async () =>
    ok({
      creates: 1,
      updates: 0,
      unchanged: 0,
      importedAt: 'now',
      fileName: 'sales.csv',
      backupFileName: 'safety.sqlite',
    }),
  );
  Object.assign(window, {
    bengkelin: { referenceTransfer: { previewImport, commitImport } },
  });
  const onImported = vi.fn();
  render(
    <ReferenceImportDialog
      entity="sales"
      onClose={() => {}}
      onImported={onImported}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Pilih CSV...' }));
  expect(previewImport).toHaveBeenCalledWith({ entity: 'sales' });
  expect(await screen.findByText('001')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Impor sekarang' }));
  await waitFor(() =>
    expect(commitImport).toHaveBeenCalledWith({ token: 'token' }),
  );
  expect(onImported).toHaveBeenCalledOnce();
});
