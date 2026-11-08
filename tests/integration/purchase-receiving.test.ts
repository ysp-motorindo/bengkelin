import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, test, expect } from 'vitest';
import { CHANNELS as C } from '@/shared/channels';
import type { PurchaseView, ReferenceDto } from '@/shared/contracts';
import {
  createHarness,
  validSetup,
  value,
  failure,
  ADMIN_PASSWORD,
  type Harness,
} from './helpers/harness';
import {
  purchaseCall,
  purchaseDraft,
  finalizePurchase,
} from './helpers/purchases';
let h: Harness;
beforeEach(async () => {
  h = createHarness();
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
});
afterEach(() => h.close());
async function location(code = 'A') {
  return value(
    await h.call<ReferenceDto>(C.references.save, {
      entity: 'stockLocation',
      code,
      label: code,
    }),
  );
}
test('partial receipts are location-scoped, replay once and cannot exceed delivery due', async () => {
  const { draft, item } = await purchaseDraft(h);
  let p = await finalizePurchase(h, draft);
  const a = await location();
  const b = await location('B');
  const input = {
    requestId: randomUUID(),
    purchaseId: p.id,
    expectedVersion: p.version,
    stockLocationId: a.id,
    lines: [{ purchaseLineId: p.lines[0]!.id, quantity: 6 }],
  };
  p = value(await purchaseCall<PurchaseView>(h, 'receive', input));
  expect(p.lines[0]!.remainingQuantity).toBe(4);
  expect(p.receivingStatus).toBe('PARTIALLY_RECEIVED');
  expect(value(await purchaseCall(h, 'receive', input))).toEqual(p);
  expect(
    failure(
      await purchaseCall(h, 'receive', {
        ...input,
        requestId: randomUUID(),
        expectedVersion: p.version,
        lines: [{ purchaseLineId: p.lines[0]!.id, quantity: 5 }],
      }),
    ).code,
  ).toBe('PURCHASE_RECEIPT_EXCEEDS_REMAINING');
  p = value(
    await purchaseCall<PurchaseView>(h, 'receive', {
      ...input,
      requestId: randomUUID(),
      expectedVersion: p.version,
      stockLocationId: b.id,
      lines: [{ purchaseLineId: p.lines[0]!.id, quantity: 4 }],
    }),
  );
  expect(p.receivingStatus).toBe('COMPLETE');
  expect(p.outstandingAmount).toBe('40000');
  expect(
    value(
      await h.call<{ quantity: number }>(C.inventory.getStock, {
        catalogItemId: item.id,
        stockLocationId: a.id,
      }),
    ).quantity,
  ).toBe(6);
  expect(
    value(
      await h.call<{ quantity: number }>(C.inventory.getStock, {
        catalogItemId: item.id,
        stockLocationId: b.id,
      }),
    ).quantity,
  ).toBe(4);
});
test('reversing a mistaken uncredited receipt reopens delivery without changing money', async () => {
  const { draft, item } = await purchaseDraft(h);
  let p = await finalizePurchase(h, draft);
  const a = await location();
  p = value(
    await purchaseCall<PurchaseView>(h, 'receive', {
      requestId: randomUUID(),
      purchaseId: p.id,
      expectedVersion: p.version,
      stockLocationId: a.id,
      lines: [{ purchaseLineId: p.lines[0]!.id, quantity: 6 }],
    }),
  );
  p = value(
    await purchaseCall<PurchaseView>(h, 'reverseReceipt', {
      requestId: randomUUID(),
      purchaseId: p.id,
      expectedVersion: p.version,
      receiptId: p.receipts[0]!.id,
      reason: 'Wrong delivery entry',
      acknowledgedWarnings: [],
    }),
  );
  expect(p.lines[0]!.remainingQuantity).toBe(10);
  expect(p.outstandingAmount).toBe('40000');
  expect(p.receipts[0]!.reversedAt).not.toBeNull();
  expect(
    value(
      await h.call<{ quantity: number }>(C.inventory.getStock, {
        catalogItemId: item.id,
        stockLocationId: a.id,
      }),
    ).quantity,
  ).toBe(0);
});
test('receipt failure rolls back stock, quantities, counter and command receipt together', async () => {
  const { draft, item } = await purchaseDraft(h);
  const p = await finalizePurchase(h, draft);
  const a = await location();
  h.db.exec(
    "CREATE TRIGGER test_purchase_receipt_failure BEFORE INSERT ON purchase_receipt_items BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END",
  );
  const input = {
    requestId: randomUUID(),
    purchaseId: p.id,
    expectedVersion: p.version,
    stockLocationId: a.id,
    lines: [{ purchaseLineId: p.lines[0]!.id, quantity: 6 }],
  };
  expect(failure(await purchaseCall(h, 'receive', input)).code).toBe(
    'INTERNAL_ERROR',
  );
  expect(
    value(
      await h.call<{ quantity: number }>(C.inventory.getStock, {
        catalogItemId: item.id,
        stockLocationId: a.id,
      }),
    ).quantity,
  ).toBe(0);
  expect(
    h.db
      .prepare(
        "SELECT count(*) AS n FROM purchase_daily_counters WHERE kind='RCV'",
      )
      .get(),
  ).toEqual({ n: 0n });
  h.db.exec('DROP TRIGGER test_purchase_receipt_failure');
  expect(
    value(await purchaseCall<PurchaseView>(h, 'receive', input)).receipts[0]!
      .documentNumber,
  ).toBe('RCV-20260930-0001');
});
