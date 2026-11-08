import { expect, test } from 'vitest';
import {
  purchaseBalance,
  creditPortion,
} from '@/main/features/purchases/domain';

test('credits settle the original bill and excess payments require an actual refund', () => {
  expect(purchaseBalance(100000n, 0n, 60000n, 0n)).toEqual({
    outstanding: 40000n,
    refundDue: 0n,
  });
  expect(purchaseBalance(100000n, 50000n, 60000n, 0n)).toEqual({
    outstanding: 0n,
    refundDue: 10000n,
  });
  expect(purchaseBalance(100000n, 50000n, 60000n, 10000n)).toEqual({
    outstanding: 0n,
    refundDue: 0n,
  });
});
test('partial credits reconcile the original net and tax on the final unit', () => {
  const original = { quantity: 3, amount: 10000n, taxSubtotal: 9009n };
  expect(
    [0, 1, 2].map((prior) => creditPortion(original, prior, 1).amount),
  ).toEqual([3333n, 3333n, 3334n]);
  expect(creditPortion(original, 0, 3)).toEqual({
    amount: 10000n,
    taxSubtotal: 9009n,
    vatAmount: 991n,
  });
});
test('small discounted amounts never yield negative VAT in partial credits', () => {
  const original = { quantity: 10, amount: 6n, taxSubtotal: 5n };
  const parts = Array.from({ length: 10 }, (_, k) =>
    creditPortion(original, k, 1),
  );
  expect(parts.every((p) => p.vatAmount >= 0n && p.taxSubtotal >= 0n)).toBe(
    true,
  );
  expect(parts.reduce((s, p) => s + p.taxSubtotal, 0n)).toBe(5n);
  expect(parts.reduce((s, p) => s + p.vatAmount, 0n)).toBe(1n);
});
test('invalid credits and money cannot pass the domain boundary', () => {
  expect(() =>
    creditPortion({ quantity: 3, amount: 10n, taxSubtotal: 9n }, 2, 2),
  ).toThrow();
  expect(() => purchaseBalance(10n, 11n, 0n, 0n)).toThrow();
  expect(() => purchaseBalance(10n, 0n, 0n, 1n)).toThrow();
});
