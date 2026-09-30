import type {
  ExportPdfInput,
  PrintInput,
  PrintOptionsDto,
  PrintOutcomeDto,
  PrintPreviewDto,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';

/**
 * What the print actions need from main. Screens take it as a prop so tests
 * can pass a fake; the default goes through the preload bridge.
 */
export interface PrintClient {
  getOptions(): Promise<Result<PrintOptionsDto>>;
  preview(input: PrintInput): Promise<Result<PrintPreviewDto>>;
  print(input: PrintInput): Promise<Result<PrintOutcomeDto>>;
  exportPdf(input: ExportPdfInput): Promise<Result<PrintOutcomeDto>>;
}

export const bridgePrintClient: PrintClient = {
  getOptions: async () => window.bengkelin.printing.getOptions(),
  preview: async (input) => window.bengkelin.printing.preview(input),
  print: async (input) => window.bengkelin.printing.print(input),
  exportPdf: async (input) => window.bengkelin.printing.exportPdf(input),
};
