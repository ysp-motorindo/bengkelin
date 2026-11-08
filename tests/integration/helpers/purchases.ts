import { randomUUID } from 'node:crypto';
import { CHANNELS as C } from '@/shared/channels';
import type {
  CatalogItemDto,
  PurchaseDraftOperation,
  PurchaseDraftView,
  PurchaseView,
  ReferenceDto,
  SaveSupplierResult,
  PurchaseWarning,
} from '@/shared/contracts';
import { value, type Harness } from './harness';
export const purchaseCall = <T>(h: Harness, method: string, input?: unknown) =>
  h.call<T>(`bengkelin:purchases:${method}`, input);
export async function purchaseDraft(h: Harness) {
  const s = value(
    await h.call<SaveSupplierResult>('bengkelin:suppliers:save', {
      requestId: randomUUID(),
      name: 'Supplier A',
    }),
  );
  if (!s.saved) throw Error('supplier');
  const units = value(
    await h.call<ReferenceDto[]>(C.references.listActive, { entity: 'unit' }),
  );
  const item = value(
    await h.call<CatalogItemDto>(C.catalog.save, {
      type: 'STOCK_ITEM',
      title: 'Oil',
      unitId: units[0]!.id,
      trackInventory: true,
    }),
  );
  let d = value(
    await h.call<PurchaseDraftView>('bengkelin:purchaseDrafts:create', {
      requestId: randomUUID(),
      billDate: '2026-09-30',
    }),
  );
  const apply = async (op: PurchaseDraftOperation) => {
    d = value(
      await h.call<PurchaseDraftView>('bengkelin:purchaseDrafts:apply', {
        requestId: randomUUID(),
        purchaseId: d.id,
        expectedVersion: d.version,
        op,
      }),
    );
  };
  await apply({ kind: 'updateHeader', changes: { supplierId: s.supplier.id } });
  await apply({ kind: 'addCatalogLine', catalogItemId: item.id, quantity: 10 });
  await apply({
    kind: 'updateLine',
    lineId: d.lines[0]!.id,
    changes: { unitPrice: '10000' },
  });
  await apply({
    kind: 'setPayments',
    payments: [
      { method: 'CASH', amount: '60000', reference: null, note: null },
    ],
  });
  return { draft: d, item };
}
export async function finalizePurchase(h: Harness, d: PurchaseDraftView) {
  const preview = value(
    await purchaseCall<{ warnings: PurchaseWarning[] }>(h, 'previewFinalize', {
      purchaseId: d.id,
    }),
  );
  return value(
    await purchaseCall<PurchaseView>(h, 'finalize', {
      requestId: randomUUID(),
      purchaseId: d.id,
      expectedVersion: d.version,
      acknowledgedWarnings: preview.warnings,
    }),
  );
}
