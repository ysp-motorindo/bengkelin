import { randomUUID } from 'node:crypto';
import type { Session } from '@/main/features/auth/sessions';
import { CatalogRepository } from '@/main/features/catalog/repository';
import { requireActiveStockLocation } from '@/main/features/references/stock-locations';
import { insertEntry, stockOf } from '@/main/features/inventory/ledger';
import type {
  ReceivePurchaseData,
  ReversePurchaseReceiptData,
  PurchaseWarning,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import { canonicalJson } from '@/main/database/idempotency';
import {
  allocatePurchaseNumber,
  bumpPurchase,
  requireIssued,
  type PurchaseContext,
} from './context';
import { purchaseView } from './view';
export interface StockDemand {
  catalogItemId: string;
  stockLocationId: string;
  quantity: number;
  title: string;
}
export function stockWarnings(
  ctx: PurchaseContext,
  demands: StockDemand[],
): PurchaseWarning[] {
  const grouped = new Map<string, StockDemand>();
  for (const d of demands) {
    const key = d.catalogItemId + '/' + d.stockLocationId;
    const old = grouped.get(key);
    grouped.set(key, { ...d, quantity: d.quantity + (old?.quantity ?? 0) });
  }
  return [...grouped.values()]
    .sort((a, b) =>
      (a.catalogItemId + a.stockLocationId).localeCompare(
        b.catalogItemId + b.stockLocationId,
      ),
    )
    .flatMap((d) => {
      requireActiveStockLocation(ctx.db, d.stockLocationId);
      const stock = stockOf(ctx.db, d.catalogItemId, d.stockLocationId);
      const after = stock - d.quantity;
      return after < 0
        ? [
            {
              code: 'NEGATIVE_STOCK' as const,
              params: {
                catalogItemId: d.catalogItemId,
                stockLocationId: d.stockLocationId,
                title: d.title,
                observedStock: String(stock),
                demand: String(d.quantity),
                resultingStock: String(after),
              },
            },
          ]
        : [];
    });
}
export function receivePurchase(
  ctx: PurchaseContext,
  actor: Session,
  input: ReceivePurchaseData,
) {
  const row = ctx.repo.find(input.purchaseId);
  requireIssued(row);
  const location = requireActiveStockLocation(ctx.db, input.stockLocationId);
  const view = purchaseView(ctx.db, ctx.clock, actor, row.id);
  const quantities = new Map<string, number>();
  for (const l of input.lines)
    quantities.set(
      l.purchaseLineId,
      (quantities.get(l.purchaseLineId) ?? 0) + l.quantity,
    );
  const prepared = [...quantities].map(([id, quantity]) => {
    const line = view.lines.find((l) => l.id === id);
    if (!line) throw new DomainError('PURCHASE_LINE_NOT_FOUND');
    if (quantity > line.remainingQuantity || quantity > 1000000)
      throw new DomainError('PURCHASE_RECEIPT_EXCEEDS_REMAINING');
    if (line.catalogItemId) {
      const item = new CatalogRepository(ctx.db).find(line.catalogItemId);
      if (
        !item ||
        item.trackInventory !== line.trackInventory ||
        item.type !== line.type
      )
        throw new DomainError('PURCHASE_ITEM_TRACKING_CHANGED');
    }
    return { line, quantity };
  });
  const receiptId = randomUUID();
  ctx.db
    .prepare(
      'INSERT INTO purchase_receipts(id,purchase_id,document_number,stock_location_id,location_snapshot,note,created_at,created_by,cashier_name_snapshot) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      receiptId,
      row.id,
      allocatePurchaseNumber(ctx, 'RCV'),
      location.id,
      JSON.stringify(location),
      input.note,
      ctx.clock.now(),
      actor.cashierId,
      actor.displayName,
    );
  for (const { line, quantity } of prepared) {
    const id = randomUUID();
    const entry = line.trackInventory
      ? insertEntry(ctx.db, {
          catalogItemId: line.catalogItemId!,
          stockLocationId: location.id,
          movementType: 'STOCK_IN',
          quantityDelta: quantity,
          referenceType: 'PURCHASE_RECEIPT_ITEM',
          referenceId: id,
          note: input.note,
          createdByCashierId: actor.cashierId,
          createdAt: ctx.clock.now(),
        })
      : null;
    ctx.db
      .prepare(
        'INSERT INTO purchase_receipt_items(id,receipt_id,purchase_item_id,quantity,ledger_entry_id) VALUES(?,?,?,?,?)',
      )
      .run(id, receiptId, line.id, quantity, entry);
  }
  bumpPurchase(ctx, actor, row.id);
  return purchaseView(ctx.db, ctx.clock, actor, row.id);
}
export function reversalPlan(
  ctx: PurchaseContext,
  actor: Session,
  input: { purchaseId: string; receiptId: string },
) {
  const row = ctx.repo.find(input.purchaseId);
  requireIssued(row);
  const view = purchaseView(ctx.db, ctx.clock, actor, row.id);
  const receipt = view.receipts.find((r) => r.id === input.receiptId);
  if (!receipt) throw new DomainError('PURCHASE_RECEIPT_NOT_FOUND');
  if (receipt.reversedAt)
    throw new DomainError('PURCHASE_RECEIPT_ALREADY_REVERSED');
  if (receipt.lines.some((l) => l.creditedQuantity > 0))
    throw new DomainError('PURCHASE_RECEIPT_ALREADY_CREDITED');
  requireActiveStockLocation(ctx.db, receipt.stockLocationId);
  const demands = receipt.lines.flatMap((l) => {
    const original = view.lines.find((x) => x.id === l.purchaseLineId)!;
    return original.trackInventory
      ? [
          {
            catalogItemId: original.catalogItemId!,
            stockLocationId: receipt.stockLocationId,
            quantity: l.quantity,
            title: original.title,
          },
        ]
      : [];
  });
  return {
    receipt,
    demands,
    warnings: stockWarnings(ctx, demands),
    version: view.version,
  };
}
export function reversePurchaseReceipt(
  ctx: PurchaseContext,
  actor: Session,
  input: ReversePurchaseReceiptData,
) {
  const plan = reversalPlan(ctx, actor, input);
  if (
    canonicalJson(plan.warnings) !== canonicalJson(input.acknowledgedWarnings)
  )
    throw new DomainError('FINALIZE_WARNINGS_CHANGED');
  for (const item of plan.receipt.lines) {
    const line = ctx.repo.line(input.purchaseId, item.purchaseLineId);
    if (line.track_inventory === 1n)
      insertEntry(ctx.db, {
        catalogItemId: line.catalog_item_id!,
        stockLocationId: plan.receipt.stockLocationId,
        movementType: 'ADJUSTMENT',
        quantityDelta: -item.quantity,
        referenceType: 'PURCHASE_RECEIPT_REVERSAL_ITEM',
        referenceId: item.id,
        note: input.reason,
        createdByCashierId: actor.cashierId,
        createdAt: ctx.clock.now(),
      });
  }
  ctx.db
    .prepare(
      'INSERT INTO purchase_receipt_reversals(id,purchase_id,receipt_id,reason,created_at,created_by,cashier_name_snapshot) VALUES(?,?,?,?,?,?,?)',
    )
    .run(
      randomUUID(),
      input.purchaseId,
      input.receiptId,
      input.reason,
      ctx.clock.now(),
      actor.cashierId,
      actor.displayName,
    );
  bumpPurchase(ctx, actor, input.purchaseId);
  return purchaseView(ctx.db, ctx.clock, actor, input.purchaseId);
}
