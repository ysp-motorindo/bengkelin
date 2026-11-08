import { expect, test } from 'vitest';
import {
  purchaseDraftCommandSchema,
  saveSupplierInputSchema,
  purchaseCreditInputSchema,
} from '@/shared/contracts/purchases';
const id = '11111111-1111-4111-8111-111111111111';
const base = { requestId: id, purchaseId: id, expectedVersion: 1 };
test('purchase prices distinguish missing and zero and reject negative values', () => {
  expect(
    purchaseDraftCommandSchema.safeParse({
      ...base,
      op: { kind: 'updateLine', lineId: id, changes: { unitPrice: null } },
    }).success,
  ).toBe(true);
  expect(
    purchaseDraftCommandSchema.safeParse({
      ...base,
      op: { kind: 'updateLine', lineId: id, changes: { unitPrice: '0' } },
    }).success,
  ).toBe(true);
  expect(
    purchaseDraftCommandSchema.safeParse({
      ...base,
      op: { kind: 'updateLine', lineId: id, changes: { unitPrice: '-1' } },
    }).success,
  ).toBe(false);
});
test('supplier creation validates name and contact boundaries', () => {
  expect(
    saveSupplierInputSchema.safeParse({ requestId: id, name: ' ' }).success,
  ).toBe(false);
  expect(
    saveSupplierInputSchema.safeParse({
      requestId: id,
      name: 'Supplier',
      email: 'bad',
    }).success,
  ).toBe(false);
  expect(
    saveSupplierInputSchema.safeParse({
      requestId: id,
      name: 'Supplier',
      role: 'ADMIN',
    }).success,
  ).toBe(false);
});
test('credit input requires positive bounded quantities and a reason', () => {
  expect(
    purchaseCreditInputSchema.safeParse({
      ...base,
      lines: [{ purchaseLineId: id, receiptItemId: null, quantity: 0 }],
      reason: 'Mistake',
      acknowledgedWarnings: [],
    }).success,
  ).toBe(false);
});
