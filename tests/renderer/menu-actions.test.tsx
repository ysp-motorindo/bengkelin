import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '@/renderer/app/App';
import { pageReload } from '@/renderer/app/menu-actions';
import { registerFlusher } from '@/renderer/lib/flush-registry';
import { PrintActions } from '@/renderer/features/printing/PrintActions';
import { runPrintTarget } from '@/renderer/features/printing/print-target';
import { Shell } from '@/renderer/features/shell/Shell';
import type { FinalizeClient } from '@/renderer/features/workspace/checkout/finalize-client';
import { trackFinalize } from '@/renderer/features/workspace/checkout/finalize-pending';
import type {
  CashierSession,
  FinalizePreviewDto,
  InvoiceView,
  PublicSettings,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
import type { MenuAction } from '@/shared/menu';
import { MANUAL_SUMMARY, backupBridge } from './helpers/backup-bridge';
import { DRAFT_ID, ok, workspaceBridge } from './helpers/workspace-bridge';

/**
 * Native menu actions arrive through `app.onMenuAction` and are dispatched
 * to existing APIs: the shell switches to the right view first.
 */

const cashier: CashierSession = {
  numberFormat: 'ID',
  cashierId: '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11',
  username: 'siti',
  displayName: 'Siti',
  role: 'CASHIER',
  language: 'id',
  appearance: 'SYSTEM',
};
const admin: CashierSession = {
  ...cashier,
  username: 'admin',
  displayName: 'Pak Budi',
  role: 'ADMIN',
};

function installBridge(extra: Record<string, unknown> = {}) {
  let listener: ((action: MenuAction) => void) | null = null;
  const app = {
    onMenuAction: vi.fn((callback: (action: MenuAction) => void) => {
      listener = callback;
      return () => {
        listener = null;
      };
    }),
    setMenuContext: vi.fn(async () => ok(undefined)),
    about: vi.fn(async () => ok({ appVersion: '1.0.0', schemaVersion: 11 })),
    openLogFolder: vi.fn(async () => ok(undefined)),
  };
  const workspace = workspaceBridge();
  const bridge = {
    ...workspace,
    app,
    backups: {
      ...backupBridge(),
      takeRestoreNotice: vi.fn(async () => ok(null)),
    },
    cashiers: { listNames: vi.fn(async () => ok([])) },
    reports: { daily: vi.fn(() => new Promise(() => undefined)) },
    ...extra,
  };
  (window as unknown as { bengkelin: unknown }).bengkelin = bridge;
  return {
    bridge,
    fire: async (action: MenuAction) => {
      await act(async () => {
        listener?.(action);
        await Promise.resolve();
      });
    },
  };
}

const finalizer = {
  previewFinalize: vi.fn(() => new Promise<never>(() => undefined)),
  finalize: vi.fn(),
} satisfies FinalizeClient;

afterEach(() => vi.restoreAllMocks());

describe('menu action dispatch in the shell', () => {
  test('Finalize (F8) switches to the workspace and opens the review only', async () => {
    const { fire } = installBridge();
    render(
      <Shell
        session={cashier}
        shopName="Bengkel"
        onLoggedOut={vi.fn()}
        finalizer={finalizer}
      />,
    );
    await screen.findByRole('combobox', { name: 'Cari barang' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Pelanggan & Kendaraan' }),
    );
    await fire('finalize');
    expect(screen.getByRole('button', { name: 'Penjualan' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(
      await screen.findByRole('dialog', { name: 'Tinjau checkout' }),
    ).toBeInTheDocument();
    expect(finalizer.finalize).not.toHaveBeenCalled();
  });

  test('New Transaction (Ctrl+N) is ignored while a dialog is open (I3)', async () => {
    const { bridge, fire } = installBridge();
    render(
      <Shell session={cashier} shopName="Bengkel" onLoggedOut={vi.fn()} />,
    );
    await screen.findByRole('combobox', { name: 'Cari barang' });
    expect(bridge.drafts.create).toHaveBeenCalledTimes(1);
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Cari barang' }),
    );
    await userEvent.click(screen.getByRole('option', { name: 'Item kustom' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await fire('newTransaction');
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.drafts.create).toHaveBeenCalledTimes(1);
  });

  test('New Transaction is ignored while a finalize is pending; the finalized view opts in (I3)', async () => {
    let settle: (value: Result<InvoiceView>) => void = () => undefined;
    const pendingFinalizer = {
      previewFinalize: vi.fn(async () =>
        ok<FinalizePreviewDto>({
          invoiceId: DRAFT_ID,
          draftVersion: 1,
          totals: {
            vatRateBps: 0,
            taxSubtotal: '0',
            vatAmount: '0',
            subtotal: '0',
            itemDiscountAmount: '0',
            invoiceDiscountAmount: '0',
            discountAmount: '0',
            amount: '0',
            checkoutPaymentAmount: '0',
            outstandingAmount: '0',
          },
          checkoutPayments: [],
          paymentStatusAfterCheckout: 'PAID',
          errors: [],
          warnings: [],
        }),
      ),
      finalize: vi.fn(
        () =>
          new Promise<Result<InvoiceView>>((resolve) => {
            settle = resolve;
          }),
      ),
    } satisfies FinalizeClient;
    const { bridge, fire } = installBridge({
      printing: {
        getOptions: vi.fn(async () =>
          ok({
            defaultInvoiceFormat: 'THERMAL',
            thermalFormat: 'THERMAL_80',
            autoPrintAfterFinalize: false,
          }),
        ),
      },
    });
    render(
      <Shell
        session={cashier}
        shopName="Bengkel"
        onLoggedOut={vi.fn()}
        finalizer={pendingFinalizer}
      />,
    );
    await screen.findByRole('combobox', { name: 'Cari barang' });
    await fire('finalize');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Finalisasi' }),
    );
    expect(pendingFinalizer.finalize).toHaveBeenCalledOnce();
    await fire('newTransaction');
    expect(bridge.drafts.create).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle(
        ok({
          id: DRAFT_ID,
          invoiceNumber: 'INV-20260930-0001',
          status: 'FINALIZED',
          totals: { amount: '0' },
          paymentStatus: 'PAID',
          payments: [],
        } as unknown as InvoiceView),
      );
    });
    await screen.findByRole('dialog', { name: 'Faktur final' });
    await fire('newTransaction');
    await waitFor(() => expect(bridge.drafts.create).toHaveBeenCalledTimes(2));
  });

  test('New Transaction is ignored while a finalize request is in flight even with no dialog (I3)', async () => {
    const { bridge, fire } = installBridge();
    render(
      <Shell session={cashier} shopName="Bengkel" onLoggedOut={vi.fn()} />,
    );
    await screen.findByRole('combobox', { name: 'Cari barang' });
    let finish: () => void = () => undefined;
    const request = trackFinalize(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await fire('newTransaction');
    expect(bridge.drafts.create).toHaveBeenCalledTimes(1);
    finish();
    await act(async () => {
      await request;
    });
    await fire('newTransaction');
    await waitFor(() => expect(bridge.drafts.create).toHaveBeenCalledTimes(2));
  });

  test('Search Item returns to the workspace and focuses "Cari barang"; Daily Report opens the report', async () => {
    const { fire } = installBridge();
    render(
      <Shell session={cashier} shopName="Bengkel" onLoggedOut={vi.fn()} />,
    );
    const search = await screen.findByRole('combobox', { name: 'Cari barang' });
    await fire('dailyReport');
    expect(
      screen.getByRole('button', { name: 'Laporan Harian' }),
    ).toHaveAttribute('aria-current', 'page');
    await fire('searchItem');
    expect(screen.getByRole('button', { name: 'Penjualan' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await waitFor(() => expect(search).toHaveFocus());
  });

  test('Backup Database runs for ADMIN and announces the result; ignored for a CASHIER', async () => {
    const first = installBridge();
    const { unmount } = render(
      <Shell session={cashier} shopName="Bengkel" onLoggedOut={vi.fn()} />,
    );
    await screen.findByRole('combobox', { name: 'Cari barang' });
    await first.fire('backupDatabase');
    expect(first.bridge.backups.create).not.toHaveBeenCalled();
    unmount();

    const second = installBridge();
    render(<Shell session={admin} shopName="Bengkel" onLoggedOut={vi.fn()} />);
    await screen.findByRole('combobox', { name: 'Cari barang' });
    await second.fire('backupDatabase');
    await waitFor(() =>
      expect(screen.getByTestId('menu-notice')).toHaveTextContent(
        MANUAL_SUMMARY.fileName,
      ),
    );
    expect(second.bridge.backups.create).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('menu-notice')).toHaveAttribute('role', 'status');
  });

  test('a failing Open Log Folder is announced as an alert', async () => {
    const { fire, bridge } = installBridge();
    bridge.app.openLogFolder.mockResolvedValue({
      ok: false,
      error: {
        code: 'LOG_FOLDER_UNAVAILABLE',
        messageKey: 'errors.LOG_FOLDER_UNAVAILABLE',
      },
    } as never);
    render(<Shell session={admin} shopName="Bengkel" onLoggedOut={vi.fn()} />);
    await screen.findByRole('combobox', { name: 'Cari barang' });
    await fire('openLogFolder');
    await waitFor(() =>
      expect(screen.getByTestId('menu-notice')).toHaveAttribute(
        'role',
        'alert',
      ),
    );
  });

  test('the one-time restore notice is taken for ADMIN only', async () => {
    const first = installBridge();
    const { unmount } = render(
      <Shell session={cashier} shopName="Bengkel" onLoggedOut={vi.fn()} />,
    );
    await screen.findByRole('combobox', { name: 'Cari barang' });
    expect(first.bridge.backups.takeRestoreNotice).not.toHaveBeenCalled();
    unmount();

    const second = installBridge();
    second.bridge.backups.takeRestoreNotice.mockResolvedValue(
      ok({ outcome: 'ROLLED_BACK', at: '2026-09-30T03:00:00.000Z' }) as never,
    );
    render(<Shell session={admin} shopName="Bengkel" onLoggedOut={vi.fn()} />);
    const notice = await screen.findByTestId('restore-notice');
    expect(notice).toHaveTextContent(/dibatalkan|kembali/i);
    await userEvent.click(screen.getByRole('button', { name: 'Tutup' }));
    expect(screen.queryByTestId('restore-notice')).not.toBeInTheDocument();
  });
});

describe('About and Print', () => {
  test('About works before login: app and schema version', async () => {
    const settings: PublicSettings = {
      systemNumberLocale: 'id-ID',
      setupCompleted: true,
      language: 'id',
      appearance: 'SYSTEM',
      shopName: 'Bengkel Maju',
    };
    const { fire } = installBridge({
      auth: { currentSession: vi.fn(async () => ok(null)) },
      settings: { getPublic: vi.fn(async () => ok(settings)) },
    });
    render(<App />);
    await screen.findByLabelText('Nama pengguna');
    await fire('about');
    const about = await screen.findByRole('dialog', {
      name: 'Tentang Bengkelin',
    });
    expect(about).toHaveTextContent('1.0.0');
    expect(screen.getByTestId('about-schema')).toHaveTextContent('11');
  });

  test('Reload flushes pending draft input first, then reloads (also before login)', async () => {
    const order: string[] = [];
    let release!: () => void;
    const unregister = registerFlusher(
      () =>
        new Promise<boolean>((resolve) => {
          order.push('flush');
          release = () => resolve(true);
        }),
    );
    const reload = vi
      .spyOn(pageReload, 'reload')
      .mockImplementation(() => order.push('reload'));
    const { fire } = installBridge({
      auth: { currentSession: vi.fn(async () => ok(null)) },
      settings: {
        getPublic: vi.fn(async () =>
          ok({
            setupCompleted: true,
            language: 'id',
            appearance: 'SYSTEM',
            shopName: 'Bengkel Maju',
          }),
        ),
      },
    });
    render(<App />);
    await screen.findByLabelText('Nama pengguna');
    await fire('reload');
    expect(order).toEqual(['flush']);
    expect(reload).not.toHaveBeenCalled();
    await act(async () => release());
    expect(order).toEqual(['flush', 'reload']);
    unregister();
  });

  test('mounted print actions are the printable context: Print prints the default format', async () => {
    const { bridge } = installBridge();
    const client = {
      getOptions: vi.fn(async () =>
        ok({
          defaultInvoiceFormat: 'THERMAL' as const,
          thermalFormat: 'THERMAL_80' as const,
          autoPrintAfterFinalize: false,
        }),
      ),
      preview: vi.fn(),
      print: vi.fn(async () =>
        ok({
          outcome: 'PRINTED' as const,
          format: 'THERMAL_80' as const,
          isReprint: false,
        }),
      ),
      exportPdf: vi.fn(),
    };
    const { unmount } = render(
      <PrintActions
        invoiceId="5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11"
        client={client}
      />,
    );
    await waitFor(() =>
      expect(bridge.app.setMenuContext).toHaveBeenLastCalledWith({
        printable: true,
      }),
    );
    await waitFor(() => expect(client.getOptions).toHaveBeenCalled());
    await act(async () => {
      await runPrintTarget();
    });
    expect(client.print).toHaveBeenCalledWith({
      invoiceId: '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11',
      format: 'THERMAL_80',
    });
    unmount();
    expect(bridge.app.setMenuContext).toHaveBeenLastCalledWith({
      printable: false,
    });
    expect(await runPrintTarget()).toBe(false);
  });
});
