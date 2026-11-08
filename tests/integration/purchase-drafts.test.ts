import { afterEach, beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createHarness,
  validSetup,
  value,
  failure,
  ADMIN_PASSWORD,
  type Harness,
} from './helpers/harness';
import { CHANNELS as C } from '@/shared/channels';
import type {
  PurchaseDraftView,
  SaveSupplierResult,
  ReferenceDto,
  CatalogItemDto,
} from '@/shared/contracts';
let h: Harness;
beforeEach(async () => {
  h = createHarness();
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
});
afterEach(() => h.close());
const call = <T>(area: string, method: string, input?: unknown) =>
  h.call<T>(`bengkelin:${area}:${method}`, input);
async function supplier() {
  const result = value(
    await call<SaveSupplierResult>('suppliers', 'save', {
      requestId: randomUUID(),
      name: 'Supplier A',
    }),
  );
  if (!result.saved) throw Error('unsaved');
  return result.supplier;
}
async function draft() {
  return value(
    await call<PurchaseDraftView>('purchaseDrafts', 'create', {
      requestId: randomUUID(),
      billDate: '2026-09-30',
    }),
  );
}
async function apply(d: PurchaseDraftView, op: unknown) {
  return value(
    await call<PurchaseDraftView>('purchaseDrafts', 'apply', {
      requestId: randomUUID(),
      purchaseId: d.id,
      expectedVersion: d.version,
      op,
    }),
  );
}
test('purchase draft keeps blank and explicit zero prices separate after reopening', async () => {
  const s = await supplier();
  let d = await draft();
  d = await apply(d, { kind: 'updateHeader', changes: { supplierId: s.id } });
  const units = value(
    await h.call<ReferenceDto[]>(C.references.listActive, { entity: 'unit' }),
  );
  const item = value(
    await h.call<CatalogItemDto>(C.catalog.save, {
      type: 'STOCK_ITEM',
      title: 'Oil',
      unitId: units[0]!.id,
      sku: 'OIL',
      trackInventory: true,
    }),
  );
  d = await apply(d, { kind: 'addCatalogLine', catalogItemId: item.id });
  expect(d.lines[0]!.unitPrice).toBeNull();
  expect(d.totals).toBeNull();
  d = await apply(d, {
    kind: 'updateLine',
    lineId: d.lines[0]!.id,
    changes: { unitPrice: '0' },
  });
  expect(d.totals!.amount).toBe('0');
  h.reopen();
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  d = value(
    await call<PurchaseDraftView>('purchaseDrafts', 'get', {
      purchaseId: d.id,
    }),
  );
  expect(d.lines[0]!.unitPrice).toBe('0');
  d = await apply(d, {
    kind: 'updateLine',
    lineId: d.lines[0]!.id,
    changes: { unitPrice: null },
  });
  expect(d.totals).toBeNull();
});
test('draft mutations replay once and reject stale writes without losing work', async () => {
  let d = await draft();
  const command = {
    requestId: randomUUID(),
    purchaseId: d.id,
    expectedVersion: d.version,
    op: { kind: 'updateHeader', changes: { note: 'Kept' } },
  };
  d = value(await call<PurchaseDraftView>('purchaseDrafts', 'apply', command));
  expect(value(await call('purchaseDrafts', 'apply', command))).toEqual(d);
  expect(
    failure(
      await call('purchaseDrafts', 'apply', {
        ...command,
        requestId: randomUUID(),
      }),
    ).code,
  ).toBe('DRAFT_VERSION_CONFLICT');
});
test('suppliers validate and warn about duplicate normalized phones', async () => {
  expect(
    failure(
      await call('suppliers', 'save', { requestId: randomUUID(), name: ' ' }),
    ).code,
  ).toBe('VALIDATION_FAILED');
  value(
    await call('suppliers', 'save', {
      requestId: randomUUID(),
      name: 'One',
      phoneNumber: '08123456789',
    }),
  );
  const second = {
    requestId: randomUUID(),
    name: 'Two',
    phoneNumber: '0812 3456 789',
  };
  expect(
    value(await call<SaveSupplierResult>('suppliers', 'save', second)).saved,
  ).toBe(false);
  expect(
    value(
      await call<SaveSupplierResult>('suppliers', 'save', {
        ...second,
        requestId: randomUUID(),
        acknowledgeDuplicates: true,
      }),
    ).saved,
  ).toBe(true);
});
