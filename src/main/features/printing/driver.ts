import type { PrintFormat } from '@/shared/contracts';

/**
 * The printing boundary. The service decides WHAT to print and WHERE; a
 * driver only renders HTML to a printer or a PDF. The real driver
 * (`electron-driver.ts`) is injected by `main.ts`; tests inject a fake.
 */

export interface PrinterInfo {
  /** OS device name, used for silent printing. */
  name: string;
  displayName: string;
  isDefault: boolean;
}

export interface PrintJobOptions {
  format: PrintFormat;
  /** Present: print silently to this device. Absent: OS print dialog. */
  deviceName?: string;
  silent: boolean;
}

export type PrintDriverResult =
  | { outcome: 'PRINTED' }
  | { outcome: 'CANCELLED' }
  | { outcome: 'FAILED'; code: 'PRINT_FAILED' };

export interface PrintDriver {
  listPrinters(): Promise<PrinterInfo[]>;
  print(html: string, options: PrintJobOptions): Promise<PrintDriverResult>;
  /** PDF bytes of the document at the format's page size. */
  printToPdf(html: string, format: PrintFormat): Promise<Uint8Array>;
}

/** Native file dialogs, shown by main. The renderer never supplies a path. */
export interface FileDialogs {
  /** A PNG/JPEG to use as the shop logo; null when cancelled. */
  chooseImage(): Promise<string | null>;
  /** Where to save a PDF; null when cancelled. */
  choosePdfDestination(defaultFileName: string): Promise<string | null>;
  /** Where to save a CSV export; null when cancelled. */
  chooseCsvDestination(defaultFileName: string): Promise<string | null>;
  /** A CSV file to import; null when cancelled. */
  chooseCsvFile(): Promise<string | null>;
  /** A folder for backups; null when cancelled. */
  chooseBackupDirectory(): Promise<string | null>;
}

/** Used when no driver is wired (never in the app): every print fails. */
export const unavailablePrintDriver: PrintDriver = {
  listPrinters: async () => [],
  print: async () => ({ outcome: 'FAILED', code: 'PRINT_FAILED' }),
  printToPdf: async () => {
    throw new Error('No print driver');
  },
};

export const noFileDialogs: FileDialogs = {
  chooseImage: async () => null,
  choosePdfDestination: async () => null,
  chooseCsvDestination: async () => null,
  chooseCsvFile: async () => null,
  chooseBackupDirectory: async () => null,
};
