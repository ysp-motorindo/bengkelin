import { bool, toNumber } from '@/main/database/rows';
import type { AdHocReferenceDto, CatalogItemDto } from '@/shared/contracts';
import { MAX_LINE_QUANTITY } from '@/shared/contracts';
import { canMergeScannedLine } from '@/main/features/catalog/domain';
import { DomainError, parseRupiah } from '@/shared/primitives';
import {
  recordPriceChange,
  requireLine,
  type DraftOp as Op,
  type OperationContext,
} from './context';
import type { LineRow } from './repository';

function requireSellableItem(
  ctx: OperationContext,
  op: Op<'addCatalogLine'>,
): CatalogItemDto {
  if (op.barcode !== undefined) {
    // Scanner path: active barcode and active item are checked by the lookup.
    return ctx.catalog.lookupBarcode(ctx.actor, { code: op.barcode });
  }
  const item = ctx.catalog.get(ctx.actor, { id: op.catalogItemId! });
  if (!item.isActive) {
    throw new DomainError('CATALOG_ITEM_INACTIVE', 'Item is inactive');
  }
  return item;
}

function checkQuantity(quantity: number): number {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_LINE_QUANTITY
  ) {
    throw new DomainError('INVALID_QUANTITY', 'Quantity out of range');
  }
  return quantity;
}

/**
 * spec 11: a re-added item merges into the most recent live line of the same
 * item that `canMergeScannedLine` allows (no manual price, no line
 * discounts) AND that carries the very price the new unit would get (same
 * resolved price point and unit price), so a merge never sells new units at
 * a retained older price.
 */
function mergeCandidate(
  ctx: OperationContext,
  itemId: string,
  priceId: string,
  price: bigint,
): LineRow | undefined {
  const lines = ctx.repo.liveLines(ctx.invoice.id);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (line.catalog_item_id !== itemId) continue;
    const eligible = canMergeScannedLine({
      isCatalogLine: true,
      manualPriceOverride: bool(line.manual_price_override),
      discountCount: ctx.repo.countLineStages(line.id),
    });
    if (
      eligible &&
      line.resolved_price_id === priceId &&
      line.unit_price === price
    ) {
      return line;
    }
  }
  return undefined;
}

/**
 * Adds (or merges) a catalog line priced at the draft's channel and
 * pricingAt. No configured price: an explicit `unitPrice` is required and is
 * recorded as a MISSING_PRICE_ENTRY (previous price null) and audited.
 */
export function addCatalogLine(
  ctx: OperationContext,
  op: Op<'addCatalogLine'>,
): void {
  const { invoice } = ctx;
  const item = requireSellableItem(ctx, op);
  const quantity = op.quantity ?? 1;
  const resolved = ctx.catalog.resolvePrice(
    item.id,
    invoice.channel_id,
    invoice.pricing_at,
  );

  if (resolved) {
    if (op.unitPrice !== undefined) {
      throw new DomainError(
        'UNIT_PRICE_NOT_EXPECTED',
        'A catalog price exists; override it on the line instead',
      );
    }
    const price = parseRupiah(resolved.price);
    const target = mergeCandidate(ctx, item.id, resolved.priceId, price);
    if (target) {
      ctx.repo.setQuantity(
        target.id,
        checkQuantity(toNumber(target.quantity) + quantity),
        target.unit_price,
        ctx.now,
      );
      return;
    }
    insertCatalogLine(ctx, item, quantity, {
      listed: price,
      unitPrice: price,
      priceId: resolved.priceId,
      manual: false,
    });
    return;
  }

  if (op.unitPrice === undefined) {
    throw new DomainError('PRICE_REQUIRED', 'No price is configured');
  }
  const unitPrice = parseRupiah(op.unitPrice);
  const lineId = insertCatalogLine(ctx, item, quantity, {
    listed: null,
    unitPrice,
    priceId: null,
    // The price was typed by hand: never merged, always shown as manual.
    manual: true,
  });
  recordPriceChange(ctx, {
    lineId,
    kind: 'MISSING_PRICE_ENTRY',
    previousPrice: null,
    newPrice: unitPrice,
    reason: op.reason ?? null,
  });
  ctx.audit('DRAFT_MISSING_PRICE_ENTERED', {
    lineId,
    catalogItemId: item.id,
    channelId: invoice.channel_id,
    pricingAt: invoice.pricing_at,
    newPrice: unitPrice.toString(),
    reason: op.reason ?? null,
  });
}

function insertCatalogLine(
  ctx: OperationContext,
  item: CatalogItemDto,
  quantity: number,
  price: {
    listed: bigint | null;
    unitPrice: bigint;
    priceId: string | null;
    manual: boolean;
  },
): string {
  const id = ctx.newId();
  ctx.repo.insertLine({
    id,
    invoiceId: ctx.invoice.id,
    catalogItemId: item.id,
    adHocItemReferenceId: null,
    itemType: item.type,
    title: item.title,
    unitId: item.unitId,
    unitLabel: item.unitLabel,
    quantity,
    listedUnitPrice: price.listed,
    unitPrice: price.unitPrice,
    resolvedPriceId: price.priceId,
    priceResolvedAt: ctx.invoice.pricing_at,
    manualPriceOverride: price.manual,
    now: ctx.now,
  });
  return id;
}

