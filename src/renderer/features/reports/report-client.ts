import type {
  DailyReport,
  DailyReportInput,
  ReportOutcomeDto,
  ReportPreviewDto,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';

/**
 * What the daily report screen needs from main. A prop so tests can pass a
 * fake; the default goes through the preload bridge (async wrappers turn a
 * missing bridge into a rejection).
 */
export interface ReportClient {
  daily(input: DailyReportInput): Promise<Result<DailyReport>>;
  preview(input: DailyReportInput): Promise<Result<ReportPreviewDto>>;
  print(input: DailyReportInput): Promise<Result<ReportOutcomeDto>>;
  exportCsv(input: DailyReportInput): Promise<Result<ReportOutcomeDto>>;
}

export const bridgeReportClient: ReportClient = {
  daily: async (input) => window.bengkelin.reports.daily(input),
  preview: async (input) => window.bengkelin.reports.preview(input),
  print: async (input) => window.bengkelin.reports.print(input),
  exportCsv: async (input) => window.bengkelin.reports.exportCsv(input),
};
