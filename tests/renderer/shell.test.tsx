import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { Shell } from '@/renderer/features/shell/Shell';
import type { CashierSession } from '@/shared/contracts';
import { workspaceBridge } from './helpers/workspace-bridge';
import type { PublicSettings } from '@/shared/contracts';

const settings: PublicSettings = {
  systemNumberLocale: 'id-ID',
  setupCompleted: true,
  language: 'id',
  appearance: 'SYSTEM',
  shopName: 'Bengkel',
};

const cashier: CashierSession = {
  numberFormat: 'ID',
  cashierId: '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11',
  username: 'siti',
  displayName: 'Siti',
  role: 'CASHIER',
  language: 'id',
  appearance: 'SYSTEM',
};

describe('shell', () => {
  test('shows invoice controls before profile only on the invoice page', async () => {
    (window as unknown as { bengkelin: unknown }).bengkelin = workspaceBridge();
    render(
      <Shell session={cashier} shopName="Bengkel" onLoggedOut={vi.fn()} />,
    );
    const draft = await screen.findByRole('button', { name: 'Draft' });
    const header = screen.getByText('Siti').closest('header')!;
    expect(header).toContainElement(draft);
    expect(header).toContainElement(
      screen.getByRole('button', { name: 'Buat Baru' }),
    );
    expect(header).toContainElement(
      screen.getByRole('button', { name: 'Cek harga' }),
    );
    expect(
      draft.compareDocumentPosition(screen.getByText('Siti')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: 'Faktur Penjualan' }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Riwayat' }));
    expect(
      screen.queryByRole('button', { name: 'Draft' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Faktur Penjualan' }),
    );
    expect(screen.getByRole('button', { name: 'Draft' })).toBeInTheDocument();
  });
  test('profile preferences start collapsed and expose full-width language options with flags', async () => {
    const changed = vi.fn();
    (window as unknown as { bengkelin: unknown }).bengkelin = {
      ...workspaceBridge(),
      settings: {
        updatePreferences: vi.fn(async (value) => ({ ok: true, value })),
      },
    };
    render(
      <Shell
        session={cashier}
        shopName="Bengkel"
        settings={settings}
        onPreferencesChanged={changed}
        onLoggedOut={vi.fn()}
      />,
    );
    const profile = screen.getByText('Siti').closest('details')!;
    expect(
      [...profile.querySelectorAll('details')].every((item) => !item.open),
    ).toBe(true);
    await userEvent.click(screen.getByText('Siti'));
    await userEvent.click(screen.getByText('Bahasa', { selector: 'summary' }));
    expect(
      screen.getByRole('radio', { name: 'Bahasa Indonesia' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /English/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /English/ })).toHaveAttribute(
      'type',
      'radio',
    );
    expect(screen.getByRole('radio', { name: /English/ })).not.toHaveClass(
      'sr-only',
    );
    expect(screen.getByTitle('Indonesia')).toBeInTheDocument();
    expect(screen.getByTitle('United States')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'English' }));
    expect(changed).toHaveBeenCalledWith({
      numberFormat: 'ID',
      language: 'en',
      appearance: 'SYSTEM',
    });
    expect(
      screen.getByRole('radio', { name: 'English' }).closest('label'),
    ).toHaveClass('w-full');
    await userEvent.click(
      screen.getByText('Format angka', { selector: 'summary' }),
    );
    await userEvent.click(
      screen.getByRole('radio', { name: 'Amerika Serikat — 1,234,567.89' }),
    );
    expect(changed).toHaveBeenLastCalledWith({
      language: 'id',
      appearance: 'SYSTEM',
      numberFormat: 'US',
    });
  });

  test('failed preference saves keep prior values and show the error', async () => {
    const changed = vi.fn();
    (window as unknown as { bengkelin: unknown }).bengkelin = {
      ...workspaceBridge(),
      settings: {
        updatePreferences: vi.fn(async () => ({
          ok: false as const,
          error: { code: 'FAILED', messageKey: 'errors.INTERNAL_ERROR' },
        })),
      },
    };
    render(
      <Shell
        session={cashier}
        shopName="Bengkel"
        settings={settings}
        onPreferencesChanged={changed}
        onLoggedOut={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByText('Siti'));
    await userEvent.click(screen.getByText('Bahasa', { selector: 'summary' }));
    await userEvent.click(screen.getByRole('radio', { name: 'English' }));
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    expect(changed).not.toHaveBeenCalled();
    expect(
      screen.getByRole('radio', { name: 'Bahasa Indonesia' }),
    ).toBeChecked();
  });
  test('a rejected IPC promise does not leave the sign-out button stuck busy', async () => {
    const logout = vi.fn(async () => {
      throw new Error('ipc down');
    });
    (window as unknown as { bengkelin: unknown }).bengkelin = {
      ...workspaceBridge(),
      auth: { logout },
    };
    render(
      <Shell session={cashier} shopName="Bengkel" onLoggedOut={vi.fn()} />,
    );
    // The cashier workspace is the default view after login.
    expect(
      await screen.findByRole('combobox', { name: 'Cari barang' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('session-name'));
    const button = screen.getByRole('button', { name: 'Keluar' });
    await userEvent.click(button);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(button).toBeEnabled();
  });

  test('reference management is offered to ADMIN only', () => {
    (window as unknown as { bengkelin: unknown }).bengkelin = workspaceBridge();
    const { unmount } = render(
      <Shell session={cashier} shopName="Bengkel" onLoggedOut={vi.fn()} />,
    );
    expect(
      screen.queryByRole('button', { name: 'Data Referensi' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Pelanggan & Kendaraan' }),
    ).toBeInTheDocument();
    unmount();
    render(
      <Shell
        session={{ ...cashier, role: 'ADMIN' }}
        shopName="Bengkel"
        onLoggedOut={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Data Referensi' }),
    ).toBeInTheDocument();
  });
});
