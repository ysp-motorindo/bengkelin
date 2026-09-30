import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { PrintActions } from '@/renderer/features/printing/PrintActions';
import type { PrintClient } from '@/renderer/features/printing/print-client';
import { SettingsScreen } from '@/renderer/features/settings/SettingsScreen';
import { backupBridge } from './helpers/backup-bridge';
import type {
  PrintFormat,
  PrintOutcomeDto,
  PrintSettingsDto,
} from '@/shared/contracts';

const ID = '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11';
const ok = <T,>(value: T) => ({ ok: true as const, value });

function documentFor(format: PrintFormat, extra = '') {
  return `<!doctype html><html lang="id"><head><style>.sheet { width: 48mm; }</style></head>
<body><div class="sheet layout-${format}"><h1>INV-20260930-0001</h1>
<span data-money="amount">Rp 31.500</span>${extra}</div></body></html>`;
}

function client(outcomes: Partial<PrintOutcomeDto>[] = [], extraHtml = '') {
  return {
    getOptions: vi.fn(async () =>
      ok({
        defaultInvoiceFormat: 'THERMAL' as const,
        thermalFormat: 'THERMAL_58' as const,
        autoPrintAfterFinalize: false,
      }),
    ),
    preview: vi.fn(async (input: { format: PrintFormat }) =>
      ok({
        html: documentFor(input.format, extraHtml),
        format: input.format,
        pageInfo: {
          format: input.format,
          widthMm: 58,
          heightMm: null,
          printableWidthMm: 48,
          paginated: false,
        },
      }),
    ),
    print: vi.fn(async (input: { format: PrintFormat }) =>
      ok({
        outcome: 'PRINTED' as const,
        format: input.format,
        isReprint: false,
        ...outcomes.shift(),
      }),
    ),
    exportPdf: vi.fn(async () =>
      ok({
        outcome: 'PRINTED' as const,
        format: 'A4' as const,
        isReprint: false,
        fileName: 'INV-20260930-0001.pdf',
      }),
    ),
  } satisfies PrintClient;
}

