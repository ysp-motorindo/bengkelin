import { describe, expect, test } from 'vitest';
import { calculateCheckoutPayments } from '@/shared/checkout-payments';
import type { CheckoutAllocationDto, PaymentMethod } from '@/shared/contracts';

const tender = (
  method: PaymentMethod,
  amount: string,
  sequence = 1,
): CheckoutAllocationDto => ({
  sequence,
  method,
  amount,
  reference: null,
  note: null,
});

describe('checkout received and applied payments', () => {
  test('returns only excess cash as change', () => {
    const result = calculateCheckoutPayments('100000', [
      tender('QRIS', '60000'),
      tender('CASH', '50000', 2),
    ]);
    expect(result.summary).toEqual({
      receivedAmount: '110000',
      cashReceived: '50000',
      changeAmount: '10000',
      nonCashExcess: '0',
    });
    expect(
      result.allocations.map(({ method, amount }) => ({ method, amount })),
    ).toEqual([
      { method: 'QRIS', amount: '60000' },
      { method: 'CASH', amount: '40000' },
    ]);
  });
  test('combines all non-cash before applying ordered cash rows and preserves metadata', () => {
    const rows = [
      tender('CASH', '30000'),
      { ...tender('QRIS', '60000', 2), reference: 'ref', note: 'note' },
      tender('CASH', '30000', 3),
      tender('CASH', '10000', 4),
    ];
    expect(calculateCheckoutPayments('100000', rows).allocations).toEqual([
      rows[0],
      rows[1],
      { ...rows[2], amount: '10000' },
    ]);
    expect(rows[2].amount).toBe('30000');
  });
  test('combined non-cash excess makes change unavailable and omits all cash', () => {
    const rows = [
      tender('QRIS', '60000'),
      tender('QRIS', '50000', 2),
      tender('CASH', '20000', 3),
    ];
    expect(calculateCheckoutPayments('100000', rows)).toEqual({
      allocations: rows.slice(0, 2),
      summary: {
        receivedAmount: '130000',
        cashReceived: '20000',
        changeAmount: null,
        nonCashExcess: '10000',
      },
    });
  });
  test.each([
    ['100000', [], '0', '0', '0'],
    ['100000', [tender('CASH', '20000')], '20000', '20000', '0'],
    ['0', [tender('CASH', '20000')], '20000', '20000', '20000'],
  ])(
    'handles empty, insufficient and zero total: %s %j',
    (amount, rows, receivedAmount, cashReceived, changeAmount) => {
      const result = calculateCheckoutPayments(
        amount,
        rows as CheckoutAllocationDto[],
      );
      expect(result.summary).toEqual({
        receivedAmount,
        cashReceived,
        changeAmount,
        nonCashExcess: '0',
      });
      if (amount === '0') expect(result.allocations).toEqual([]);
    },
  );
  test('validates individual money and aggregate overflow', () => {
    expect(() =>
      calculateCheckoutPayments('100000', [
        tender('CASH', '9223372036854775807'),
        tender('QRIS', '1', 2),
      ]),
    ).toThrow('Amount exceeds signed 64-bit range');
    expect(() => calculateCheckoutPayments('9223372036854775808', [])).toThrow(
      'Amount exceeds signed 64-bit range',
    );
  });
});
