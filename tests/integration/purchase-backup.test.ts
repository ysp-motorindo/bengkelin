import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { beforeEach, afterEach, test, expect } from 'vitest';
import { CHANNELS as C } from '@/shared/channels';
import type {
  PurchaseView,
  ReferenceDto,
  RestoreInspectionDto,
} from '@/shared/contracts';
import { validateBackup } from '@/main/features/backups/validation';
import {
  createHarness,
  validSetup,
  value,
  ADMIN_PASSWORD,
  type Harness,
} from './helpers/harness';
import {
  purchaseDraft,
  finalizePurchase,
  purchaseCall,
} from './helpers/purchases';
import { FakeDialogs } from './helpers/fake-print';
let h: Harness;
let dialogs: FakeDialogs;
beforeEach(async () => {
  dialogs = new FakeDialogs();
  h = createHarness({ dialogs, restore: { relaunch: () => {} } });
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
});
afterEach(() => h.close());
async function receivedAndCredited() {
  const { draft } = await purchaseDraft(h);
  let p = await finalizePurchase(h, draft);
  const l = value(
    await h.call<ReferenceDto>(C.references.save, {
      entity: 'stockLocation',
      code: 'PURCHASE_WAREHOUSE',
      label: 'Purchase warehouse',
    }),
  );
  p = value(
    await purchaseCall<PurchaseView>(h, 'receive', {
      requestId: randomUUID(),
      purchaseId: p.id,
      expectedVersion: p.version,
      stockLocationId: l.id,
      lines: [{ purchaseLineId: p.lines[0]!.id, quantity: 6 }],
    }),
  );
  p = value(
    await purchaseCall<PurchaseView>(h, 'credit', {
      requestId: randomUUID(),
      purchaseId: p.id,
      expectedVersion: p.version,
      lines: [
        { purchaseLineId: p.lines[0]!.id, receiptItemId: null, quantity: 1 },
      ],
      reason: 'Undelivered',
      acknowledgedWarnings: [],
    }),
  );
  return p;
}
test('restoring a pre-purchasing backup never reuses bill, receipt or credit numbers', async () => {
  const before = await receivedAndCredited();
  expect(before.documentNumber).toBe('PUR-20260930-0001');
  dialogs.restoreAnswers.push(
    path.resolve('tests/fixtures/db/schema-v021-populated.sqlite'),
  );
  const inspection = value(
    await h.call<RestoreInspectionDto>(C.backups.inspectRestore),
  );
  if (inspection.outcome !== 'READY') throw Error('preview');
  expect(inspection.preview.counts.purchases).toEqual({
    draft: 0,
    finalized: 0,
    void: 0,
  });
  expect(inspection.preview.counts.suppliers).toBe(0);
  value(
    await h.call(C.backups.restore, {
      token: inspection.preview.token,
      confirmed: true,
    }),
  );
  h.reopen();
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  const after = await receivedAndCredited();
  expect(after.documentNumber).toBe('PUR-20260930-0002');
  expect(after.receipts[0]!.documentNumber).toBe('RCV-20260930-0002');
  expect(after.credits[0]!.documentNumber).toBe('PCN-20260930-0002');
});
test('purchase tables are required for backups of the purchasing schema', async () => {
  h.db.exec('DROP TABLE purchase_print_jobs');
  expect(validateBackup(h.file)).toMatchObject({
    ok: false,
    error: 'MISSING_TABLES',
  });
});
