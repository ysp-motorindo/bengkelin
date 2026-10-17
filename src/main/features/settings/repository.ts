import type { AppDatabase } from '@/main/database/connection';
import type {
  Appearance,
  Language,
  PreferencesInput,
  PublicSettings,
  ShopSettingsDto,
} from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';

interface PublicRow {
  shop_name: string;
  language: string;
  appearance: string;
  setup_completed_at: string | null;
}

export interface ShopFields {
  name: string;
  address: string;
  phoneNumber: string | null;
  email: string | null;
  invoiceFooter: string | null;
  timezone: string;
}

export interface PrinterFields {
  thermalPrinterName: string | null;
  a4PrinterName: string | null;
  thermalPaperWidthMm: 58 | 80;
}

export interface SeedRow {
  id: string;
  code: string;
  label: string;
}

/** The single `settings` row (id = 1), channels and units. */
export class SettingsRepository {
  constructor(private readonly db: AppDatabase) {}

  getPublic(): Omit<PublicSettings, 'systemNumberLocale'> {
    const row = this.db
      .prepare(
        'SELECT shop_name, language, appearance, setup_completed_at FROM settings WHERE id = 1',
      )
      .get() as PublicRow;
    return {
      setupCompleted: row.setup_completed_at !== null,
      language: row.language as Language,
      appearance: row.appearance as Appearance,
      shopName: row.shop_name,
    };
  }

  getShop(): ShopSettingsDto {
    const row = this.db
      .prepare(
        `SELECT shop_name, address, phone_number, email, invoice_footer, timezone
           FROM settings WHERE id = 1`,
      )
      .get() as {
      shop_name: string;
      address: string | null;
      phone_number: string | null;
      email: string | null;
      invoice_footer: string | null;
      timezone: string;
    };
    return {
      name: row.shop_name,
      address: row.address ?? '',
      phoneNumber: row.phone_number,
      email: row.email,
      invoiceFooter: row.invoice_footer,
      timezone: row.timezone,
    };
  }

  /** The shop logo's content-addressed asset key (`<sha256>.png|jpg`). */
  logoAsset(): string | null {
    const row = this.db
      .prepare('SELECT logo_asset FROM settings WHERE id = 1')
      .get() as { logo_asset: string | null };
    return row.logo_asset;
  }

  setLogoAsset(asset: string | null): void {
    this.db
      .prepare('UPDATE settings SET logo_asset = ? WHERE id = 1')
      .run(asset);
  }

  language(): Language {
    return this.getPublic().language;
  }

  isSetupCompleted(): boolean {
    return this.getPublic().setupCompleted;
  }

  writeSetup(
    shop: ShopFields,
    preferences: PreferencesInput,
    printer: PrinterFields | undefined,
    completedAt: Instant,
  ): void {
    this.db
      .prepare(
        `UPDATE settings SET shop_name = ?, address = ?, phone_number = ?, email = ?,
           invoice_footer = ?, timezone = ?, language = ?, appearance = ?,
           default_thermal_printer_name = ?, default_a4_printer_name = ?,
           thermal_paper_width_mm = ?, setup_completed_at = ?
         WHERE id = 1`,
      )
      .run(
        shop.name,
        shop.address,
        shop.phoneNumber,
        shop.email,
        shop.invoiceFooter,
        shop.timezone,
        preferences.language,
        preferences.appearance,
        printer?.thermalPrinterName ?? null,
        printer?.a4PrinterName ?? null,
        printer ? BigInt(printer.thermalPaperWidthMm) : null,
        completedAt,
      );
  }

  updateShop(shop: ShopFields): void {
    this.db
      .prepare(
        `UPDATE settings SET shop_name = ?, address = ?, phone_number = ?, email = ?,
           invoice_footer = ?, timezone = ? WHERE id = 1`,
      )
      .run(
        shop.name,
        shop.address,
        shop.phoneNumber,
        shop.email,
        shop.invoiceFooter,
        shop.timezone,
      );
  }

  insertChannel(row: SeedRow): void {
    this.db
      .prepare(
        'INSERT INTO channels (id, code, label, is_active) VALUES (?, ?, ?, 1)',
      )
      .run(row.id, row.code, row.label);
  }

  insertUnit(row: SeedRow): void {
    this.db
      .prepare(
        'INSERT INTO units (id, code, label, is_active) VALUES (?, ?, ?, 1)',
      )
      .run(row.id, row.code, row.label);
  }
}
