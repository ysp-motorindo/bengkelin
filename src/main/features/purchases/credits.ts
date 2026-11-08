import { randomUUID } from 'node:crypto';
import type { Session } from '@/main/features/auth/sessions';
import type {
  PreviewPurchaseCreditData,
  PurchaseCreditData,
  PurchaseCreditPreview,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import { canonicalJson } from '@/main/database/idempotency';
import { insertEntry } from '@/main/features/inventory/ledger';
import { requireActiveStockLocation } from '@/main/features/references/stock-locations';
import { creditPortion } from './domain';
import {
  allocatePurchaseNumber,
  bumpPurchase,
  requireIssued,
  type PurchaseContext,
} from './context';
import { purchaseView } from './view';
import { stockWarnings, type StockDemand } from './receiving';
export function creditPlan(
  ctx: PurchaseContext,
  actor: Session,
  input: PreviewPurchaseCreditData,
) {
  const row = ctx.repo.find(input.purchaseId);
  requireIssued(row);
  const view = purchaseView(ctx.db, ctx.clock, actor, row.id);
  const groups = new Map<string, PreviewPurchaseCreditData['lines'][number]>();
  for (const l of input.lines) {
    const key = l.purchaseLineId + '/' + (l.receiptItemId ?? '');
    const old = groups.get(key);
    groups.set(key, { ...l, quantity: l.quantity + (old?.quantity ?? 0) });
  }
  const credited = new Map(view.lines.map((l) => [l.id, l.creditedQuantity]));
  const demands: StockDemand[] = [];
  const lines = [...groups.values()]
    .sort((a, b) =>
      (a.purchaseLineId + (a.receiptItemId ?? '')).localeCompare(
        b.purchaseLineId + (b.receiptItemId ?? ''),
      ),
    )
    .map((l) => {
      const original = view.lines.find((x) => x.id === l.purchaseLineId);
      if (!original) throw new DomainError('PURCHASE_LINE_NOT_FOUND');
      let locationId: string | null = null;
      if (l.receiptItemId) {
        const receipt = view.receipts.find((r) =>
          r.lines.some((x) => x.id === l.receiptItemId),
        );
        const item = receipt?.lines.find((x) => x.id === l.receiptItemId);
        if (
          !receipt ||
          !item ||
          receipt.reversedAt ||
          item.purchaseLineId !== original.id
        )
          throw new DomainError('PURCHASE_RECEIPT_NOT_FOUND');
        if (l.quantity > item.quantity - item.creditedQuantity)
          throw new DomainError('PURCHASE_CREDIT_EXCEEDS_AVAILABLE');
        locationId = receipt.stockLocationId;
        requireActiveStockLocation(ctx.db, locationId);
        if (original.trackInventory)
          demands.push({
            catalogItemId: original.catalogItemId!,
            stockLocationId: locationId,
            quantity: l.quantity,
            title: original.title,
          });
      } else if (l.quantity > original.remainingQuantity)
        throw new DomainError('PURCHASE_CREDIT_EXCEEDS_AVAILABLE');
      const previous = credited.get(original.id)!;
      if (previous + l.quantity > original.quantity || l.quantity > 1000000)
        throw new DomainError('PURCHASE_CREDIT_EXCEEDS_AVAILABLE');
      const portion = creditPortion(
        {
          quantity: original.quantity,
          amount: BigInt(original.amount!),
          taxSubtotal: BigInt(original.taxSubtotal!),
        },
        previous,
        l.quantity,
      );
      credited.set(original.id, previous + l.quantity);
      return {
        ...l,
        ...portion,
        catalogItemId: original.catalogItemId,
        trackInventory: original.trackInventory,
        locationId,
      };
    });
  const sum = (key: 'amount' | 'taxSubtotal' | 'vatAmount') =>
    lines.reduce((s, l) => s + l[key], 0n);
  const amount = sum('amount');
  const preview: PurchaseCreditPreview = {
    purchaseId: row.id,
    version: view.version,
    totals: {
      subtotal: amount.toString(),
      discountAmount: '0',
      amount: amount.toString(),
      taxSubtotal: sum('taxSubtotal').toString(),
      vatAmount: sum('vatAmount').toString(),
    },
    warnings: stockWarnings(ctx, demands),
  };
  return { preview, lines };
}
export function creditPurchase(
  ctx: PurchaseContext,
  actor: Session,
  input: PurchaseCreditData,
) {
  const plan = creditPlan(ctx, actor, input);
  if (
    canonicalJson(plan.preview.warnings) !==
    canonicalJson(input.acknowledgedWarnings)
  )
    throw new DomainError('FINALIZE_WARNINGS_CHANGED');
  const id = randomUUID();
  const totals = plan.preview.totals;
  ctx.db
    .prepare(
      'INSERT INTO purchase_credits(id,purchase_id,document_number,amount,tax_subtotal,vat_amount,reason,created_at,created_by,cashier_name_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      input.purchaseId,
      allocatePurchaseNumber(ctx, 'PCN'),
      BigInt(totals.amount),
      BigInt(totals.taxSubtotal),
      BigInt(totals.vatAmount),
      input.reason,
      ctx.clock.now(),
      actor.cashierId,
      actor.displayName,
    );
  for (const l of plan.lines) {
    const itemId = randomUUID();
    const entry =
      l.receiptItemId && l.trackInventory
        ? insertEntry(ctx.db, {
            catalogItemId: l.catalogItemId!,
            stockLocationId: l.locationId!,
            movementType: 'ADJUSTMENT',
            quantityDelta: -l.quantity,
            referenceType: 'PURCHASE_RETURN_ITEM',
            referenceId: itemId,
            note: input.reason,
            createdByCashierId: actor.cashierId,
            createdAt: ctx.clock.now(),
          })
        : null;
    ctx.db
      .prepare(
        'INSERT INTO purchase_credit_items(id,credit_id,purchase_item_id,receipt_item_id,quantity,amount,tax_subtotal,vat_amount,ledger_entry_id) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        itemId,
        id,
        l.purchaseLineId,
        l.receiptItemId,
        l.quantity,
        l.amount,
        l.taxSubtotal,
        l.vatAmount,
        entry,
      );
  }
  bumpPurchase(ctx, actor, input.purchaseId);
  return purchaseView(ctx.db, ctx.clock, actor, input.purchaseId);
}
