import type { AppDatabase } from '@/main/database/connection';
import { DatabaseError } from '@/main/database/errors';
import { PriceRepository } from '@/main/features/catalog/price-repository';
import { appendPricePoint } from '@/main/features/catalog/pricing';
import {
  CatalogRepository,
  type CatalogItemFields,
} from '@/main/features/catalog/repository';
import { insertEntry } from '@/main/features/inventory/ledger';
import type { Instant } from '@/shared/primitives';
import type { ItemPlan } from './planner';

/** Ledger reference of an opening balance written by an import. */
export const CATALOG_IMPORT_REFERENCE = 'CATALOG_IMPORT';

export interface ApplyContext {
  db: AppDatabase;
  newId: () => string;
  cashierId: string;
  /** The ONE import instant: timestamps and every price point start. */
  importAt: Instant;
  /** The preview token; references the opening balances. */
  importId: string;
}

/**
 * Writes a plan. MUST run inside the commit's write transaction: any throw
 * (a constraint, a trigger, PRICE_START_CONFLICT) rolls back every row.
 * Items and barcodes go through the catalog repository, prices through
 * T6's `appendPricePoint` (append only, never an update), opening balances
 * through T7's ledger. Nothing is written for an UNCHANGED row.
 */
export function applyPlan(ctx: ApplyContext, items: ItemPlan[]): void {
  if (!ctx.db.inTransaction) {
    throw new DatabaseError(
      'NOT_IN_TRANSACTION',
      'Catalog imports must run inside withWriteTransaction',
    );
  }
  const catalog = new CatalogRepository(ctx.db);
  const prices = new PriceRepository(ctx.db);
  const at = ctx.importAt;

  for (const item of items) {
    if (item.action === 'UNCHANGED') continue;
    let itemId: string;
    if (item.existing === null) {
      itemId = ctx.newId();
      catalog.insert(itemId, toFields(item, item.sku, null), at);
    } else {
      itemId = item.existing.id;
      if (item.changedFields.length > 0) {
        catalog.update(
          itemId,
          toFields(item, item.existing.sku, item.existing.weight),
          at,
        );
      } else if (
        item.barcodesToAdd.length > 0 ||
        item.barcodesToActivate.length > 0
      ) {
        catalog.touch(itemId, at);
      }
    }

    for (const barcode of item.barcodesToAdd) {
      catalog.insertBarcode(ctx.newId(), itemId, barcode, true);
    }
    for (const barcode of item.barcodesToActivate) {
      catalog.setBarcodeActive(barcode.id, true);
    }

    for (const price of item.prices) {
      appendPricePoint(prices, {
        id: ctx.newId(),
        catalogItemId: itemId,
        channelId: price.channelId,
        effectiveStartAt: at,
        price: price.to,
        createdAt: at,
        createdByCashierId: ctx.cashierId,
        supersedesPriceId: null,
        correctionReason: null,
      });
    }

    if (item.openingStock !== null) {
      insertEntry(ctx.db, {
        catalogItemId: itemId,
        stockLocationId: item.stockLocation!.id,
        movementType: 'OPENING_BALANCE',
        quantityDelta: item.openingStock,
        referenceType: CATALOG_IMPORT_REFERENCE,
        referenceId: ctx.importId,
        createdByCashierId: ctx.cashierId,
        createdAt: at,
      });
    }
  }
}

function toFields(
  item: ItemPlan,
  sku: string,
  weight: number | null,
): CatalogItemFields {
  return {
    type: item.fields.type,
    title: item.fields.title,
    description: item.fields.description,
    sku,
    unitId: item.fields.unitId,
    weight,
    trackInventory: item.fields.trackInventory,
    isActive: item.fields.isActive,
  };
}