describe('print actions', () => {
  test('outcomes are messages; a missing printer names the printer', async () => {
    const fake = client([
      {
        outcome: 'FAILED',
        code: 'PRINTER_NOT_FOUND',
        params: { printerName: 'EPSON_TM_T82' },
      },
      { outcome: 'CANCELLED' },
      { isReprint: true },
    ]);
    render(<PrintActions invoiceId={ID} client={fake} />);
    const user = userEvent.setup();
    await waitFor(() => expect(fake.getOptions).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Cetak Thermal' }));
    expect(fake.print).toHaveBeenLastCalledWith({
      invoiceId: ID,
      format: 'THERMAL_58',
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Printer “EPSON_TM_T82” tidak ditemukan. Faktur tetap tersimpan',
    );

    await user.click(screen.getByRole('button', { name: 'Cetak A4' }));
    expect(await screen.findByTestId('print-notice')).toHaveTextContent(
      'Dibatalkan.',
    );
    await user.click(screen.getByRole('button', { name: 'Cetak A4' }));
    expect(await screen.findByTestId('print-notice')).toHaveTextContent(
      'Faktur dicetak ulang (A4).',
    );

    await user.click(screen.getByRole('button', { name: 'Ekspor PDF' }));
    expect(fake.exportPdf).toHaveBeenCalledWith({ invoiceId: ID });
    expect(await screen.findByTestId('print-notice')).toHaveTextContent(
      'PDF disimpan: INV-20260930-0001.pdf',
    );
  });

  test('a rejected print call is a message, and the buttons recover', async () => {
    const fake = client();
    fake.print.mockRejectedValueOnce(new Error('ipc down'));
    render(<PrintActions invoiceId={ID} client={fake} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Cetak A4' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Gagal mencetak',
    );
    expect(screen.getByRole('button', { name: 'Cetak A4' })).toBeEnabled();
  });
});

describe('print preview', () => {
  test('shows the same document in a shadow root and switches formats', async () => {
    const fake = client();
    render(<PrintActions invoiceId={ID} client={fake} />);
    const user = userEvent.setup();
    await waitFor(() => expect(fake.getOptions).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Pratinjau' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Pratinjau cetak',
    });
    await waitFor(() =>
      expect(fake.preview).toHaveBeenCalledWith({
        invoiceId: ID,
        format: 'THERMAL_58',
      }),
    );
    const host = await within(dialog).findByTestId('print-preview-document');
    await waitFor(() =>
      expect(host.shadowRoot?.textContent).toContain('INV-20260930-0001'),
    );
    expect(host.shadowRoot?.textContent).toContain('Rp 31.500');
    // The document's markup is not in the light DOM (its CSS stays isolated).
    expect(host.textContent).toBe('');

    await user.selectOptions(within(dialog).getByLabelText('Format'), 'A4');
    await waitFor(() =>
      expect(fake.preview).toHaveBeenLastCalledWith({
        invoiceId: ID,
        format: 'A4',
      }),
    );
    await waitFor(() =>
      expect(
        within(dialog)
          .getByTestId('print-preview-document')
          .shadowRoot?.querySelector('.layout-A4'),
      ).not.toBeNull(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cetak' }));
    expect(fake.print).toHaveBeenCalledWith({ invoiceId: ID, format: 'A4' });
    expect(
      await within(dialog).findByTestId('preview-print-notice'),
    ).toHaveTextContent('Faktur dicetak (A4).');
  });

  test('active content never reaches the preview', async () => {
    const fake = client(
      [],
      `<script>window.hacked = true</script><img src="https://evil.example/x.png" onerror="window.hacked = true"><img src="data:image/png;base64,AAAA" alt="logo">`,
    );
    render(<PrintActions invoiceId={ID} client={fake} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Pratinjau' }));
    const host = await screen.findByTestId('print-preview-document');
    await waitFor(() =>
      expect(host.shadowRoot?.querySelector('h1')).not.toBeNull(),
    );
    const shadow = host.shadowRoot!;
    expect(shadow.querySelector('script')).toBeNull();
    const [remote, logo] = [...shadow.querySelectorAll('img')];
    expect(remote!.hasAttribute('src')).toBe(false);
    expect(remote!.hasAttribute('onerror')).toBe(false);
    expect(logo!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
  });
});

describe('ADMIN settings screen', () => {
  test('print settings: printers optional, missing printer visible, saves', async () => {
    const settings: PrintSettingsDto = {
      defaultInvoiceFormat: 'THERMAL',
      thermalPaperWidthMm: 58,
      defaultA4PrinterName: null,
      defaultThermalPrinterName: 'OLD_POS',
      autoPrintAfterFinalize: false,
    };
    const updateSettings = vi.fn(async (input: PrintSettingsDto) => ok(input));
    (window as unknown as { bengkelin: unknown }).bengkelin = {
      settings: {
        getLogo: vi.fn(async () => ok(null)),
        chooseLogo: vi.fn(async () =>
          ok({
            outcome: 'UPDATED',
            logo: { asset: 'a.png', dataUrl: 'data:image/png;base64,AAAA' },
          }),
        ),
        removeLogo: vi.fn(async () => ok(undefined)),
        getShop: vi.fn(async () => ok({ timezone: 'Asia/Jakarta' })),
      },
      backups: backupBridge(),
      printing: {
        getSettings: vi.fn(async () => ok(settings)),
        listPrinters: vi.fn(async () =>
          ok([
            {
              name: 'HP_LaserJet',
              displayName: 'HP LaserJet',
              isDefault: true,
            },
          ]),
        ),
        updateSettings,
      },
    };
    render(<SettingsScreen />);
    const user = userEvent.setup();
    const thermal = await screen.findByLabelText('Printer thermal default');
    expect(thermal).toHaveValue('OLD_POS');
    expect(
      within(thermal).getByRole('option', {
        name: 'OLD_POS (tidak ditemukan)',
      }),
    ).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText('Printer A4 default'),
      'HP_LaserJet',
    );
    await user.selectOptions(thermal, '');
    await user.selectOptions(
      screen.getByLabelText('Lebar kertas thermal'),
      '80',
    );
    await user.click(
      screen.getByLabelText('Cetak otomatis setelah faktur final'),
    );
    await user.click(
      screen.getByRole('button', { name: 'Simpan pengaturan cetak' }),
    );
    expect(updateSettings).toHaveBeenCalledWith({
      defaultInvoiceFormat: 'THERMAL',
      thermalPaperWidthMm: 80,
      defaultA4PrinterName: 'HP_LaserJet',
      defaultThermalPrinterName: null,
      autoPrintAfterFinalize: true,
    });
    expect(
      await screen.findByText('Pengaturan cetak disimpan.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pilih logo...' }));
    expect(await screen.findByTestId('shop-logo')).toHaveAttribute(
      'src',
      'data:image/png;base64,AAAA',
    );
  });
});
