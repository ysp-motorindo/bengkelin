import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DailyReportScreen } from '@/renderer/features/reports/DailyReportScreen';
import type { ReportClient } from '@/renderer/features/reports/report-client';
import {
  PAYMENT_METHODS,
  type CashierSession,
  type DailyReport,
} from '@/shared/contracts';

const SITI: CashierSession = {
  cashierId: '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d12',
  username: 'siti',
  displayName: 'Siti',
  role: 'CASHIER',
} as CashierSession;
const BENGKEL = '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d31';

function report(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    date: '2026-10-01',
    timezone: 'Asia/Jakarta',
    range: {
      start: '2026-09-30T17:00:00.000Z',
      end: '2026-10-01T17:00:00.000Z',
    },
    generatedAt: '2026-09-30T17:30:00.000Z',
    generatedAtLocal: '2026-10-01 00:30',
    filters: { cashier: null, channel: null },
    sales: {
      invoiceCount: 1,
      // Beyond Number.MAX_SAFE_INTEGER: must be formatted with BigInt.
      grossSubtotal: '9007199254740993',
      itemDiscounts: '0',
      invoiceDiscounts: '0',
      netBeforeVoids: '9007199254740993',
      byChannel: [
        {
          channel: { id: BENGKEL, label: 'Bengkel' },
          invoiceCount: 1,
          netBeforeVoids: '9007199254740993',
        },
      ],
      byCashier: [
        {
          cashier: { id: SITI.cashierId, displayName: 'Siti' },
          invoiceCount: 1,
          netBeforeVoids: '9007199254740993',
        },
      ],
    },
    voids: {
      count: 1,
      deduction: '250000',
      invoices: [
        {
          invoiceId: BENGKEL,
          invoiceNumber: 'INV-20260930-0003',
          finalizedAt: '2026-09-30T03:00:00.000Z',
          finalizedDate: '2026-09-30',
          voidedAt: '2026-09-30T17:10:00.000Z',
          voidedAtLocal: '2026-10-01 00:10',
          amount: '250000',
          reason: '<b>Salah</b>',
          voidedBy: { id: SITI.cashierId, displayName: 'Siti' },
          channel: { id: BENGKEL, label: 'Bengkel' },
        },
      ],
    },
    netAfterVoids: '9007199254490993',
    payments: {
      received: '1100000',
      count: 2,
      byMethod: PAYMENT_METHODS.map((method) => ({
        method,
        count: method === 'CASH' ? 2 : 0,
        amount: method === 'CASH' ? '1100000' : '0',
      })),
      sameDayInvoices: '500000',
      olderInvoices: '600000',
    },
    ...overrides,
  };
}

function client(overrides: Partial<ReportClient> = {}): ReportClient {
  return {
    daily: vi.fn(async (input) => ({
      ok: true as const,
      value: report({ date: input.date }),
    })),
    preview: vi.fn(async () => ({
      ok: true as const,
      value: {
        html: '<!doctype html><html><head><style>.sheet{color:red}</style></head><body><div class="sheet layout-a4"><span data-money="netAfterVoids">-Rp 250.000</span><script>alert(1)</script></div></body></html>',
        pageInfo: {
          format: 'A4' as const,
          widthMm: 210,
          heightMm: 297,
          printableWidthMm: 186,
          paginated: true,
        },
      },
    })),
    print: vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: 'FAILED' as const,
        code: 'PRINTER_NOT_FOUND' as const,
        params: { printerName: 'HP_LaserJet' },
      },
    })),
    exportCsv: vi.fn(async () => ({
      ok: true as const,
      value: { outcome: 'PRINTED' as const, fileName: 'laporan.csv' },
    })),
    ...overrides,
  };
}

beforeEach(() => {
  // 2026-10-01 00:30 in Jakarta, still September 30 in UTC.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 8, 30, 17, 30) });
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    settings: {
      getShop: vi.fn(async () => ({
        ok: true,
        value: { name: 'Bengkel', timezone: 'Asia/Jakarta' },
      })),
    },
    references: {
      listActive: vi.fn(async () => ({
        ok: true,
        value: [{ id: BENGKEL, code: 'BENGKEL', label: 'Bengkel' }],
      })),
      list: vi.fn(),
    },
    // Names only, any session (T17: the T11 "me only" limit is lifted).
    cashiers: {
      list: vi.fn(),
      listNames: vi.fn(async () => ({
        ok: true,
        value: [
          {
            id: 'a1b2c3d4-0000-4000-8000-000000000001',
            displayName: 'Pak Budi',
            isActive: true,
          },
          { id: SITI.cashierId, displayName: 'Siti', isActive: true },
        ],
      })),
    },
  };
});
afterEach(() => vi.useRealTimers());

