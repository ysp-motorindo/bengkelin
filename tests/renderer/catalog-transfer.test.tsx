import { NumberFormatProvider } from '@/renderer/lib/number-format';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { CatalogTransferScreen } from '@/renderer/features/catalog-transfer/CatalogTransferScreen';
import type { ImportReadyDto, ImportSummaryDto } from '@/shared/contracts';
import { resources } from '@/renderer/i18n';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const TOKEN = '11111111-1111-4111-8111-111111111111';

function readyPreview(overrides: Partial<ImportReadyDto> = {}): ImportReadyDto {
  return {
    outcome: 'READY',
    token: TOKEN,
    expiresAt: '2026-09-30T03:30:00.000Z',
    fileName: 'katalog.csv',
    summary: {
      creates: 1,
      updates: 0,
      unchanged: 0,
      priceChanges: 1,
      openingBalances: 1,
      barcodeChanges: 0,
    },
    totalRows: 1,
    rows: [
      {
        row: 2,
        sku: 'OLI-01',
        title: 'Oli',
        action: 'CREATE',
        changedFields: [],
        priceChanges: [{ channelCode: 'BENGKEL', from: null, to: '65000' }],
        barcodesAdded: [],
        barcodesActivated: [],
        openingStock: 12,
        stockLocation: {
          id: '11111111-1111-4111-8111-111111111119',
          code: '01',
          label: 'Gudang',
        },
      },
    ],
    rowsTruncated: false,
    errors: [],
    errorCount: 0,
    warnings: [],
    warningCount: 0,
    canCommit: true,
    ...overrides,
  };
}

const SUMMARY: ImportSummaryDto = {
  creates: 1,
  updates: 0,
  unchanged: 0,
  priceChanges: 1,
  openingBalances: 1,
  barcodeChanges: 0,
  importedAt: '2026-09-30T03:00:00.000Z',
  fileName: 'katalog.csv',
  backupFileName: 'bengkelin-safety-20260930-100000.sqlite',
};

function install(preview: ImportReadyDto) {
  const bridge = {
    previewImport: vi.fn(async () => ok(preview)),
    commitImport: vi.fn(async () => ok(SUMMARY)),
    exportCatalog: vi.fn(async () =>
      ok({
        outcome: 'SAVED',
        fileName: 'katalog-20260930.csv',
        itemCount: 4,
        skuMissingCount: 2,
      }),
    ),
    downloadTemplate: vi.fn(async () => ok({ outcome: 'CANCELLED' })),
  };
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    references: {
      listActive: vi.fn(async () =>
        ok([
          {
            id: '11111111-1111-4111-8111-111111111119',
            code: '01',
            label: 'Gudang',
            isActive: true,
            isDefault: true,
          },
        ]),
      ),
    },
    catalogTransfer: bridge,
  };
  return bridge;
}

describe('Catalog import/export screen', () => {
  test('summary counts follow the selected number format', async () => {
    const preview = readyPreview();
    install({
      ...preview,
      totalRows: 1234,
      summary: { ...preview.summary, creates: 1234 },
    });
    render(
      <NumberFormatProvider format="US">
        <CatalogTransferScreen />
      </NumberFormatProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Impor CSV...' }));
    const card = await screen.findByTestId('catalog-import-preview');
    expect(
      within(card).getByRole('cell', { name: '01 · Gudang' }),
    ).toBeInTheDocument();
    expect(within(card).getAllByText('1,234')).toHaveLength(1);
  });

  test('a clean preview commits with its token and shows the result', async () => {
    const bridge = install(readyPreview());
    render(<CatalogTransferScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'Impor CSV...' }));
    const preview = await screen.findByTestId('catalog-import-preview');
    expect(within(preview).getByText(/cadangan pengaman/)).toBeVisible();
    expect(within(preview).getByTestId('import-rows')).toHaveTextContent(
      'BENGKEL: - -> Rp 65.000',
    );
    await userEvent.click(
      within(preview).getByRole('button', { name: 'Impor sekarang' }),
    );
    expect(bridge.commitImport).toHaveBeenCalledWith({ token: TOKEN });
    expect(
      await screen.findByTestId('catalog-import-result'),
    ).toHaveTextContent('bengkelin-safety-20260930-100000.sqlite');
    expect(screen.queryByTestId('catalog-import-preview')).toBeNull();
  });

  test('errors are listed by row and block the commit', async () => {
    const bridge = install(
      readyPreview({
        canCommit: false,
        errorCount: 1,
        errors: [
          {
            row: 3,
            column: 'unit',
            sku: 'BAN-02',
            error: {
              code: 'UNKNOWN_UNIT',
              messageKey: 'errors.UNKNOWN_UNIT',
              params: { value: 'LUSIN' },
            },
          },
        ],
      }),
    );
    render(<CatalogTransferScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'Impor CSV...' }));
    const errors = await screen.findByTestId('import-errors');
    expect(errors).toHaveTextContent(
      'Baris 3 · unit · BAN-02: Kode satuan "LUSIN" tidak dikenal.',
    );
    const commit = screen.getByRole('button', { name: 'Impor sekarang' });
    expect(commit).toBeDisabled();
    await userEvent.click(commit);
    expect(bridge.commitImport).not.toHaveBeenCalled();
  });

  test('spreadsheet notes and the new CSV issue codes are translated (I4)', async () => {
    install(
      readyPreview({
        canCommit: false,
        errorCount: 1,
        errors: [
          {
            row: 1,
            column: null,
            sku: null,
            error: {
              code: 'WRONG_DELIMITER',
              messageKey: 'errors.WRONG_DELIMITER',
            },
          },
        ],
      }),
    );
    render(<CatalogTransferScreen />);
    expect(screen.getByTestId('csv-separator-note')).toHaveTextContent(
      /pemisah daftar/,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Impor CSV...' }));
    expect(await screen.findByTestId('import-errors')).toHaveTextContent(
      'CSV UTF-8 (comma delimited)',
    );
    for (const language of Object.keys(resources)) {
      const errors = resources[language]!.translation.errors as Record<
        string,
        string
      >;
      expect(errors.WRONG_DELIMITER, language).toBeTruthy();
      expect(errors.SPREADSHEET_NUMBER_FORMAT, language).toContain('{{value}}');
      expect(errors.POSSIBLE_LEADING_ZERO_LOSS, language).toContain(
        '{{existingSku}}',
      );
    }
  });

  test('export warns about items without a SKU', async () => {
    install(readyPreview());
    render(<CatalogTransferScreen />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Ekspor katalog' }),
    );
    const notice = screen.getByTestId('catalog-transfer-notice');
    expect(
      await within(notice).findByText(/2 barang belum punya SKU/),
    ).toBeVisible();
  });
});
