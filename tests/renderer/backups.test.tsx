import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { BackupNoticeBanner } from '@/renderer/features/backups/BackupNoticeBanner';
import { BackupSection } from '@/renderer/features/backups/BackupSection';
import { Shell } from '@/renderer/features/shell/Shell';
import type { BackupStatusDto, CashierSession } from '@/shared/contracts';
import {
  backupBridge,
  backupStatus,
  MANUAL_SUMMARY,
} from './helpers/backup-bridge';
import { workspaceBridge } from './helpers/workspace-bridge';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const fail = (code: string) => ({
  ok: false as const,
  error: { code, messageKey: `errors.${code}` },
});

const FAILED_STATUS: BackupStatusDto = backupStatus({
  destination: { path: 'E:\\Cadangan', isDefault: false },
  lastAutomatic: {
    kind: 'AUTO',
    outcome: 'FAILED',
    startedAt: '2026-09-30T03:00:00.000Z',
    finishedAt: '2026-09-30T03:00:00.000Z',
    fileName: null,
    errorCode: 'BACKUP_DESTINATION_UNAVAILABLE',
  },
  notice: {
    errorCode: 'BACKUP_DESTINATION_UNAVAILABLE',
    failedAt: '2026-09-30T03:00:00.000Z',
  },
});

function install(backups: ReturnType<typeof backupBridge>) {
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    ...workspaceBridge(),
    settings: {
      getShop: vi.fn(async () => ok({ timezone: 'Asia/Jakarta' })),
    },
    backups,
  };
}

describe('Settings backup section', () => {
  test('shows the folder and schedule; "Backup now" reports the file', async () => {
    const backups = backupBridge(
      backupStatus({
        lastAutomatic: {
          kind: 'AUTO',
          outcome: 'SUCCEEDED',
          startedAt: '2026-09-30T00:30:00.000Z',
          finishedAt: '2026-09-30T00:30:01.000Z',
          fileName: 'bengkelin-auto-20260930-073000.sqlite',
          errorCode: null,
        },
        nextAutomaticAt: '2026-09-30T17:00:00.000Z',
      }),
    );
    install(backups);
    render(<BackupSection />);
    expect(
      await screen.findByText('/data/bengkelin/backups'),
    ).toBeInTheDocument();
    expect(screen.getByText('(folder bawaan)')).toBeInTheDocument();
    // Shop-local times (WIB).
    expect(
      await screen.findByText('2026-09-30 07:30:00 (Berhasil)'),
    ).toBeInTheDocument();
    expect(screen.getByText('2026-10-01 00:00:00')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Cadangkan sekarang' }),
    );
    expect(backups.create).toHaveBeenCalledWith();
    expect(await screen.findByRole('status')).toHaveTextContent(
      `Cadangan dibuat: ${MANUAL_SUMMARY.fileName}`,
    );
    // The status is re-read after the backup.
    await waitFor(() => expect(backups.status).toHaveBeenCalledTimes(2));
  });

  test('a failed manual backup is shown inline and the buttons recover', async () => {
    const backups = backupBridge(backupStatus(), async () =>
      fail('BACKUP_DESTINATION_UNAVAILABLE'),
    );
    install(backups);
    render(<BackupSection />);
    const button = await screen.findByRole('button', {
      name: 'Cadangkan sekarang',
    });
    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Folder cadangan tidak tersedia',
    );
    expect(button).toBeEnabled();
  });

  test('choosing a folder asks main (no path is sent) and shows the new folder', async () => {
    const backups = backupBridge();
    const updated = backupStatus({
      destination: { path: 'E:\\Cadangan', isDefault: false },
    });
    backups.chooseDestination.mockImplementationOnce(async () => {
      // Main now reports the new folder to every reader.
      backups.status.mockResolvedValue(ok(updated));
      return ok({ outcome: 'UPDATED', status: updated });
    });
    install(backups);
    render(<BackupSection />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Pilih folder...' }),
    );
    expect(backups.chooseDestination).toHaveBeenCalledWith();
    expect(await screen.findByText('E:\\Cadangan')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Folder cadangan diperbarui.',
    );
  });
});

describe('ADMIN failure banner', () => {
  test('shows the error until a backup succeeds, with "Backup now"', async () => {
    const backups = backupBridge(FAILED_STATUS);
    install(backups);
    render(<BackupNoticeBanner />);
    const banner = await screen.findByTestId('backup-failure-banner');
    expect(banner).toHaveTextContent('Cadangan otomatis gagal');
    expect(banner).toHaveTextContent('2026-09-30 10:00:00');
    expect(banner).toHaveTextContent('Folder cadangan tidak tersedia');

    backups.status.mockResolvedValue(ok(backupStatus()));
    await userEvent.click(
      screen.getByRole('button', { name: 'Cadangkan sekarang' }),
    );
    expect(backups.create).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.queryByTestId('backup-failure-banner'),
      ).not.toBeInTheDocument(),
    );
  });

  test('nothing is shown without a notice, or when the status cannot be read', async () => {
    const backups = backupBridge();
    install(backups);
    const { unmount } = render(<BackupNoticeBanner />);
    await waitFor(() => expect(backups.status).toHaveBeenCalled());
    expect(
      screen.queryByTestId('backup-failure-banner'),
    ).not.toBeInTheDocument();
    unmount();
    backups.status.mockRejectedValueOnce(new Error('ipc down'));
    render(<BackupNoticeBanner />);
    await waitFor(() => expect(backups.status).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByTestId('backup-failure-banner'),
    ).not.toBeInTheDocument();
  });

  test('only the ADMIN shell asks for backup status', async () => {
    const backups = backupBridge(FAILED_STATUS);
    install(backups);
    const cashier: CashierSession = {
      cashierId: '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11',
      username: 'siti',
      displayName: 'Siti',
      role: 'CASHIER',
      language: 'id',
      appearance: 'SYSTEM',
    };
    const { unmount } = render(
      <Shell session={cashier} shopName="Bengkel" onLoggedOut={vi.fn()} />,
    );
    await screen.findByRole('combobox', { name: 'Cari barang' });
    expect(backups.status).not.toHaveBeenCalled();
    unmount();
    render(
      <Shell
        session={{ ...cashier, role: 'ADMIN' }}
        shopName="Bengkel"
        onLoggedOut={vi.fn()}
      />,
    );
    expect(
      await screen.findByTestId('backup-failure-banner'),
    ).toBeInTheDocument();
  });
});
