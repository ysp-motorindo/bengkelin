import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, test } from 'vitest';
import { CHANNELS as C } from '@/shared/channels';
import type { PurchaseView } from '@/shared/contracts';
import {
  ADMIN_PASSWORD,
  createHarness,
  validSetup,
  value,
  failure,
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
test('finalizing a partially paid supplier bill creates no stock movement', async () => {
  const { draft } = await purchaseDraft(h);
  const p = await finalizePurchase(h, draft);
  expect(p.documentNumber).toBe('PUR-20260930-0001');
  expect(p.outstandingAmount).toBe('40000');
  expect(p.settlementStatus).toBe('PARTIALLY_PAID');
  expect(
    h.db.prepare('SELECT COUNT(*) AS n FROM stock_ledger_entries').get(),
  ).toEqual({ n: 0n });
  expect(p.receivingStatus).toBe('NOT_RECEIVED');
});
test('missing prices block finalization but explicit zero produces an acknowledgment warning', async () => {
  const { draft: d } = await purchaseDraft(h);
  const update = {
    requestId: randomUUID(),
    purchaseId: d.id,
    expectedVersion: d.version,
    op: {
      kind: 'updateLine',
      lineId: d.lines[0]!.id,
      changes: { unitPrice: null },
    },
  };
  value(await h.call('bengkelin:purchaseDrafts:apply', update));
  const preview = value(
    await purchaseCall<{ errors: { code: string }[] }>(h, 'previewFinalize', {
      purchaseId: d.id,
    }),
  );
  expect(preview.errors.map((e) => e.code)).toContain('PRICE_REQUIRED');
});
test('payments are bounded and retries replay exactly once', async () => {
  const { draft } = await purchaseDraft(h);
  const p = await finalizePurchase(h, draft);
  const input = {
    requestId: randomUUID(),
    purchaseId: p.id,
    expectedVersion: p.version,
    method: 'BANK_TRANSFER',
    amount: '40000',
  };
  const paid = value(
    await purchaseCall<PurchaseView>(h, 'recordPayment', input),
  );
  expect(paid.outstandingAmount).toBe('0');
  expect(value(await purchaseCall(h, 'recordPayment', input))).toEqual(paid);
  expect(
    failure(
      await purchaseCall(h, 'recordPayment', {
        ...input,
        requestId: randomUUID(),
        expectedVersion: paid.version,
        amount: '1',
      }),
    ).code,
  ).toBe('PAYMENT_EXCEEDS_AMOUNT');
  expect(
    failure(
      await purchaseCall(h, 'recordRefund', {
        ...input,
        requestId: randomUUID(),
        expectedVersion: paid.version,
        amount: '1',
      }),
    ).code,
  ).toBe('REFUND_EXCEEDS_AMOUNT');
  expect(paid.outgoingPayments).toHaveLength(2);
});
test('history uses original supplier identity and allows settlement after deactivation', async () => {
  const { draft } = await purchaseDraft(h);
  const p = await finalizePurchase(h, draft);
  value(
    await h.call('bengkelin:suppliers:save', {
      requestId: randomUUID(),
      id: p.supplier!.id,
      name: 'Renamed',
      isActive: false,
    }),
  );
  const got = value(
    await purchaseCall<PurchaseView>(h, 'get', { purchaseId: p.id }),
  );
  expect(got.supplier!.name).toBe('Supplier A');
  expect(
    value(
      await purchaseCall<PurchaseView>(h, 'recordPayment', {
        requestId: randomUUID(),
        purchaseId: p.id,
        expectedVersion: p.version,
        method: 'CASH',
        amount: '1',
      }),
    ).outstandingAmount,
  ).toBe('39999');
});
test('checkout write failure rolls back the bill and its allocated document number', async () => {
  const { draft } = await purchaseDraft(h);
  h.db.exec(
    "CREATE TRIGGER test_purchase_checkout_failure BEFORE INSERT ON purchase_payments BEGIN SELECT RAISE(ABORT,'injected checkout failure'); END",
  );
  const input = {
    requestId: randomUUID(),
    purchaseId: draft.id,
    expectedVersion: draft.version,
    acknowledgedWarnings: [],
  };
  expect(failure(await purchaseCall(h, 'finalize', input)).code).toBe(
    'INTERNAL_ERROR',
  );
  expect(
    h.db
      .prepare('SELECT status,document_number FROM purchases WHERE id=?')
      .get(draft.id),
  ).toEqual({ status: 'DRAFT', document_number: null });
  expect(
    h.db.prepare('SELECT count(*) AS n FROM purchase_daily_counters').get(),
  ).toEqual({ n: 0n });
  h.db.exec('DROP TRIGGER test_purchase_checkout_failure');
  expect(
    value(await purchaseCall<PurchaseView>(h, 'finalize', input))
      .documentNumber,
  ).toBe('PUR-20260930-0001');
});
test('history filters and totals use the same bill selection',async()=>{
 const {draft}=await purchaseDraft(h);const p=await finalizePurchase(h,draft);
 const page=value(await purchaseCall<{items:PurchaseView[];payableAmount:string;refundDue:string;hasMore:boolean}>(h,'search',{query:'Supplier A',settlement:'PAYABLE'}));
 expect(page.items.map(x=>x.id)).toEqual([p.id]);expect(page.payableAmount).toBe('40000');expect(page.refundDue).toBe('0');expect(page.hasMore).toBe(false);
 expect(value(await purchaseCall<{items:PurchaseView[]}>(h,'search',{settlement:'REFUND_DUE'})).items).toEqual([]);
});
