import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, test, expect } from 'vitest';
import { CHANNELS as C } from '@/shared/channels';
import type {
  PurchaseView,
  PurchaseCreditPreview,
  ReferenceDto,
} from '@/shared/contracts';
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
test('undelivered credits and physical returns leave a refund due until money is received', async () => {
  const { draft, item } = await purchaseDraft(h);
  let p = await finalizePurchase(h, draft);
  const a = value(
    await h.call<ReferenceDto>(C.references.save, {
      entity: 'stockLocation',
      code: 'A',
      label: 'A',
    }),
  );
  const b = value(
    await h.call<ReferenceDto>(C.references.save, {
      entity: 'stockLocation',
      code: 'B',
      label: 'B',
    }),
  );
  for (const [location, quantity] of [
    [a, 6],
    [b, 2],
  ] as const)
    p = value(
      await purchaseCall<PurchaseView>(h, 'receive', {
        requestId: randomUUID(),
        purchaseId: p.id,
        expectedVersion: p.version,
        stockLocationId: location.id,
        lines: [{ purchaseLineId: p.lines[0]!.id, quantity }],
      }),
    );
  const lines = [
    { purchaseLineId: p.lines[0]!.id, receiptItemId: null, quantity: 2 },
    {
      purchaseLineId: p.lines[0]!.id,
      receiptItemId: p.receipts.find((r) => r.stockLocationId === a.id)!
        .lines[0]!.id,
      quantity: 3,
    },
  ];
  const preview = value(
    await purchaseCall<PurchaseCreditPreview>(h, 'previewCredit', {
      purchaseId: p.id,
      lines,
    }),
  );
  expect(preview.totals.amount).toBe('50000');
  const input = {
    requestId: randomUUID(),
    purchaseId: p.id,
    expectedVersion: p.version,
    lines,
    reason: 'Supplier agreed',
    acknowledgedWarnings: preview.warnings,
  };
  p = value(await purchaseCall<PurchaseView>(h, 'credit', input));
  expect(p.refundDue).toBe('10000');
  expect(p.outstandingAmount).toBe('0');
  expect(p.receivingStatus).toBe('COMPLETE');
  expect(value(await purchaseCall(h, 'credit', input))).toEqual(p);
  expect(
    value(
      await h.call<{ quantity: number }>(C.inventory.getStock, {
        catalogItemId: item.id,
        stockLocationId: a.id,
      }),
    ).quantity,
  ).toBe(3);
  expect(
    value(
      await h.call<{ quantity: number }>(C.inventory.getStock, {
        catalogItemId: item.id,
        stockLocationId: b.id,
      }),
    ).quantity,
  ).toBe(2);
  p = value(
    await purchaseCall<PurchaseView>(h, 'recordRefund', {
      requestId: randomUUID(),
      purchaseId: p.id,
      expectedVersion: p.version,
      amount: '10000',
      method: 'CASH',
    }),
  );
  expect(p.settlementStatus).toBe('SETTLED');
  expect(
    failure(
      await purchaseCall(h, 'reverseReceipt', {
        requestId: randomUUID(),
        purchaseId: p.id,
        expectedVersion: p.version,
        receiptId: p.receipts.find((r) => r.stockLocationId === a.id)!.id,
        reason: 'Mistake',
        acknowledgedWarnings: [],
      }),
    ).code,
  ).toBe('PURCHASE_RECEIPT_ALREADY_CREDITED');
});
test('negative stock return requires acknowledgment of the current stock result', async () => {
  const { draft, item } = await purchaseDraft(h);
  let p = await finalizePurchase(h, draft);
  const a = value(
    await h.call<ReferenceDto>(C.references.save, {
      entity: 'stockLocation',
      code: 'A',
      label: 'A',
    }),
  );
  p = value(
    await purchaseCall<PurchaseView>(h, 'receive', {
      requestId: randomUUID(),
      purchaseId: p.id,
      expectedVersion: p.version,
      stockLocationId: a.id,
      lines: [{ purchaseLineId: p.lines[0]!.id, quantity: 6 }],
    }),
  );
  value(
    await h.call(C.inventory.adjust, {
      requestId: randomUUID(),
      catalogItemId: item.id,
      stockLocationId: a.id,
      quantityDelta: -5,
      reason: 'Sold elsewhere',
    }),
  );
  const lines = [
    {
      purchaseLineId: p.lines[0]!.id,
      receiptItemId: p.receipts[0]!.lines[0]!.id,
      quantity: 3,
    },
  ];
  const preview = value(
    await purchaseCall<PurchaseCreditPreview>(h, 'previewCredit', {
      purchaseId: p.id,
      lines,
    }),
  );
  expect(preview.warnings[0]!.params.resultingStock).toBe('-2');
  const input = {
    requestId: randomUUID(),
    purchaseId: p.id,
    expectedVersion: p.version,
    lines,
    reason: 'Returned',
    acknowledgedWarnings: [],
  };
  expect(failure(await purchaseCall(h, 'credit', input)).code).toBe(
    'FINALIZE_WARNINGS_CHANGED',
  );
  p = value(
    await purchaseCall<PurchaseView>(h, 'credit', {
      ...input,
      acknowledgedWarnings: preview.warnings,
    }),
  );
  expect(p.credits).toHaveLength(1);
});
test('credit requests reject quantities beyond their source and rollback the note on stock failure', async () => {
  const { draft } = await purchaseDraft(h);
  let p = await finalizePurchase(h, draft);
  const a = value(
    await h.call<ReferenceDto>(C.references.save, {
      entity: 'stockLocation',
      code: 'A',
      label: 'A',
    }),
  );
  p = value(
    await purchaseCall<PurchaseView>(h, 'receive', {
      requestId: randomUUID(),
      purchaseId: p.id,
      expectedVersion: p.version,
      stockLocationId: a.id,
      lines: [{ purchaseLineId: p.lines[0]!.id, quantity: 6 }],
    }),
  );
  const line = {
    purchaseLineId: p.lines[0]!.id,
    receiptItemId: p.receipts[0]!.lines[0]!.id,
    quantity: 7,
  };
  expect(
    failure(
      await purchaseCall(h, 'previewCredit', {
        purchaseId: p.id,
        lines: [line],
      }),
    ).code,
  ).toBe('PURCHASE_CREDIT_EXCEEDS_AVAILABLE');
  h.db.exec(
    "CREATE TRIGGER test_purchase_return_failure BEFORE INSERT ON stock_ledger_entries WHEN NEW.reference_type='PURCHASE_RETURN_ITEM' BEGIN SELECT RAISE(ABORT,'injected return failure'); END",
  );
  const input = {
    requestId: randomUUID(),
    purchaseId: p.id,
    expectedVersion: p.version,
    lines: [{ ...line, quantity: 2 }],
    reason: 'Returned',
    acknowledgedWarnings: [],
  };
  expect(failure(await purchaseCall(h, 'credit', input)).code).toBe(
    'INTERNAL_ERROR',
  );
  expect(
    h.db.prepare('SELECT count(*) AS n FROM purchase_credits').get(),
  ).toEqual({ n: 0n });
  h.db.exec('DROP TRIGGER test_purchase_return_failure');
  expect(
    value(await purchaseCall<PurchaseView>(h, 'credit', input)).credits[0]!
      .documentNumber,
  ).toBe('PCN-20260930-0001');
});
