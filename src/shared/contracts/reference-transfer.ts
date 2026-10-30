import { z } from 'zod';
import { uuidSchema } from './common';
import type { ImportRowAction } from './catalog-transfer';
export const commitReferenceImportInputSchema = z.strictObject({
  token: uuidSchema,
});
export type CommitReferenceImportInput = z.infer<
  typeof commitReferenceImportInputSchema
>;
export interface ReferenceImportIssueDto {
  row: number | null;
  column: string | null;
  code: string | null;
  error: { code: string; messageKey: string; params?: Record<string, string> };
}
export interface ReferenceImportRowDto {
  row: number;
  code: string;
  name: string | null;
  action: ImportRowAction;
  changedFields: string[];
}
export interface ReferenceImportCounts {
  creates: number;
  updates: number;
  unchanged: number;
}
export interface ReferenceImportReadyDto {
  outcome: 'READY';
  token: string;
  expiresAt: string;
  fileName: string;
  summary: ReferenceImportCounts;
  totalRows: number;
  rows: ReferenceImportRowDto[];
  rowsTruncated: boolean;
  errors: ReferenceImportIssueDto[];
  errorCount: number;
  warnings: ReferenceImportIssueDto[];
  warningCount: number;
  canCommit: boolean;
}
export type ReferenceImportPreviewDto =
  | { outcome: 'CANCELLED' }
  | ReferenceImportReadyDto;
export interface ReferenceImportSummaryDto extends ReferenceImportCounts {
  importedAt: string;
  fileName: string;
  backupFileName: string;
}

export const referenceTransferInputSchema = z.strictObject({
  entity: z.enum(['sales', 'expedition']),
});
export type ReferenceTransferInput = z.infer<
  typeof referenceTransferInputSchema
>;
export type ReferenceImportEntity = ReferenceTransferInput['entity'];
