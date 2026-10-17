import { resolveNumberLocale } from '@/shared/number-format';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { requireAdmin, requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import { DraftRepository } from '@/main/features/drafts/repository';
import { PaymentRepository } from '@/main/features/invoices/payments-repository';
import { InvoiceRepository } from '@/main/features/invoices/repository';
import {
  loadInvoiceView,
  type InvoiceViewDeps,
} from '@/main/features/invoices/view';
import { readLogoDataUrl } from '@/main/features/settings/logo';
import { SettingsRepository } from '@/main/features/settings/repository';
import type { Logger } from '@/main/platform/logger';
import type {
  ExportPdfInput,
  InvoicePrintModel,
  PrintFormat,
  PrintInput,
  PrintOptionsDto,
  PrintOutcomeDto,
  PrintPageInfo,
  PrintPreviewDto,
  PrintSettingsData,
  PrintSettingsDto,
  PrinterDto,
} from '@/shared/contracts';
import { DomainError, type Instant } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import type {
  FileDialogs,
  PrintDriver,
  PrintDriverResult,
  PrintJobOptions,
} from './driver';
import { toInvoicePrintModel } from './model';
import { PrintingRepository } from './repository';
import { pageInfoFor, renderInvoiceHtml } from './templates';

export interface PrintingServiceDeps {
  db: AppDatabase;
  clock: Clock;
  driver: PrintDriver;
  dialogs: FileDialogs;
  /** `userData/assets`: content-addressed logo files. */
  assetsDir: string;
  logger: Logger;
  systemNumberLocale?: string;
}

export interface RenderedInvoice {
  model: InvoicePrintModel;
  html: string;
  pageInfo: PrintPageInfo;
}

/** A print attempt's result; failures are outcomes, never thrown. */
export type PrintAttemptOutcome = Pick<
  PrintOutcomeDto,
  'outcome' | 'code' | 'params'
>;
type Outcome = PrintAttemptOutcome;

/**
 * Invoice printing (spec 30, 31). Reads committed invoices only and never
 * writes business state: its only writes are the print_jobs log and audit
 * rows, each in its own short transaction AFTER the driver finished. No
 * transaction is ever held across the (asynchronous) driver or dialogs.
 *
 * Printer choice: a configured printer that is present prints silently to
 * it; none configured shows the OS dialog; a configured printer that is
 * missing is PRINTER_NOT_FOUND and nothing is sent to any other device.
 */
export class PrintingService {
  private readonly repo: PrintingRepository;
  private readonly settings: SettingsRepository;
  private readonly viewDeps: InvoiceViewDeps;

  constructor(private readonly deps: PrintingServiceDeps) {
    const { db } = deps;
    this.repo = new PrintingRepository(db);
    this.settings = new SettingsRepository(db);
    this.viewDeps = {
      drafts: new DraftRepository(db),
      invoices: new InvoiceRepository(db),
      payments: new PaymentRepository(db),
    };
  }

  // ---- the model and its presentations (internal, read-only) ----

  /**
   * The print model of an issued invoice: its snapshots plus the current
   * payment history, the shop language/timezone and the reprint marking,
   * read in one consistent snapshot. INVOICE_NOT_FOUND for drafts.
   */
  buildInvoicePrintModel(invoiceId: string): InvoicePrintModel {
    return this.deps.db.transaction(() => {
      const view = loadInvoiceView(this.viewDeps, invoiceId);
      if (!view) {
        throw new DomainError('INVOICE_NOT_FOUND', 'Invoice not found');
      }
      return toInvoicePrintModel(view, {
        language: this.settings.language(),
        timezone: this.settings.getShop().timezone,
        isReprint: this.repo.hasPrinted(invoiceId),
      });
    })();
  }

  /** The one HTML document that preview, print and PDF share. */
  renderInvoice(
    invoiceId: string,
    format: PrintFormat,
    session?: Session,
  ): RenderedInvoice {
    const model = this.buildInvoicePrintModel(invoiceId);
    const html = renderInvoiceHtml(model, format, {
      logoDataUrl: this.logoDataUrl(model),
      numberLocale: resolveNumberLocale(
        session?.numberFormat,
        this.deps.systemNumberLocale,
      ),
    });
    return { model, html, pageInfo: pageInfoFor(format) };
  }

  // ---- commands ----

  preview(session: Session | undefined, input: PrintInput): PrintPreviewDto {
    const actor = requireSession(session);
    const { html, pageInfo } = this.renderInvoice(
      input.invoiceId,
      input.format,
      actor,
    );
    return { html, format: input.format, pageInfo };
  }

  async print(
    session: Session | undefined,
    input: PrintInput,
  ): Promise<PrintOutcomeDto> {
    const actor = requireSession(session);
    const requestedAt = this.deps.clock.now();
    const { model, html } = this.renderInvoice(
      input.invoiceId,
      input.format,
      actor,
    );
    const outcome = await this.sendDocument(html, input.format);
    this.record(actor.cashierId, model, {
      format: input.format,
      action: 'PRINT',
      requestedAt,
      outcome,
    });
    return { ...outcome, format: input.format, isReprint: model.isReprint };
  }

  /** A4 only: a native save dialog in main, then the PDF file. */
  async exportPdf(
    session: Session | undefined,
    input: ExportPdfInput,
  ): Promise<PrintOutcomeDto> {
    const actor = requireSession(session);
    const requestedAt = this.deps.clock.now();
    const format: PrintFormat = 'A4';
    const { model, html } = this.renderInvoice(input.invoiceId, format, actor);
    const target = await this.deps.dialogs.choosePdfDestination(
      `${model.invoiceNumber}.pdf`,
    );
    let outcome: Outcome = { outcome: 'CANCELLED' };
    if (target !== null) {
      try {
        const bytes = await this.deps.driver.printToPdf(html, format);
        await fs.writeFile(target, bytes);
        outcome = { outcome: 'PRINTED' };
      } catch (error) {
        this.deps.logger.warn('printing.pdf_failed', { error });
        outcome = { outcome: 'FAILED', code: 'PDF_FAILED' };
      }
    }
    this.record(actor.cashierId, model, {
      format,
      action: 'PDF_EXPORT',
      requestedAt,
      outcome,
    });
    return {
      ...outcome,
      format,
      isReprint: model.isReprint,
      ...(outcome.outcome === 'PRINTED' && target
        ? { fileName: path.basename(target) }
        : {}),
    };
  }

  // ---- settings ----

  /** What any cashier needs to offer printing (no printer names). */
  getOptions(session: Session | undefined): PrintOptionsDto {
    requireSession(session);
    const settings = this.repo.settings();
    return {
      defaultInvoiceFormat: settings.defaultInvoiceFormat,
      thermalFormat:
        settings.thermalPaperWidthMm === 80 ? 'THERMAL_80' : 'THERMAL_58',
      autoPrintAfterFinalize: settings.autoPrintAfterFinalize,
    };
  }

  getSettings(session: Session | undefined): PrintSettingsDto {
    requireAdmin(session);
    return this.repo.settings();
  }

  updateSettings(
    session: Session | undefined,
    input: PrintSettingsData,
  ): PrintSettingsDto {
    const actor = requireAdmin(session);
    withWriteTransaction(this.deps.db, () => {
      const before = this.repo.settings();
      this.repo.updateSettings(input);
      appendAudit(this.deps.db, this.deps.clock, {
        cashierId: actor.cashierId,
        action: 'PRINT_SETTINGS_UPDATED',
        entityType: 'settings',
        entityId: '1',
        metadata: { before, after: this.repo.settings() },
      });
    });
    return this.repo.settings();
  }

  async listPrinters(session: Session | undefined): Promise<PrinterDto[]> {
    requireAdmin(session);
    const printers = await this.deps.driver.listPrinters();
    return printers.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      isDefault: p.isDefault,
    }));
  }

  // ---- internals ----

  private configuredPrinter(format: PrintFormat): string | null {
    const settings = this.repo.settings();
    return format === 'A4'
      ? settings.defaultA4PrinterName
      : settings.defaultThermalPrinterName;
  }

  /**
   * Chooses the device for `format` and prints a finished document (also
   * used by the daily report, T13). A configured printer that is present
   * prints silently; none configured shows the OS dialog; configured but
   * missing is PRINTER_NOT_FOUND with nothing sent anywhere. Never throws:
   * failures are outcomes. Writes nothing.
   */
  async sendDocument(html: string, format: PrintFormat): Promise<Outcome> {
    const printerName = this.configuredPrinter(format);
    if (printerName === null) {
      return this.drive(html, { format, silent: false });
    }
    let present: boolean;
    try {
      const printers = await this.deps.driver.listPrinters();
      present = printers.some((p) => p.name === printerName);
    } catch (error) {
      this.deps.logger.warn('printing.list_failed', { error });
      return { outcome: 'FAILED', code: 'PRINT_FAILED' };
    }
    if (!present) {
      // Never redirect to another printer.
      return {
        outcome: 'FAILED',
        code: 'PRINTER_NOT_FOUND',
        params: { printerName },
      };
    }
    return this.drive(html, { format, deviceName: printerName, silent: true });
  }

  private async drive(
    html: string,
    options: PrintJobOptions,
  ): Promise<Outcome> {
    let result: PrintDriverResult;
    try {
      result = await this.deps.driver.print(html, options);
    } catch (error) {
      this.deps.logger.warn('printing.failed', {
        format: options.format,
        error,
      });
      return { outcome: 'FAILED', code: 'PRINT_FAILED' };
    }
    if (result.outcome === 'FAILED' && result.code === 'PRINT_TIMEOUT') {
      this.deps.logger.warn('printing.timeout', {
        format: options.format,
        silent: options.silent,
      });
    }
    return result.outcome === 'FAILED'
      ? { outcome: 'FAILED', code: result.code }
      : { outcome: result.outcome };
  }

  /**
   * Logs the attempt (and audits a successful print, reprint or export) in
   * its own transaction. A failure here is logged, never surfaced: the
   * paper is already out and business state was never involved.
   */
  private record(
    cashierId: string,
    model: InvoicePrintModel,
    job: {
      format: PrintFormat;
      action: 'PRINT' | 'PDF_EXPORT';
      requestedAt: Instant;
      outcome: Outcome;
    },
  ): void {
    try {
      withWriteTransaction(this.deps.db, () => {
        this.repo.insertJob({
          invoiceId: model.invoiceId,
          format: job.format,
          action: job.action,
          requestedBy: cashierId,
          requestedAt: job.requestedAt,
          outcome: job.outcome.outcome,
          errorCode: job.outcome.code ?? null,
          isReprint: model.isReprint,
        });
        if (job.outcome.outcome !== 'PRINTED') return;
        appendAudit(this.deps.db, this.deps.clock, {
          cashierId,
          action:
            job.action === 'PDF_EXPORT'
              ? 'INVOICE_PDF_EXPORTED'
              : model.isReprint
                ? 'INVOICE_REPRINTED'
                : 'INVOICE_PRINTED',
          entityType: 'invoice',
          entityId: model.invoiceId,
          metadata: {
            invoiceId: model.invoiceId,
            invoiceNumber: model.invoiceNumber,
            format: job.format,
            isReprint: model.isReprint,
          },
        });
      });
    } catch (error) {
      this.deps.logger.error('printing.record_failed', { error });
    }
  }

  private logoDataUrl(model: InvoicePrintModel): string | null {
    const asset = model.shop.logo;
    if (asset === null) return null;
    const dataUrl = readLogoDataUrl(this.deps.assetsDir, asset);
    if (dataUrl === null) {
      this.deps.logger.warn('printing.logo_missing', { asset });
    }
    return dataUrl;
  }
}
