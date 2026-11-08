import { beforeEach, afterEach, test, expect } from 'vitest';
import { CHANNELS as C } from '@/shared/channels';
import type { DailyReport } from '@/shared/contracts';
import {
  createHarness,
  validSetup,
  value,
  ADMIN_PASSWORD,
  type Harness,
} from './helpers/harness';
import { purchaseDraft, finalizePurchase } from './helpers/purchases';
import { dailyReportCsv } from '@/main/features/reports/csv';
import { REPORT_LABELS } from '@/main/features/reports/labels';
let h: Harness;
beforeEach(async () => {
  h = createHarness();
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
});
afterEach(() => h.close());
test('purchase reports keep bill activity and outgoing payments separate from sales receipts', async () => {
  const { draft } = await purchaseDraft(h);
  await finalizePurchase(h, draft);
  const r = value(
    await h.call<DailyReport>(C.reports.daily, { date: '2026-09-30' }),
  );
  expect(r.purchases.billCount).toBe(1);
  expect(r.purchases.netBeforeAdjustments).toBe('100000');
  expect(r.purchasePayments.amount).toBe('60000');
  expect(r.supplierRefunds.amount).toBe('0');
  expect(r.sales.netBeforeVoids).toBe('0');
  expect(r.payments.received).toBe('0');
  const csv = dailyReportCsv(r, REPORT_LABELS.en);
  expect(csv).toContain('Purchase activity');
  expect(csv).toContain('100000');
});
test('later credits and refunds use their own shop day and remain visible with a sales-channel filter', async () => {
  h.close();
  let now = Date.UTC(2026, 8, 30, 3);
  h = createHarness({ clock: { now: () => new Date(now).toISOString() } });
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  const { draft } = await purchaseDraft(h);
  let p = await finalizePurchase(h, draft);
  now = Date.UTC(2026, 8, 30, 17);
  const { purchaseCall } = await import('./helpers/purchases');
  const { randomUUID } = await import('node:crypto');
  const lines = [
    { purchaseLineId: p.lines[0]!.id, receiptItemId: null, quantity: 5 },
  ];
  p = value(
    await purchaseCall<import('@/shared/contracts').PurchaseView>(h, 'credit', {
      requestId: randomUUID(),
      purchaseId: p.id,
      expectedVersion: p.version,
      lines,
      reason: 'Not delivered',
      acknowledgedWarnings: [],
    }),
  );
  p = value(
    await purchaseCall(h, 'recordRefund', {
      requestId: randomUUID(),
      purchaseId: p.id,
      expectedVersion: p.version,
      amount: '10000',
      method: 'CASH',
    }),
  );
  const channels = value(
    await h.call<import('@/shared/contracts').ReferenceDto[]>(
      C.references.listActive,
      { entity: 'channel' },
    ),
  );
  const r = value(
    await h.call<DailyReport>(C.reports.daily, {
      date: '2026-10-01',
      channelId: channels[0]!.id,
    }),
  );
  expect(r.purchases.billCount).toBe(0);
  expect(r.purchases.creditAmount).toBe('50000');
  expect(r.purchases.netAfterAdjustments).toBe('-50000');
  expect(r.supplierRefunds.amount).toBe('10000');
  expect(r.purchasePayments.amount).toBe('0');
  expect(r.sales.netBeforeVoids).toBe('0');
  const original = value(
    await h.call<DailyReport>(C.reports.daily, { date: '2026-09-30' }),
  );
  expect(original.purchases.netAfterAdjustments).toBe('100000');
  expect(original.purchasePayments.amount).toBe('60000');
});
