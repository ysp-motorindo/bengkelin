import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { Shell } from '@/renderer/features/shell/Shell';
import type { CashierSession } from '@/shared/contracts';
import { workspaceBridge } from './helpers/workspace-bridge';

const cashier: CashierSession = {
  cashierId: '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11',
  username: 'siti',
  displayName: 'Siti',
  role: 'CASHIER',
  language: 'id',
  appearance: 'SYSTEM',
};

describe('shell', () => {
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
