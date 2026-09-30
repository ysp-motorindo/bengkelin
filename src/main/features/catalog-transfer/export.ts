import { csvInteger, type CsvRow } from '@/main/features/csv/writer';
import type { Instant } from '@/shared/primitives';
import { barcodeColumnName, priceColumnName, type RefChannel } from './columns';
import type { CatalogTransferRepository } from './repository';

/**
 * Catalog export (spec 41): the current master state, one row per catalog
 * item (active and inactive), written with the T13 formula-safe writer.
 *
 *  - prices: the price in force at `now` per channel (every channel, in
 *    configuration order); a scheduled future point is not "current";
 *  - active barcodes in barcode, barcode_2, ... (as many columns as the item
 *    with the most active barcodes needs, at least one);
 *  - `opening_stock` is present but always BLANK, and the current stock goes
 *    in the separate `current_stock` column (tracked items only), so a
 *    re-import never turns current stock into a new opening balance;
 *  - items without a SKU are exported with an empty SKU and counted: they
 *    need a SKU before the file can be imported again.
 */
export interface CatalogExport {
  rows: CsvRow[];
  itemCount: number;
  skuMissingCount: number;
}

export function buildCatalogExport(
  repo: CatalogTransferRepository,
  now: Instant,
): CatalogExport {
  const channels: RefChannel[] = repo.channels();
  const items = repo.exportItems();
  const barcodes = repo.activeBarcodes();
  const stock = repo.stockLevels();
  const barcodeColumns = Math.max(
    1,
    ...items.map((item) => barcodes.get(item.id)?.length ?? 0),
  );

  const header: string[] = ['sku', 'title', 'type', 'unit'];
  for (let n = 1; n <= barcodeColumns; n += 1) {
    header.push(barcodeColumnName(n));
  }
  for (const channel of channels) header.push(priceColumnName(channel.code));
  header.push('opening_stock', 'current_stock', 'is_active', 'description');

  const rows: CsvRow[] = [header];
  let skuMissingCount = 0;
  for (const item of items) {
    if (item.sku === null) skuMissingCount += 1;
    const itemBarcodes = barcodes.get(item.id) ?? [];
    const row: CsvRow[number][] = [
      item.sku,
      item.title,
      item.type,
      item.unitCode,
    ];
    for (let n = 0; n < barcodeColumns; n += 1) row.push(itemBarcodes[n]);
    for (const channel of channels) {
      const price = repo.priceAt(item.id, channel.id, now);
      row.push(price === null ? null : csvInteger(price));
    }
    row.push(
      null,
      item.trackInventory ? csvInteger(stock.get(item.id) ?? 0n) : null,
      item.isActive ? 'true' : 'false',
      item.description,
    );
    rows.push(row);
  }
  return { rows, itemCount: items.length, skuMissingCount };
}
