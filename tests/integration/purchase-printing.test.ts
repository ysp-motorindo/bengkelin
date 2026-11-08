import { beforeEach, afterEach, test, expect } from 'vitest';
import { CHANNELS as C } from '@/shared/channels';
import type {
  PrintPreviewDto,
  PrintOutcomeDto,
  PurchasePrintInput,
} from '@/shared/contracts';
import {
  createHarness,
  validSetup,
  value,
  ADMIN_PASSWORD,
  type Harness,
} from './helpers/harness';
import { purchaseDraft, finalizePurchase } from './helpers/purchases';
import { FakePrintDriver, FakeDialogs } from './helpers/fake-print';
let h: Harness;
let driver: FakePrintDriver;
let dialogs: FakeDialogs;
beforeEach(async () => {
  driver = new FakePrintDriver();
  dialogs = new FakeDialogs();
  h = createHarness({ printDriver: driver, dialogs });
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
});
afterEach(() => h.close());
test('purchase bill printing uses saved prices in every format and escapes supplier content', async () => {
  const { draft } = await purchaseDraft(h);
  value(
    await h.call('bengkelin:suppliers:save', {
      requestId: crypto.randomUUID(),
      id: draft.supplier!.id,
      expectedVersion: draft.supplier!.version,
      name: 'Supplier <script>bad</script>',
    }),
  );
  const p = await finalizePurchase(h, draft);
  for (const format of ['A4', 'THERMAL_58', 'THERMAL_80'] as const) {
    const result = value(
      await h.call<PrintPreviewDto>('bengkelin:purchasePrinting:preview', {
        purchaseId: p.id,
        documentId: p.id,
        documentType: 'BILL',
        format,
      }),
    );
    expect(result.html).toContain('Faktur Pembelian');
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('PUR-20260930-0001');
    expect(result.html).toContain('data-money="amount"');
    expect(result.html).toContain('data-money="outstandingAmount"');
  }
});
test('failed printing leaves the bill recorded and does not set a reprint flag', async () => {
  const { draft } = await purchaseDraft(h);
  const p = await finalizePurchase(h, draft);
  const input: PurchasePrintInput = {
    purchaseId: p.id,
    documentId: p.id,
    documentType: 'BILL',
    format: 'A4',
  };
  driver.willReturn({ outcome: 'FAILED', code: 'PRINT_FAILED' });
  const first = value(
    await h.call<PrintOutcomeDto>('bengkelin:purchasePrinting:print', input),
  );
  expect(first.outcome).toBe('FAILED');
  const second = value(
    await h.call<PrintOutcomeDto>('bengkelin:purchasePrinting:print', input),
  );
  expect(second.outcome).toBe('PRINTED');
  expect(second.isReprint).toBe(false);
  const third = value(
    await h.call<PrintOutcomeDto>('bengkelin:purchasePrinting:print', input),
  );
  expect(third.isReprint).toBe(true);
  expect(
    h.db.prepare('SELECT status FROM purchases WHERE id=?').get(p.id),
  ).toEqual({ status: 'FINALIZED' });
  expect(
    value(
      await h.call<PrintOutcomeDto>(
        'bengkelin:purchasePrinting:exportPdf',
        input,
      ),
    ).outcome,
  ).toBe('CANCELLED');
});

test('purchase printouts show the entered bill date separately from posting time', async () => {
  const { draft } = await purchaseDraft(h);
  const changed = value(
    await h.call<import('@/shared/contracts').PurchaseDraftView>(
      C.purchaseDrafts.apply,
      {
        requestId: crypto.randomUUID(),
        purchaseId: draft.id,
        expectedVersion: draft.version,
        op: { kind: 'updateHeader', changes: { billDate: '2026-09-29' } },
      },
    ),
  );
  const p = await finalizePurchase(h, changed);
  for (const format of ['A4', 'THERMAL_58', 'THERMAL_80'] as const) {
    const result = value(
      await h.call<PrintPreviewDto>('bengkelin:purchasePrinting:preview', {
        purchaseId: p.id,
        documentId: p.id,
        documentType: 'BILL',
        format,
      }),
    );
    expect(result.html).toContain('29/09/2026');
    expect(result.html).toContain('Tanggal faktur');
    expect(result.html).toContain('Dicatat pada');
    expect(result.html).toContain('30/09/2026');
  }
});
