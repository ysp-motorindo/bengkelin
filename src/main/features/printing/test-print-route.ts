import fs from 'node:fs';
import path from 'node:path';
import type { PrintDriver } from './driver';

/**
 * TEST-ONLY route (T17 ruling, like R3): in UNPACKAGED builds, when
 * BENGKELIN_TEST_PRINT_TO_PDF_DIR is set, paper prints are rendered with
 * the same driver's printToPDF and written to that folder instead of a
 * printer, so the workflow e2e can prove a print happened without a
 * physical printer. The printing service is unchanged: the outcome and the
 * `print_jobs` row are exactly those of a real print. Packaged builds never
 * wrap the driver (see `testPrintToPdfDir`).
 */
export function routePrintsToPdf(
  driver: PrintDriver,
  dir: string,
): PrintDriver {
  let sequence = 0;
  return {
    listPrinters: () => driver.listPrinters(),
    printToPdf: (html, format) => driver.printToPdf(html, format),
    async print(html, options) {
      try {
        const bytes = await driver.printToPdf(html, options.format);
        sequence += 1;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(
            dir,
            `print-${String(sequence).padStart(3, '0')}-${options.format}.pdf`,
          ),
          bytes,
        );
        return { outcome: 'PRINTED' };
      } catch {
        return { outcome: 'FAILED', code: 'PRINT_FAILED' };
      }
    },
  };
}

/** The hook's folder, or null (always null when packaged). */
export function testPrintToPdfDir(
  app: { isPackaged: boolean },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (app.isPackaged) return null;
  const dir = env.BENGKELIN_TEST_PRINT_TO_PDF_DIR;
  return dir ? path.resolve(dir) : null;
}