/** The reference to link: the one sent, else upserted by (type, title). */
function resolveReference(
  ctx: OperationContext,
  op: Op<'addCustomLine'>,
  unitPrice: bigint,
): AdHocReferenceDto {
  const unitId = op.unitId ?? null;
  if (op.adHocItemReferenceId !== undefined) {
    const found = ctx.adHoc.find(op.adHocItemReferenceId);
    if (!found) {
      throw new DomainError(
        'AD_HOC_REFERENCE_NOT_FOUND',
        'Reference not found',
      );
    }
    if (found.type !== op.type) {
      throw new DomainError(
        'AD_HOC_REFERENCE_TYPE_MISMATCH',
        'The reference has another type',
      );
    }
    if (!found.isActive) {
      throw new DomainError(
        'AD_HOC_REFERENCE_INACTIVE',
        'Reference is inactive',
      );
    }
    ctx.adHoc.rememberUse(found.id, {
      defaultPrice: unitPrice,
      unitId,
      now: ctx.now,
    });
    return found;
  }
  const existing = ctx.adHoc.findByTitle(op.type, op.title);
  if (existing) {
    ctx.adHoc.rememberUse(existing.id, {
      defaultPrice: unitPrice,
      unitId,
      now: ctx.now,
    });
    return existing;
  }
  const id = ctx.newId();
  ctx.adHoc.insert({
    id,
    type: op.type,
    title: op.title,
    unitId,
    defaultPrice: unitPrice,
    now: ctx.now,
  });
  return ctx.adHoc.find(id)!;
}

/** A free-form SERVICE or NON_STOCK_ITEM line. Never touches stock. */
export function addCustomLine(
  ctx: OperationContext,
  op: Op<'addCustomLine'>,
): void {
  if (op.unitId) {
    const unit = ctx.repo.unitLabel(op.unitId);
    if (!unit) throw new DomainError('UNIT_NOT_FOUND', 'Unit not found');
    if (!unit.isActive)
      throw new DomainError('UNIT_INACTIVE', 'Unit is inactive');
  }
  const unitPrice = parseRupiah(op.unitPrice);
  const reference = resolveReference(ctx, op, unitPrice);
  // An explicit unit (or explicit null) wins; otherwise the reference's unit.
  const unitId = op.unitId !== undefined ? op.unitId : reference.unitId;
  ctx.repo.insertLine({
    id: ctx.newId(),
    invoiceId: ctx.invoice.id,
    catalogItemId: null,
    adHocItemReferenceId: reference.id,
    itemType: op.type,
    title: op.title,
    unitId,
    unitLabel: unitId ? (ctx.repo.unitLabel(unitId)?.label ?? null) : null,
    quantity: op.quantity ?? 1,
    listedUnitPrice: null,
    unitPrice,
    resolvedPriceId: null,
    priceResolvedAt: null,
    manualPriceOverride: false,
    now: ctx.now,
  });
}

/**
 * Line edits. A changed unit price is a manual override: flagged on the
 * line, appended to its history (previous -> new) and audited. The listed
 * price and its provenance are kept.
 */
export function updateLine(ctx: OperationContext, op: Op<'updateLine'>): void {
  const line = requireLine(ctx, op.lineId);
  const { repo } = ctx;

  if (op.title !== undefined && op.title !== line.title_snapshot) {
    if (line.catalog_item_id !== null) {
      throw new DomainError(
        'LINE_TITLE_NOT_EDITABLE',
        'Catalog line titles come from the catalog',
      );
    }
    repo.setTitle(line.id, op.title, ctx.now);
  }

  if (op.mechanicId !== undefined) {
    if (op.mechanicId === null) {
      repo.setMechanic(line.id, null, ctx.now);
    } else {
      if (line.item_type_snapshot !== 'SERVICE') {
        throw new DomainError(
          'MECHANIC_ONLY_FOR_SERVICE',
          'Mechanics are assigned to service lines only',
        );
      }
      const mechanic = repo.mechanic(op.mechanicId);
      if (!mechanic) {
        throw new DomainError('MECHANIC_NOT_FOUND', 'Mechanic not found');
      }
      if (!mechanic.isActive) {
        throw new DomainError('MECHANIC_INACTIVE', 'Mechanic is inactive');
      }
      repo.setMechanic(
        line.id,
        { id: op.mechanicId, name: mechanic.name },
        ctx.now,
      );
    }
  }

  const quantity = op.quantity ?? toNumber(line.quantity);
  if (quantity !== toNumber(line.quantity)) {
    repo.setQuantity(
      line.id,
      checkQuantity(quantity),
      line.unit_price,
      ctx.now,
    );
  }

  if (op.unitPrice !== undefined) {
    const newPrice = parseRupiah(op.unitPrice);
    if (newPrice !== line.unit_price) {
      repo.setPrice(
        line.id,
        BigInt(quantity),
        {
          unitPrice: newPrice,
          listedUnitPrice: line.listed_unit_price,
          resolvedPriceId: line.resolved_price_id,
          priceResolvedAt: line.price_resolved_at,
          manualPriceOverride: true,
        },
        ctx.now,
      );
      recordPriceChange(ctx, {
        lineId: line.id,
        kind: 'MANUAL_OVERRIDE',
        previousPrice: line.unit_price,
        newPrice,
        reason: op.reason ?? null,
      });
      ctx.audit('DRAFT_PRICE_OVERRIDDEN', {
        lineId: line.id,
        catalogItemId: line.catalog_item_id,
        previousPrice: line.unit_price.toString(),
        newPrice: newPrice.toString(),
        reason: op.reason ?? null,
      });
    }
  }
}

/** Tombstones the line; its price history stays. */
export function removeLine(ctx: OperationContext, op: Op<'removeLine'>): void {
  const line = requireLine(ctx, op.lineId);
  ctx.repo.tombstone(line.id, ctx.actor.cashierId, ctx.now);
}

export function setLineDiscounts(
  ctx: OperationContext,
  op: Op<'setLineDiscounts'>,
): void {
  const line = requireLine(ctx, op.lineId);
  ctx.repo.replaceLineStages(line.id, op.stages, ctx.newId);
}
