import fs from 'node:fs/promises';
import path from 'node:path';
import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type { FileDialogs } from '@/main/features/printing/driver';
import type { PrintingService } from '@/main/features/printing/service';
import { SettingsRepository } from '@/main/features/settings/repository';
import type { Logger } from '@/main/platform/logger';
import type {
  DailyReport,
  DailyReportData,
  Language,
  ReportOutcomeDto,
  ReportPreviewDto,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import { businessDayRange, type Clock } from '@/shared/time';
import { dailyReportCsv } from './csv';
import { REPORT_LABELS, type ReportLabels } from './labels';
import { toDailyReport } from './report';
import { ReportRepository, type ReportFilters } from './repository';
import { REPORT_PAGE_INFO, renderDailyReportHtml } from './template';

export interface ReportServiceDeps {
  db: AppDatabase;
  clock: Clock;
  /** Printer selection and the print driver (T12). */
  printing: PrintingService;
  dialogs: FileDialogs;
  logger: Logger;
}

/** One report plus everything its presentations need, read together. */
interface ReportSnapshot {
  report: DailyReport;
  language: Language;
  labels: ReportLabels;
  shopName: string;
}

/**
 * Daily report (spec 33). Any signed-in cashier may view, export and print
 * it (ruling: spec 55 does not reserve reports for ADMIN). Reading writes
 * nothing; a CSV export or a print is audited once it succeeded. The screen
 * DTO, the CSV and the printed document are all rendered from the SAME
 * `DailyReport` built by `snapshot()`.
 */
export class ReportService {
  private readonly repo: ReportRepository;
  private readonly settings: SettingsRepository;

  constructor(private readonly deps: ReportServiceDeps) {
    this.repo = new ReportRepository(deps.db);
    this.settings = new SettingsRepository(deps.db);
  }

  daily(session: Session | undefined, input: DailyReportData): DailyReport {
    requireSession(session);
    return this.snapshot(input).report;
  }

  preview(
    session: Session | undefined,
    input: DailyReportData,
  ): ReportPreviewDto {
    requireSession(session);
    return {
      html: this.render(this.snapshot(input)),
      pageInfo: REPORT_PAGE_INFO,
    };
  }

  /** A4 through the invoice printer rules (T12); never redirected. */
  async print(
    session: Session | undefined,
    input: DailyReportData,
  ): Promise<ReportOutcomeDto> {
    const actor = requireSession(session);
    const snapshot = this.snapshot(input);
    const outcome = await this.deps.printing.sendDocument(
      this.render(snapshot),
      'A4',
    );
    if (outcome.outcome === 'PRINTED') {
      this.audit(actor.cashierId, 'DAILY_REPORT_PRINTED', snapshot.report);
    }
    return outcome;
  }

  /** CSV through a native save dialog in main; the renderer sends no path. */
  async exportCsv(
    session: Session | undefined,
    input: DailyReportData,
  ): Promise<ReportOutcomeDto> {
    const actor = requireSession(session);
    const snapshot = this.snapshot(input);
    const text = dailyReportCsv(snapshot.report, snapshot.labels);
    const target = await this.deps.dialogs.chooseCsvDestination(
      snapshot.labels.fileName(snapshot.report.date),
    );
    if (target === null) return { outcome: 'CANCELLED' };
    try {
      await fs.writeFile(target, text, 'utf8');
    } catch (error) {
      this.deps.logger.warn('reports.csv_failed', { error });
      return { outcome: 'FAILED', code: 'EXPORT_FAILED' };
    }
    const fileName = path.basename(target);
    this.audit(actor.cashierId, 'DAILY_REPORT_EXPORTED', snapshot.report, {
      fileName,
    });
    return { outcome: 'PRINTED', fileName };
  }

  // ---- internals ----

  /**
   * The report and its context in ONE read transaction (a consistent
   * snapshot): the shop timezone decides the day's instants, so a timezone
   * change applies to every later query.
   */
  private snapshot(input: DailyReportData): ReportSnapshot {
    const generatedAt = this.deps.clock.now();
    return this.deps.db.transaction((): ReportSnapshot => {
      const shop = this.settings.getShop();
      const language = this.settings.language();
      const range = businessDayRange(input.date, shop.timezone);
      const filters: ReportFilters = {
        cashierId: input.cashierId,
        channelId: input.channelId,
      };
      const report = toDailyReport(
        {
          date: input.date,
          timezone: shop.timezone,
          range,
          generatedAt,
          filters: {
            cashier: input.cashierId
              ? {
                  id: input.cashierId,
                  displayName: this.required(
                    this.repo.cashierName(input.cashierId),
                    'CASHIER_NOT_FOUND',
                  ),
                }
              : null,
            channel: input.channelId
              ? {
                  id: input.channelId,
                  label: this.required(
                    this.repo.channelLabel(input.channelId),
                    'CHANNEL_NOT_FOUND',
                  ),
                }
              : null,
          },
        },
        {
          sales: this.repo.sales(range, filters),
          voids: this.repo.voids(range, filters),
          payments: this.repo.paymentsByMethod(range, filters),
        },
      );
      return {
        report,
        language,
        labels: REPORT_LABELS[language],
        shopName: shop.name,
      };
    })();
  }

  private required(value: string | null, code: string): string {
    if (value === null) throw new DomainError(code, code);
    return value;
  }

  private render(snapshot: ReportSnapshot): string {
    return renderDailyReportHtml(snapshot.report, {
      language: snapshot.language,
      labels: snapshot.labels,
      shopName: snapshot.shopName,
    });
  }

  /**
   * Audits a finished export/print in its own short transaction. The file
   * or paper already exists, so a failure here is logged, never surfaced.
   */
  private audit(
    cashierId: string,
    action: 'DAILY_REPORT_EXPORTED' | 'DAILY_REPORT_PRINTED',
    report: DailyReport,
    extra: Record<string, unknown> = {},
  ): void {
    try {
      withWriteTransaction(this.deps.db, () =>
        appendAudit(this.deps.db, this.deps.clock, {
          cashierId,
          action,
          entityType: 'daily_report',
          entityId: report.date,
          metadata: {
            date: report.date,
            timezone: report.timezone,
            cashierId: report.filters.cashier?.id ?? null,
            channelId: report.filters.channel?.id ?? null,
            ...extra,
          },
        }),
      );
    } catch (error) {
      this.deps.logger.error('reports.audit_failed', { action, error });
    }
  }
}
