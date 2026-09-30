import type {
  FileDialogs,
  PrintDriver,
  PrintDriverResult,
  PrintJobOptions,
  PrinterInfo,
} from '@/main/features/printing/driver';
import type { PrintFormat } from '@/shared/contracts';

/** Records every call; results are queued per test (default: PRINTED). */
export class FakePrintDriver implements PrintDriver {
  printers: PrinterInfo[] = [];
  printCalls: { html: string; options: PrintJobOptions }[] = [];
  pdfCalls: { html: string; format: PrintFormat }[] = [];
  listCalls = 0;
  private queue: (PrintDriverResult | Error)[] = [];
  pdfBytes: Uint8Array = new TextEncoder().encode('%PDF-1.7 fake\n');

  /** The next print() results, in order. */
  willReturn(...results: (PrintDriverResult | Error)[]): void {
    this.queue.push(...results);
  }

  async listPrinters(): Promise<PrinterInfo[]> {
    this.listCalls += 1;
    return this.printers.map((p) => ({ ...p }));
  }

  async print(
    html: string,
    options: PrintJobOptions,
  ): Promise<PrintDriverResult> {
    this.printCalls.push({ html, options });
    const next = this.queue.shift() ?? { outcome: 'PRINTED' };
    if (next instanceof Error) throw next;
    return next;
  }

  async printToPdf(html: string, format: PrintFormat): Promise<Uint8Array> {
    this.pdfCalls.push({ html, format });
    return this.pdfBytes;
  }
}

/** Native dialogs replaced by queued answers (null = the user cancelled). */
export class FakeDialogs implements FileDialogs {
  openAnswers: (string | null)[] = [];
  saveAnswers: (string | null)[] = [];
  csvAnswers: (string | null)[] = [];
  openCalls = 0;
  saveCalls: string[] = [];
  csvCalls: string[] = [];

  async chooseImage(): Promise<string | null> {
    this.openCalls += 1;
    return this.openAnswers.shift() ?? null;
  }

  async choosePdfDestination(defaultFileName: string): Promise<string | null> {
    this.saveCalls.push(defaultFileName);
    return this.saveAnswers.shift() ?? null;
  }

  async chooseCsvDestination(defaultFileName: string): Promise<string | null> {
    this.csvCalls.push(defaultFileName);
    return this.csvAnswers.shift() ?? null;
  }
}
