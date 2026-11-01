import type { StockLocationDto } from './references';
import { z } from 'zod';
import type { Instant, Rupiah } from '../primitives';
import { uuidSchema, type UUID } from './common';

/**
 * Catalog CSV transfer (spec 37-41; Part A `catalogTransfer.*`). ADMIN only.
 *
 * The renderer never passes a path: the file to import and the export
 * destination are chosen in native dialogs shown by main. An import is
 * previewed first (opaque, short-lived token) and committed with that token:
 * stale check, SAFETY backup, then one all-or-nothing write transaction.
 *
 * Column contract (header names are matched case-insensitively):
 *  - `sku` (required), `title`, `type` (STOCK_ITEM | SERVICE), `unit` (unit
 *    CODE), `barcode`, `barcode_2`, `barcode_3`, ... (contiguous),
 *    `price_<lowercased channel code>` per channel, `opening_stock`,
 *    `is_active` (true | false), `description`;
 *  - `current_stock` is written by the export and ignored on import.
 * An empty cell means "no change" for an existing SKU.
 */

export const exportCatalogInputSchema = z.strictObject({
  stockLocationId: uuidSchema,
});
export type ExportCatalogInput = z.infer<typeof exportCatalogInputSchema>;

export const commitImportInputSchema = z.strictObject({ token: uuidSchema });
export type CommitImportInput = z.infer<typeof commitImportInputSchema>;

/** One error or warning, located by record and column. */
export interface ImportIssueDto {
  /** CSV record number (the header is row 1); null for file-level issues. */
  row: number | null;
  /** The (normalized) header name the issue concerns, if any. */
  column: string | null;
  /** The row's SKU as written, when known. */
  sku: string | null;
  /** Same shape as a Result error: translate with `errorMessage`. */
  error: {
    code: string;
    messageKey: string;
    params?: Record<string, string>;
  };
}

export type ImportRowAction = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'INVALID';

/** Item fields an import can change on an existing SKU. */
export type ImportField =
  | 'title'
  | 'description'
  | 'type'
  | 'unit'
  | 'trackInventory'
  | 'isActive';

export interface ImportPriceChangeDto {
  channelCode: string;
  /** Price in force at the import instant; null when there is none. */
  from: Rupiah | null;
  to: Rupiah;
}

export interface ImportRowDto {
  stockLocation: StockLocationDto | null;
  row: number;
  sku: string;
  /** The title after the import (the current one when the cell is empty). */
  title: string;
  action: ImportRowAction;
  /** Existing SKUs: the fields that change. */
  changedFields: ImportField[];
  priceChanges: ImportPriceChangeDto[];
  barcodesAdded: string[];
  barcodesActivated: string[];
  /** Opening balance to record (new tracked items only). */
  openingStock: number | null;
}

export interface ImportCounts {
  creates: number;
  /** Existing SKUs with at least one change (fields, barcodes or prices). */
  updates: number;
  unchanged: number;
  /** Price points to append. */
  priceChanges: number;
  openingBalances: number;
  /** Barcodes added plus barcodes re-activated. */
  barcodeChanges: number;
}

/** A parsed and validated file, ready to commit when `canCommit`. */
export interface ImportReadyDto {
  outcome: 'READY';
  token: UUID;
  expiresAt: Instant;
  /** Base name of the chosen file (never the path). */
  fileName: string;
  summary: ImportCounts;
  totalRows: number;
  /** The first `IMPORT_ROWS_SHOWN` rows. */
  rows: ImportRowDto[];
  rowsTruncated: boolean;
  /** The first `IMPORT_ISSUES_SHOWN` of each list; the counts are exact. */
  errors: ImportIssueDto[];
  errorCount: number;
  warnings: ImportIssueDto[];
  warningCount: number;
  canCommit: boolean;
}

export type ImportPreviewDto = { outcome: 'CANCELLED' } | ImportReadyDto;

export interface ImportSummaryDto extends ImportCounts {
  /** The ONE instant every imported price point starts at. */
  importedAt: Instant;
  fileName: string;
  /** The SAFETY backup taken before the import. */
  backupFileName: string;
}

/** Export and template downloads. A write failure is an outcome. */
export type CatalogFileOutcomeDto =
  | { outcome: 'CANCELLED' }
  | { outcome: 'FAILED'; code: 'EXPORT_FAILED' }
  | {
      outcome: 'SAVED';
      fileName: string;
      /** Data rows written. */
      itemCount: number;
      /** Rows without a SKU: they need one before they can be re-imported. */
      skuMissingCount: number;
    };

export const IMPORT_ROWS_SHOWN = 500;
export const IMPORT_ISSUES_SHOWN = 500;
