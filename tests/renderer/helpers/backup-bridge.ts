import { vi } from 'vitest';
import type { BackupStatusDto, BackupSummary } from '@/shared/contracts';

const ok = <T>(value: T) => ({ ok: true as const, value });

export function backupStatus(
  overrides: Partial<BackupStatusDto> = {},
): BackupStatusDto {
  return {
    destination: { path: '/data/bengkelin/backups', isDefault: true },
    lastAutomatic: null,
    lastSuccessfulAutomatic: null,
    recentRuns: [],
    nextAutomaticAt: '2026-09-30T03:00:00.000Z',
    notice: null,
    ...overrides,
  };
}

export const MANUAL_SUMMARY: BackupSummary = {
  kind: 'MANUAL',
  fileName: 'bengkelin-manual-20260930-100000.sqlite',
  size: 409600,
  createdAt: '2026-09-30T03:00:00.000Z',
  schemaVersion: 11,
  applicationId: 0x424b4c4e,
};

/** `window.bengkelin.backups` with a healthy default status. */
export function backupBridge(
  status: BackupStatusDto = backupStatus(),
  create: () => Promise<unknown> = async () => ok(MANUAL_SUMMARY),
) {
  return {
    status: vi.fn(async () => ok(status)),
    create: vi.fn(create),
    chooseDestination: vi.fn(async () => ok({ outcome: 'CANCELLED', status })),
  };
}
