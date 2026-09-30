import { csvInteger, type CsvRow } from '@/main/features/csv/writer';
import {
  asciiLower,
  priceColumnName,
  type RefChannel,
  type RefUnit,
} from './columns';

/**
 * The downloadable CSV template (spec 38): the import header for the ACTIVE
 * channels, plus two complete example rows (every row as wide as the
 * header): a stock item with two barcodes and an opening stock, and a
 * service with a price for the first channel only. The template imports
 * cleanly as it is.
 */

const EXAMPLE_STOCK_PRICES: Record<string, bigint> = {
  bengkel: 65000n,
  shopee: 70000n,
  reseller: 58000n,
};

function pickUnit(units: RefUnit[], preferred: string): string {
  const active = units.filter((u) => u.isActive);
  const match = active.find(
    (u) => asciiLower(u.code) === asciiLower(preferred),
  );
  return (match ?? active[0])?.code ?? preferred;
}

export function buildCatalogTemplate(
  channels: RefChannel[],
  units: RefUnit[],
): CsvRow[] {
  const active = channels.filter((c) => c.isActive);
  const header = [
    'sku',
    'title',
    'type',
    'unit',
    'barcode',
    'barcode_2',
    ...active.map((c) => priceColumnName(c.code)),
    'opening_stock',
    'is_active',
    'description',
  ];
  const stockItem: CsvRow = [
    'OLI-MPX2-1L',
    'Oli MPX 2 1L',
    'STOCK_ITEM',
    pickUnit(units, 'BOTTLE'),
    '8991234567890',
    '8991234567891',
    ...active.map((c) =>
      csvInteger(EXAMPLE_STOCK_PRICES[asciiLower(c.code)] ?? 65000n),
    ),
    csvInteger(12),
    'true',
    'Oli mesin 4T, 1 liter',
  ];
  const service: CsvRow = [
    'JASA-GANTI-OLI',
    'Jasa Ganti Oli',
    'SERVICE',
    pickUnit(units, 'SERVICE'),
    '',
    '',
    ...active.map((_, index) => (index === 0 ? csvInteger(20000) : '')),
    '',
    'true',
    'Termasuk pengecekan filter oli',
  ];
  return [header, stockItem, service];
}
