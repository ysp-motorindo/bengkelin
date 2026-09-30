import type { AppDatabase } from '@/main/database/connection';
import { bool, flag, toNumber } from '@/main/database/rows';
import type {
  InvoiceFormat,
  PrintFormat,
  PrintOutcome,
  PrintSettingsData,
  PrintSettingsDto,
} from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';

interface PrintSettingsRow {
  default_invoice_format: InvoiceFormat;
  thermal_paper_width_mm: bigint | null;
  default_a4_printer_name: string | null;
  default_thermal_printer_name: string | null;
  auto_print_after_finalize: bigint;
}

export interface PrintJobRow {
  invoiceId: string;
  format: PrintFormat;
  action: 'PRINT' | 'PDF_EXPORT';
  requestedBy: string;
  requestedAt: Instant;
  outcome: PrintOutcome;
  errorCode: string | null;
  isReprint: boolean;
}

/** Print settings on the settings row (spec 31) and the print_jobs log. */
export class PrintingRepository {
  constructor(private readonly db: AppDatabase) {}

  settings(): PrintSettingsDto {
    const row = this.db
      .prepare(
        `SELECT default_invoice_format, thermal_paper_width_mm, default_a4_printer_name,
                default_thermal_printer_name, auto_print_after_finalize
           FROM settings WHERE id = 1`,
      )
      .get() as PrintSettingsRow;
    return {
      defaultInvoiceFormat: row.default_invoice_format,
      // NULL (never configured) is the 58 mm default (Part A).
      thermalPaperWidthMm:
        row.thermal_paper_width_mm === null
          ? 58
          : (toNumber(row.thermal_paper_width_mm) as 58 | 80),
      defaultA4PrinterName: row.default_a4_printer_name,
      defaultThermalPrinterName: row.default_thermal_printer_name,
      autoPrintAfterFinalize: bool(row.auto_print_after_finalize),
    };
  }

  updateSettings(data: PrintSettingsData): void {
    this.db
      .prepare(
        `UPDATE settings SET default_invoice_format = ?, thermal_paper_width_mm = ?,
           default_a4_printer_name = ?, default_thermal_printer_name = ?,
           auto_print_after_finalize = ?
         WHERE id = 1`,
      )
      .run(
        data.defaultInvoiceFormat,
        BigInt(data.thermalPaperWidthMm),
        data.defaultA4PrinterName,
        data.defaultThermalPrinterName,
        flag(data.autoPrintAfterFinalize),
      );
  }

  /** A PRINTED print (not a PDF export) exists: the next one is a reprint. */
  hasPrinted(invoiceId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM print_jobs
            WHERE invoice_id = ? AND action = 'PRINT' AND outcome = 'PRINTED' LIMIT 1`,
        )
        .get(invoiceId) !== undefined
    );
  }

  insertJob(job: PrintJobRow): void {
    this.db
      .prepare(
        `INSERT INTO print_jobs (invoice_id, format, action, requested_by, requested_at,
           outcome, error_code, is_reprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.invoiceId,
        job.format,
        job.action,
        job.requestedBy,
        job.requestedAt,
        job.outcome,
        job.errorCode,
        flag(job.isReprint),
      );
  }
}
