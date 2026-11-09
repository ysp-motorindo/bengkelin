import { z } from 'zod';
import { uuidSchema } from './common';
import type { ImportRowAction } from './catalog-transfer';
export const commitSupplierImportInputSchema = z.strictObject({
  token: uuidSchema,
  acknowledgeDuplicatePhones: z.boolean('validation.invalid').optional(),
});
export type CommitSupplierImportInput = z.infer<
  typeof commitSupplierImportInputSchema
>;
export interface SupplierImportIssueDto {
  row: number | null;
  column: string | null;
  externalId: string | null;
  error: { code: string; messageKey: string; params?: Record<string, string> };
}
export interface SupplierImportRowDto {
  row: number;
  externalId: string;
  name: string | null;
  action: ImportRowAction;
  openingAction: 'CREATE' | 'UNCHANGED' | 'SKIPPED' | 'INVALID';
  asOfDate: string | null;
  openingBalance: string | null;
  changedFields: string[];
}
export interface SupplierContactCounts {
  creates: number;
  updates: number;
  unchanged: number;
}
export interface SupplierImportCounts {
  suppliers: SupplierContactCounts;
  openings: { creates: number; unchanged: number; skipped: number };
}
export interface SupplierImportReadyDto {
  outcome: 'READY';
  token: string;
  expiresAt: string;
  fileName: string;
  summary: SupplierImportCounts;
  totalOpeningAmount: string;
  totalRows: number;
  rows: SupplierImportRowDto[];
  rowsTruncated: boolean;
  errors: SupplierImportIssueDto[];
  errorCount: number;
  warnings: SupplierImportIssueDto[];
  warningCount: number;
  requiresDuplicatePhoneAcknowledgement: boolean;
  canCommit: boolean;
}
export type SupplierImportPreviewDto =
  | { outcome: 'CANCELLED' }
  | SupplierImportReadyDto;
export interface SupplierImportSummaryDto extends SupplierImportCounts {
  totalOpeningAmount: string;
  importedAt: string;
  fileName: string;
  backupFileName: string;
}
