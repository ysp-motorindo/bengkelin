import { z } from 'zod';
import type { Instant } from '../primitives';
import { uuidSchema, type UUID } from './common';

/**
 * Validated local backups (spec 42, 43, 46; Part A `backups.create`).
 *
 * A backup is SQLite's online backup of the live database, validated before
 * it is given its final name. ADMIN only (spec 55). The renderer never
 * supplies a path: the destination folder is chosen in a native dialog in
 * main.
 */

export const BACKUP_KINDS = ['AUTO', 'MANUAL', 'SAFETY'] as const;
/**
 * AUTO: the daily automatic backup (the only kind retention prunes).
 * MANUAL: "Backup now" by an ADMIN. SAFETY: taken by the app before a risky
 * operation (catalog import, restore).
 */
export type BackupKind = (typeof BACKUP_KINDS)[number];

/** Failures of `createValidatedBackup` (recoverable operational errors). */
export type BackupErrorCode =
  | 'BACKUP_DESTINATION_UNAVAILABLE'
  | 'BACKUP_DESTINATION_READ_ONLY'
  | 'BACKUP_WRITE_FAILED'
  | 'BACKUP_VALIDATION_FAILED';

/** Why `validateBackup` rejected a file, in the order the checks run. */
export type BackupValidationCode =
  | 'BACKUP_NOT_FOUND'
  | 'NOT_SQLITE'
  | 'CORRUPT_DATABASE'
  | 'FOREIGN_DATABASE'
  | 'UNSUPPORTED_SCHEMA'
  | 'MISSING_TABLES';

export interface BackupValidation {
  ok: boolean;
  /** `PRAGMA application_id`; null when the file could not be read as SQLite. */
  applicationId: number | null;
  /** `PRAGMA user_version`; null when the file could not be read as SQLite. */
  schemaVersion: number | null;
  error?: BackupValidationCode;
}

export interface BackupSummary {
  kind: BackupKind;
  /** The final file name inside the destination folder. */
  fileName: string;
  /** Bytes. */
  size: number;
  createdAt: Instant;
  schemaVersion: number;
  applicationId: number;
}

export interface BackupRunDto {
  kind: BackupKind;
  outcome: 'SUCCEEDED' | 'FAILED';
  startedAt: Instant;
  finishedAt: Instant;
  fileName: string | null;
  errorCode: string | null;
}

/** Shown to ADMIN until a later backup succeeds. */
export interface BackupNoticeDto {
  errorCode: string;
  failedAt: Instant;
}

export interface BackupStatusDto {
  /** Where the next backup is written (shown to ADMIN, never sent back). */
  destination: { path: string; isDefault: boolean };
  lastAutomatic: BackupRunDto | null;
  lastSuccessfulAutomatic: BackupRunDto | null;
  /** Most recent first (all kinds). */
  recentRuns: BackupRunDto[];
  /** When the next automatic backup is due (now when it is due already). */
  nextAutomaticAt: Instant;
  notice: BackupNoticeDto | null;
}

export interface BackupDestinationChoiceDto {
  outcome: 'UPDATED' | 'CANCELLED';
  status: BackupStatusDto;
}

// ---- restore (spec 43; Part A backups.inspectRestore / backups.restore) ----

/**
 * The phrase an ADMIN types before the Restore button is enabled
 * (deliberate confirmation). The service itself requires `confirmed: true`.
 */
export const RESTORE_CONFIRMATION_PHRASES = {
  id: 'PULIHKAN',
  en: 'RESTORE',
} as const;

export const restoreInputSchema = z.strictObject({
  token: uuidSchema,
  confirmed: z.literal(true, 'validation.invalid'),
});
export type RestoreInput = z.infer<typeof restoreInputSchema>;

export const cancelRestoreInputSchema = z.strictObject({ token: uuidSchema });
export type CancelRestoreInput = z.infer<typeof cancelRestoreInputSchema>;

export interface RestoreCountsDto {
  /** Discarded drafts are not counted. */
  invoices: { draft: number; finalized: number; void: number };
  catalogItems: number;
  customers: number;
  cashiers: number;
}

/** What the staged (validated, migrated) copy of the selected file holds. */
export interface RestorePreviewDto {
  /** Opaque, single use; expires at `expiresAt`. */
  token: UUID;
  expiresAt: Instant;
  sourceFileName: string;
  /** Bytes. */
  sourceSize: number;
  /** Schema version of the selected file ... */
  originalSchemaVersion: number;
  /** ... and after migration (the application's current version). */
  schemaVersion: number;
  shopName: string;
  counts: RestoreCountsDto;
  latestFinalizedAt: Instant | null;
  /** Always at least 1 (otherwise RESTORE_NO_ACTIVE_ADMIN). */
  activeAdmins: number;
}

export type RestoreInspectionDto =
  | { outcome: 'CANCELLED' }
  | { outcome: 'READY'; preview: RestorePreviewDto };

/** The database was replaced; the application restarts to the login screen. */
export interface RestoreStartedDto {
  restarting: true;
  safetyBackupFileName: string;
}
