import { z } from 'zod';
import { uuidSchema } from './common';
import type { ImportRowAction } from './catalog-transfer';
export const commitCustomerImportInputSchema = z.strictObject({
  token: uuidSchema,
  acknowledgeDuplicatePhones: z.boolean('validation.invalid').optional(),
});
export type CommitCustomerImportInput = z.infer<
  typeof commitCustomerImportInputSchema
>;
export interface CustomerImportIssueDto {
  row: number | null;
  column: string | null;
  externalId: string | null;
  error: { code: string; messageKey: string; params?: Record<string, string> };
}
export interface CustomerImportRowDto {
  row: number;
  externalId: string;
  name: string | null;
  action: ImportRowAction;
  changedFields: string[];
}
export interface CustomerImportCounts {
  creates: number;
  updates: number;
  unchanged: number;
}
export interface CustomerImportReadyDto {
  outcome: 'READY';
  token: string;
  expiresAt: string;
  fileName: string;
  summary: CustomerImportCounts;
  totalRows: number;
  rows: CustomerImportRowDto[];
  rowsTruncated: boolean;
  errors: CustomerImportIssueDto[];
  errorCount: number;
  warnings: CustomerImportIssueDto[];
  warningCount: number;
  requiresDuplicatePhoneAcknowledgement: boolean;
  canCommit: boolean;
}
export type CustomerImportPreviewDto =
  | { outcome: 'CANCELLED' }
  | CustomerImportReadyDto;
export interface CustomerImportSummaryDto extends CustomerImportCounts {
  importedAt: string;
  fileName: string;
  backupFileName: string;
}
