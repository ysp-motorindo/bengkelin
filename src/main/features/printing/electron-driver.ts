import { BrowserWindow, type WebContents } from 'electron';
import type { PrintFormat } from '@/shared/contracts';
import type { PrintDriver, PrintJobOptions, PrinterInfo } from './driver';
import { pdfOptionsFor, printOptionsFor } from './driver-options';
import { printWithTimeout } from './print-job';

/**
 * The real driver: renders the template in a hidden, sandboxed window with
 * JavaScript disabled, no preload, its own in-memory session, no navigation
 * and no popups, loaded from a data URL, then prints or makes a PDF and
 * destroys the window. Thermal pages are the paper width by the measured
 * content height.
 */

const MICRONS_PER_CSS_PX = 25_400 / 96;
/** Room for rounding between screen layout and print layout. */
const HEIGHT_SLACK_MICRONS = 4_000;
/** Used if measuring fails: an A4 length of roll is better than nothing. */
const FALLBACK_HEIGHT_MICRONS = 297_000;

async function withDocument<T>(
  html: string | null,
  work: (contents: WebContents, window: BrowserWindow) => Promise<T>,
): Promise<T> {
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
      webviewTag: false,
      devTools: false,
      spellcheck: false,
      // Isolated from the app session (no cookies, storage or handlers).
      partition: 'bengkelin-print',
    },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const block = (event: { preventDefault(): void }) => event.preventDefault();
  contents.on('will-navigate', block);
  contents.on('will-frame-navigate', block);
  contents.on('will-redirect', block);
  contents.on('will-attach-webview', block);
  contents.session.setPermissionRequestHandler((_wc, _permission, done) =>
    done(false),
  );
  try {
    if (html !== null) {
      const encoded = Buffer.from(html, 'utf8').toString('base64');
      await window.loadURL(`data:text/html;charset=utf-8;base64,${encoded}`);
    }
    return await work(contents, window);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

/**
 * Bottom edge of the template's `.sheet` via the DevTools protocol (page
 * JavaScript is disabled, so the page cannot measure itself).
 */
async function contentHeightMicrons(contents: WebContents): Promise<number> {
  const send = (method: string, params?: object) =>
    contents.debugger.sendCommand(method, params) as Promise<
      Record<string, unknown>
    >;
  try {
    contents.debugger.attach('1.3');
    try {
      const { root } = (await send('DOM.getDocument', { depth: 0 })) as {
        root: { nodeId: number };
      };
      const { nodeId } = (await send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: '.sheet',
      })) as { nodeId: number };
      const { model } = (await send('DOM.getBoxModel', { nodeId })) as {
        model: { margin: number[] };
      };
      // margin quad: x1,y1 .. x4,y4; the largest y is the bottom edge.
      const bottom = Math.max(...model.margin.filter((_, i) => i % 2 === 1));
      return Math.ceil(bottom * MICRONS_PER_CSS_PX) + HEIGHT_SLACK_MICRONS;
    } finally {
      contents.debugger.detach();
    }
  } catch {
    return FALLBACK_HEIGHT_MICRONS;
  }
}

async function measuredHeight(
  contents: WebContents,
  format: PrintFormat,
): Promise<number> {
  return format === 'A4' ? 0 : contentHeightMicrons(contents);
}

function isDefaultPrinter(options: Record<string, unknown> | undefined) {
  if (!options) return false;
  return ['is-default', 'printer-is-default', 'isDefault'].some(
    (key) => options[key] === true || options[key] === 'true',
  );
}

export function createElectronPrintDriver(): PrintDriver {
  return {
    listPrinters: () =>
      withDocument(null, async (contents) =>
        (await contents.getPrintersAsync()).map(
          (printer): PrinterInfo => ({
            name: printer.name,
            displayName: printer.displayName || printer.name,
            isDefault: isDefaultPrinter(
              printer.options as Record<string, unknown> | undefined,
            ),
          }),
        ),
      ),

    print: (html: string, options: PrintJobOptions) =>
      withDocument(html, async (contents, window) => {
        const page = printOptionsFor(
          options.format,
          await measuredHeight(contents, options.format),
        );
        // Times out (PRINT_TIMEOUT, window destroyed) if the callback
        // never returns: see print-job.ts.
        return printWithTimeout(window, {
          ...page,
          silent: options.silent,
          ...(options.deviceName ? { deviceName: options.deviceName } : {}),
        });
      }),

    printToPdf: (html: string, format: PrintFormat) =>
      withDocument(html, async (contents) => {
        const options = pdfOptionsFor(
          format,
          await measuredHeight(contents, format),
        );
        return new Uint8Array(await contents.printToPDF(options));
      }),
  };
}
