// Electron main entry for `npm run print:samples` (R10 visual review).
// Seeds the spec 61 fixtures into a throwaway database through the app's own
// command table, renders every fixture in every format with the REAL print
// driver's printToPDF (A4, and 58/80 mm at custom inch sizes) and writes the
// PDFs (plus the HTML) to artifacts/print-samples/. Never touches app data.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { app } from 'electron';
import { createApplicationServices } from '@/main/compose';
import { openDatabase } from '@/main/database/connection';
import { migrateDatabase } from '@/main/database/migrate';
import { createElectronPrintDriver } from '@/main/features/printing/electron-driver';
import { executeCommand } from '@/main/platform/command';
import { buildCommands } from '@/main/platform/commands';
import { CHANNELS } from '@/shared/channels';
import type { PrintFormat } from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
import { toInstant } from '@/shared/time';
import {
  acceptanceInvoice,
  ADMIN_WINDOW,
  CASHIER_WINDOW,
  criticalInvoice,
  issueInvoice,
  fixtureId,
  must,
  seedPrintShop,
  type Call,
} from '../../tests/fixtures/print-invoices';

const OUT = path.resolve(
  process.env.PRINT_SAMPLES_OUT ?? 'artifacts/print-samples',
);
const FORMATS: PrintFormat[] = ['A4', 'THERMAL_58', 'THERMAL_80'];
const T0 = Date.UTC(2026, 8, 30, 3, 0, 0);

/** A small real PNG (a two-tone badge) so the logo path is exercised. */
function samplePng(width = 160, height = 60): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const border = x < 4 || y < 4 || x >= width - 4 || y >= height - 4;
      const band = Math.floor(x / 20) % 2 === 0;
      const [r, g, b] = border
        ? [20, 20, 20]
        : band
          ? [30, 90, 200]
          : [240, 240, 240];
      row.writeUInt8(r, 1 + x * 3);
      row.writeUInt8(g, 2 + x * 3);
      row.writeUInt8(b, 3 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main(): Promise<void> {
  const work = mkdtempSync(path.join(tmpdir(), 'bengkelin-samples-'));
  app.setPath('userData', work);
  let nowMs = T0;
  const now = () => toInstant(nowMs);
  const logoFile = path.join(work, 'logo.png');
  writeFileSync(logoFile, samplePng());
  const driver = createElectronPrintDriver();
  const db = openDatabase(path.join(work, 'samples.sqlite'));
  try {
    migrateDatabase(db);
    const services = createApplicationServices({
      db,
      clock: { now },
      logDir: path.join(work, 'logs'),
      assetsDir: path.join(work, 'assets'),
      printDriver: driver,
      dialogs: {
        chooseImage: async () => logoFile,
        choosePdfDestination: async () => null,
        chooseCsvDestination: async () => null,
        chooseCsvFile: async () => null,
        chooseBackupDirectory: async () => null,
        chooseRestoreFile: async () => null,
      },
      openPath: async () => '',
    });
    const commands = new Map(
      buildCommands(services).map((c) => [c.channel, c]),
    );
    const call: Call = async <T>(
      channel: string,
      input?: unknown,
      windowId = 1,
    ) =>
      (await executeCommand(
        commands.get(channel)!,
        { windowId },
        input,
        services.logger,
      )) as Result<T>;

    const shop = await seedPrintShop(call, now);
    must(
      await call(CHANNELS.settings.chooseLogo, undefined, ADMIN_WINDOW),
      'logo',
    );
    const start = toInstant(T0 - 30 * 24 * 3_600_000);

    const acceptance = await acceptanceInvoice(shop, start);
    nowMs += 2 * 3_600_000;
    must(
      await call(
        CHANNELS.invoices.recordPayment,
        {
          requestId: fixtureId(),
          invoiceId: acceptance.id,
          method: 'BANK_TRANSFER',
          amount: '100000',
          reference: 'TRF-20260930-889',
        },
        CASHIER_WINDOW,
      ),
      'later payment',
    );
    const critical = await criticalInvoice(shop, start);
    const voided = await criticalInvoice(shop, start);
    must(
      await call(
        CHANNELS.invoices.void,
        {
          requestId: fixtureId(),
          invoiceId: voided.id,
          reason: 'Salah input barang, diganti faktur baru',
        },
        CASHIER_WINDOW,
      ),
      'void',
    );
    // The critical invoice was printed once: its samples show the REPRINT marking.
    must(
      await call(
        CHANNELS.printing.updateSettings,
        {
          defaultInvoiceFormat: 'THERMAL',
          thermalPaperWidthMm: 58,
          defaultA4PrinterName: null,
          defaultThermalPrinterName: null,
          autoPrintAfterFinalize: false,
        },
        ADMIN_WINDOW,
      ),
      'settings',
    );
    db.prepare(
      `INSERT INTO print_jobs (invoice_id, format, action, requested_by, requested_at,
         outcome, error_code, is_reprint)
       SELECT ?, 'THERMAL_58', 'PRINT', id, ?, 'PRINTED', NULL, 0 FROM cashiers WHERE username = 'siti'`,
    ).run(critical.id, now());

    const currentShop = must(
      await call<import('@/shared/contracts').ShopSettingsDto>(
        CHANNELS.settings.getShop,
        undefined,
        ADMIN_WINDOW,
      ),
      'shop',
    );
    must(
      await call(
        CHANNELS.settings.updateShop,
        {
          ...currentShop,
          complaintPhoneNumber: '0878-1640-9387',
          socialMediaUrl: 'https://s.id/mitramotorbersama?s=qr',
        },
        ADMIN_WINDOW,
      ),
      'contacts',
    );
    const taxable = await issueInvoice(shop, {
      vatRateBps: 1000,
      lines: [
        { custom: { type: 'SERVICE', title: 'Oli mesin', price: '25000' } },
        { custom: { type: 'SERVICE', title: 'Jasa servis', price: '25000' } },
      ],
    });
    const discounted = await issueInvoice(shop, {
      vatRateBps: 1000,
      invoiceDiscounts: [1000],
      lines: [
        {
          custom: {
            type: 'SERVICE',
            title: 'Servis dengan diskon item dan faktur',
            price: '100000',
          },
          discounts: [1000],
        },
      ],
    });
    const fixtures = [
      ['acceptance-42-lines', acceptance.id],
      ['critical-31500-reprint', critical.id],
      ['void', voided.id],
      ['vat-50000', taxable.id],
      ['vat-discounted-81000', discounted.id],
    ] as const;
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    for (const language of ['id', 'en'] as const) {
      db.prepare('UPDATE settings SET language = ? WHERE id = 1').run(language);
      for (const [name, invoiceId] of fixtures) {
        for (const format of FORMATS) {
          const { html } = services.printing.renderInvoice(invoiceId, format);
          const base = path.join(OUT, `${name}-${language}-${format}`);
          writeFileSync(`${base}.html`, html);
          writeFileSync(`${base}.pdf`, await driver.printToPdf(html, format));
          console.log(`wrote ${path.relative(process.cwd(), base)}.pdf`);
        }
      }
    }
  } finally {
    db.close();
    rmSync(work, { recursive: true, force: true });
  }
}

// The driver's hidden windows come and go; closing the last one must not
// quit the app before every sample is written.
app.on('window-all-closed', () => undefined);

app.whenReady().then(
  () =>
    main().then(
      () => app.quit(),
      (error: unknown) => {
        console.error(error);
        app.exit(1);
      },
    ),
  (error: unknown) => {
    console.error(error);
    app.exit(1);
  },
);
