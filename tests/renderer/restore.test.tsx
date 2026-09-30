import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from 'i18next';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RestoreSection } from '@/renderer/features/backups/RestoreSection';
import { registerFlusher } from '@/renderer/lib/flush-registry';
import type { RestorePreviewDto } from '@/shared/contracts';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const fail = (code: string) => ({
  ok: false as const,
  error: { code, messageKey: `errors.${code}` },
});

const PREVIEW: RestorePreviewDto = {
  token: '11111111-1111-4111-8111-111111111111',
  expiresAt: '2026-09-30T03:15:00.000Z',
  sourceFileName: 'bengkelin-manual-20260929-170000.sqlite',
  sourceSize: 409_600,
  originalSchemaVersion: 10,
  schemaVersion: 11,
  shopName: 'Bengkel Maju Jaya Motor',
  counts: {
    invoices: { draft: 1, finalized: 12, void: 2 },
    catalogItems: 40,
    customers: 9,
    cashiers: 3,
  },
  latestFinalizedAt: '2026-09-29T09:30:00.000Z',
  activeAdmins: 1,
};

function install(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const backups = {
    inspectRestore: vi.fn(async () =>
      ok({ outcome: 'READY' as const, preview: PREVIEW }),
    ),
    restore: vi.fn(async () => {
      calls.push('restore');
      return ok({
        restarting: true as const,
        safetyBackupFileName: 'bengkelin-safety-20260930-100000.sqlite',
      });
    }),
    cancelRestore: vi.fn(async () => ok(undefined)),
    ...overrides,
  };
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    settings: {
      getShop: vi.fn(async () => ok({ timezone: 'Asia/Jakarta' })),
    },
    backups,
  };
  return { backups, calls };
}

let unregister: (() => void) | undefined;
afterEach(async () => {
  unregister?.();
  unregister = undefined;
  await i18n.changeLanguage('id');
});

async function openPreview() {
  await userEvent.click(
    screen.getByRole('button', { name: 'Pilih file cadangan...' }),
  );
  return screen.findByTestId('restore-preview');
}

describe('Settings restore section', () => {
  test('previews the backup and restores only after the phrase and a flush', async () => {
    const { backups, calls } = install();
    unregister = registerFlusher(async () => {
      calls.push('flush');
      return true;
    });
    render(<RestoreSection />);
    const preview = await openPreview();

    expect(preview).toHaveTextContent(
      'Pratinjau cadangan: bengkelin-manual-20260929-170000.sqlite',
    );
    expect(preview).toHaveTextContent('Bengkel Maju Jaya Motor');
    expect(screen.getByTestId('restore-schema')).toHaveTextContent(
      '10 (akan diperbarui ke 11)',
    );
    expect(screen.getByTestId('restore-invoices')).toHaveTextContent(
      '12 final, 2 batal, 1 draf',
    );
    expect(preview).toHaveTextContent('2026-09-29 16:30:00');
    expect(preview).toHaveTextContent('3 (ADMIN aktif: 1)');
    expect(screen.getByTestId('restore-warning')).toHaveTextContent(
      'Semua data saat ini akan diganti',
    );
    expect(preview).toHaveTextContent('Cadangan pengaman data saat ini');

    const button = screen.getByRole('button', { name: 'Pulihkan' });
    expect(button).toBeDisabled();
    const input = screen.getByLabelText('Ketik PULIHKAN untuk mengonfirmasi');
    await userEvent.type(input, 'pulihkan');
    expect(button).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, 'PULIHKAN');
    expect(button).toBeEnabled();

    await userEvent.click(button);
    expect(await screen.findByTestId('restore-restarting')).toHaveTextContent(
      'Database telah dipulihkan. Aplikasi dimulai ulang',
    );
    expect(calls).toEqual(['flush', 'restore']);
    expect(backups.restore).toHaveBeenCalledWith({
      token: PREVIEW.token,
      confirmed: true,
    });
    expect(screen.queryByTestId('restore-preview')).toBeNull();
  });

  test('does not restore when pending draft input cannot be flushed', async () => {
    const { backups } = install();
    unregister = registerFlusher(async () => false);
    render(<RestoreSection />);
    await openPreview();
    await userEvent.type(
      screen.getByLabelText('Ketik PULIHKAN untuk mengonfirmasi'),
      'PULIHKAN',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Pulihkan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Perubahan draf belum tersimpan',
    );
    expect(backups.restore).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pulihkan' })).toBeEnabled();
  });

  test('cancel forgets the preview; a rejected file shows the reason', async () => {
    const { backups } = install();
    render(<RestoreSection />);
    await openPreview();
    await userEvent.click(screen.getByRole('button', { name: 'Batal' }));
    expect(backups.cancelRestore).toHaveBeenCalledWith({
      token: PREVIEW.token,
    });
    expect(screen.queryByTestId('restore-preview')).toBeNull();

    backups.inspectRestore.mockResolvedValueOnce(
      fail('UNSUPPORTED_SCHEMA') as never,
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Pilih file cadangan...' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Versi database ini tidak didukung',
    );
    expect(screen.queryByTestId('restore-preview')).toBeNull();
  });

  test('a failed restore shows the error and asks for the file again', async () => {
    install({
      restore: vi.fn(async () => fail('RESTORE_SAFETY_BACKUP_FAILED')),
    });
    render(<RestoreSection />);
    await openPreview();
    await userEvent.type(
      screen.getByLabelText('Ketik PULIHKAN untuk mengonfirmasi'),
      'PULIHKAN',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Pulihkan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cadangan pengaman gagal dibuat',
    );
    expect(screen.queryByTestId('restore-preview')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Pilih file cadangan...' }),
    ).toBeEnabled();
  });

  test('in English the phrase is RESTORE', async () => {
    await i18n.changeLanguage('en');
    install();
    render(<RestoreSection />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Choose backup file...' }),
    );
    await screen.findByTestId('restore-preview');
    await userEvent.type(
      screen.getByLabelText('Type RESTORE to confirm'),
      'RESTORE',
    );
    expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled();
  });
});
