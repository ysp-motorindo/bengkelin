import { randomUUID } from 'node:crypto';
import { CHANNELS as C } from '@/shared/channels';
import type {
  PurchaseDraftView,
  PurchaseDraftOperation,
  PurchaseView,
  SaveSupplierResult,
} from '@/shared/contracts';
import type { FixtureContext } from './populate';
export async function populatePurchases(
  call: FixtureContext['call'],
  catalogItemId: string,
  stockLocationId: string,
) {
  const invoke = async <T>(channel: string, input?: unknown): Promise<T> => {
    const r = await call<T>(channel, input);
    if (!r.ok) throw Error(channel + ': ' + JSON.stringify(r.error));
    return r.value;
  };
  const supplier = await invoke<SaveSupplierResult>(C.suppliers.save, {
    requestId: randomUUID(),
    name: 'Pemasok Suku Cadang',
    phoneNumber: '081211112222',
  });
  if (!supplier.saved) throw Error('supplier');
  const create = () =>
    invoke<PurchaseDraftView>(C.purchaseDrafts.create, {
      requestId: randomUUID(),
      billDate: '2026-09-30',
    });
  const apply = (d: PurchaseDraftView, op: PurchaseDraftOperation) =>
    invoke<PurchaseDraftView>(C.purchaseDrafts.apply, {
      requestId: randomUUID(),
      purchaseId: d.id,
      expectedVersion: d.version,
      op,
    });
  const prepare = async (quantity: number) => {
    let d = await create();
    d = await apply(d, {
      kind: 'updateHeader',
      changes: { supplierId: supplier.supplier.id },
    });
    d = await apply(d, { kind: 'addCatalogLine', catalogItemId, quantity });
    return apply(d, {
      kind: 'updateLine',
      lineId: d.lines[0]!.id,
      changes: { unitPrice: '10000' },
    });
  };
  const finalize = (d: PurchaseDraftView) =>
    invoke<PurchaseView>(C.purchases.finalize, {
      requestId: randomUUID(),
      purchaseId: d.id,
      expectedVersion: d.version,
      acknowledgedWarnings: [],
    });
  let d = await prepare(10);
  d = await apply(d, {
    kind: 'setDiscounts',
    lineId: d.lines[0]!.id,
    stages: [0],
  });
  d = await apply(d, {
    kind: 'setPayments',
    payments: [
      { method: 'CASH', amount: '100000', reference: null, note: null },
    ],
  });
  let p = await finalize(d);
  const receive = (p: PurchaseView, quantity: number) =>
    invoke<PurchaseView>(C.purchases.receive, {
      requestId: randomUUID(),
      purchaseId: p.id,
      expectedVersion: p.version,
      stockLocationId,
      lines: [{ purchaseLineId: p.lines[0]!.id, quantity }],
    });
  p = await receive(p, 6);
  p = await invoke<PurchaseView>(C.purchases.credit, {
    requestId: randomUUID(),
    purchaseId: p.id,
    expectedVersion: p.version,
    lines: [
      {
        purchaseLineId: p.lines[0]!.id,
        receiptItemId: p.receipts[0]!.lines[0]!.id,
        quantity: 3,
      },
    ],
    reason: 'Retur pemasok',
    acknowledgedWarnings: [],
  });
  p = await invoke<PurchaseView>(C.purchases.recordRefund, {
    requestId: randomUUID(),
    purchaseId: p.id,
    expectedVersion: p.version,
    method: 'CASH',
    amount: '30000',
  });
  p = await receive(p, 2);
  const uncredited = p.receipts.find((r) =>
    r.lines.every((i) => i.creditedQuantity === 0),
  )!;
  p = await invoke<PurchaseView>(C.purchases.reverseReceipt, {
    requestId: randomUUID(),
    purchaseId: p.id,
    expectedVersion: p.version,
    receiptId: uncredited.id,
    reason: 'Koreksi penerimaan',
    acknowledgedWarnings: [],
  });
  await invoke(C.purchasePrinting.print, {
    purchaseId: p.id,
    documentId: p.id,
    documentType: 'BILL',
    format: 'A4',
  });
  const open = await create();
  let discarded = await create();
  discarded = await apply(discarded, { kind: 'discard' });
  let voided = await finalize(await prepare(1));
  voided = await invoke<PurchaseView>(C.purchases.void, {
    requestId: randomUUID(),
    purchaseId: voided.id,
    expectedVersion: voided.version,
    reason: 'Koreksi faktur',
  });
  return {
    purchasePaid: p.id,
    purchaseOpen: open.id,
    purchaseDiscarded: discarded.id,
    purchaseVoid: voided.id,
  };
}