describe('daily report screen', () => {
  test('defaults to today in the shop timezone and shows every section from the DTO', async () => {
    const fake = client();
    render(<DailyReportScreen session={SITI} client={fake} />);
    expect(await screen.findByTestId('daily-report')).toBeInTheDocument();
    expect(fake.daily).toHaveBeenCalledWith({ date: '2026-10-01' });
    expect(screen.getByLabelText('Tanggal')).toHaveValue('2026-10-01');
    expect(screen.getByTestId('report-heading')).toHaveTextContent(
      'Tanggal 01/10/2026 · zona waktu Asia/Jakarta · dibuat pukul 00:30',
    );
    const field = (name: string) =>
      document.querySelector(`[data-field="${name}"]`);
    expect(field('sales.netBeforeVoids')).toHaveTextContent(
      'Rp 9.007.199.254.740.993',
    );
    expect(field('netAfterVoids')).toHaveTextContent(
      'Rp 9.007.199.254.490.993',
    );
    expect(field('voids.deduction')).toHaveTextContent('Rp 250.000');
    expect(field('payments.received')).toHaveTextContent('Rp 1.100.000');
    expect(field('payments.olderInvoices')).toHaveTextContent('Rp 600.000');
    expect(field('payments.sameDayInvoices')).toHaveTextContent('Rp 500.000');
    for (const method of PAYMENT_METHODS) {
      expect(field(`payments.byMethod.${method}.amount`)).not.toBeNull();
    }
    // Text is rendered as text, never as markup.
    expect(screen.getByText('<b>Salah</b>')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Aktivitas penjualan' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Aktivitas pembayaran' }),
    ).toBeInTheDocument();
  });

  test('a CASHIER can filter on any cashier and a channel; the report reloads', async () => {
    const fake = client();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DailyReportScreen session={SITI} client={fake} />);
    await screen.findByTestId('daily-report');
    const cashier = screen.getByLabelText('Kasir');
    expect(
      within(cashier)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Semua', 'Pak Budi', 'Siti']);
    await user.selectOptions(cashier, SITI.cashierId);
    await user.selectOptions(await screen.findByLabelText('Kanal'), BENGKEL);
    const date = screen.getByLabelText('Tanggal');
    await user.clear(date);
    await user.type(date, '2026-09-30');
    await user.click(screen.getByRole('button', { name: 'Tampilkan' }));
    expect(fake.daily).toHaveBeenLastCalledWith({
      date: '2026-09-30',
      cashierId: SITI.cashierId,
      channelId: BENGKEL,
    });
  });

  test('negative net after voids is shown with a minus sign', async () => {
    const fake = client({
      daily: vi.fn(async () => ({
        ok: true as const,
        value: report({ netAfterVoids: '-250000' }),
      })),
    });
    render(<DailyReportScreen session={SITI} client={fake} />);
    await screen.findByTestId('daily-report');
    expect(
      document.querySelector('[data-field="netAfterVoids"]'),
    ).toHaveTextContent('-Rp 250.000');
  });

  test('export CSV and print report outcomes; preview is in a shadow root', async () => {
    const fake = client();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DailyReportScreen session={SITI} client={fake} />);
    await screen.findByTestId('daily-report');
    await user.click(screen.getByRole('button', { name: 'Ekspor CSV' }));
    expect(await screen.findByTestId('report-notice')).toHaveTextContent(
      'CSV disimpan: laporan.csv',
    );
    expect(fake.exportCsv).toHaveBeenCalledWith({ date: '2026-10-01' });

    await user.click(screen.getByRole('button', { name: 'Pratinjau & cetak' }));
    const dialog = await screen.findByRole('dialog');
    const host = await within(dialog).findByTestId('print-preview-document');
    expect(
      host.shadowRoot?.querySelector('[data-money="netAfterVoids"]'),
    ).not.toBeNull();
    expect(host.shadowRoot?.querySelector('script')).toBeNull();
    expect(host.querySelector('[data-money]')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Cetak A4' }));
    expect(fake.print).toHaveBeenCalledWith({ date: '2026-10-01' });
    expect(
      await within(dialog).findByTestId('report-preview-notice'),
    ).toHaveTextContent('Printer “HP_LaserJet” tidak ditemukan');
  });

  test('a failed report load shows the error', async () => {
    const fake = client({
      daily: vi.fn(async () => ({
        ok: false as const,
        error: {
          code: 'CHANNEL_NOT_FOUND',
          messageKey: 'errors.CHANNEL_NOT_FOUND',
        },
      })),
    });
    render(<DailyReportScreen session={SITI} client={fake} />);
    expect(
      await screen.findByText('Kanal tidak ditemukan.'),
    ).toBeInTheDocument();
  });
});
