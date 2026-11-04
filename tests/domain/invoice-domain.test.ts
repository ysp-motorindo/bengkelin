import { describe, expect, test } from 'vitest';
import {
  applyDiscounts,
  calculateDueDate,
  calculateInvoice,
  derivePaymentStatus,
} from '@/main/features/invoices/domain';

const code = (c: string) => expect.objectContaining({ code: c });

describe('applyDiscounts', () => {
  test('spec critical example', () => {
    const r = applyDiscounts(100000n, [3000, 5000, 1000]);
    expect(r.amount).toBe(31500n);
    expect(r.stageAmounts).toEqual([30000n, 35000n, 3500n]);
    expect(r.discountTotal).toBe(68500n);
  });
  test('floors', () => {
    expect(applyDiscounts(101n, [5000]).amount).toBe(51n);
    expect(applyDiscounts(101n, [5000]).stageAmounts).toEqual([50n]);
  });
  test('fractional percentage 2.75%', () => {
    const r = applyDiscounts(100000n, [275]);
    expect(r.stageAmounts).toEqual([2750n]);
    expect(r.amount).toBe(97250n);
    expect(applyDiscounts(1000n, [275]).stageAmounts).toEqual([27n]);
  });
  test('no stages', () => {
    expect(applyDiscounts(500n, [])).toEqual({
      amount: 500n,
      discountTotal: 0n,
      stageAmounts: [],
    });
  });
  test('four stages ok, five rejected', () => {
    expect(
      applyDiscounts(10000n, [1000, 1000, 1000, 1000]).stageAmounts,
    ).toHaveLength(4);
    expect(() => applyDiscounts(10000n, [1, 1, 1, 1, 1])).toThrowError(
      code('TOO_MANY_DISCOUNT_STAGES'),
    );
  });
  test('100% and 0%', () => {
    expect(applyDiscounts(777n, [10000]).amount).toBe(0n);
    expect(applyDiscounts(777n, [0]).amount).toBe(777n);
  });
  test('zero base', () => {
    expect(applyDiscounts(0n, [5000]).amount).toBe(0n);
  });
  test.each([-1, 10001, 1.5, NaN])('rejects bps %s', (bps) => {
    expect(() => applyDiscounts(100n, [bps])).toThrowError(
      code('INVALID_PERCENTAGE'),
    );
  });
  test('rejects negative base and overflow base', () => {
    expect(() => applyDiscounts(-1n, [])).toThrowError(code('NEGATIVE_MONEY'));
    expect(() => applyDiscounts(2n ** 63n, [])).toThrowError(
      code('MONEY_OVERFLOW'),
    );
  });
  test('handles max int64 without overflow', () => {
    const max = 2n ** 63n - 1n;
    expect(applyDiscounts(max, [5000]).amount).toBe(
      max - (max * 5000n) / 10000n,
    );
  });
});

describe('calculateInvoice', () => {
  test('lines and invoice discounts', () => {
    const r = calculateInvoice({
      lines: [
        { quantity: 2, unitPrice: 50000n, discountStages: [3000, 5000, 1000] },
        { quantity: 3, unitPrice: 10000n, discountStages: [] },
      ],
      discountStages: [1000, 500],
    });
    expect(r.lines[0]).toMatchObject({
      subtotal: 100000n,
      amount: 31500n,
      discountTotal: 68500n,
      stageAmounts: [30000n, 35000n, 3500n],
    });
    expect(r.lines[1]).toMatchObject({
      subtotal: 30000n,
      amount: 30000n,
      discountTotal: 0n,
    });
    expect(r.subtotal).toBe(130000n);
    expect(r.itemDiscountTotal).toBe(68500n);
    // discounted sum 61500; -10% = 6150 -> 55350; -5% = 2767 -> 52583
    expect(r.invoiceDiscountStageAmounts).toEqual([6150n, 2767n]);
    expect(r.invoiceDiscountTotal).toBe(8917n);
    expect(r.discountAmount).toBe(68500n + 8917n);
    expect(r.amount).toBe(52583n);
    expect(r.subtotal - r.discountAmount).toBe(r.amount);
  });
  test('empty invoice is zero', () => {
    const r = calculateInvoice({ lines: [], discountStages: [] });
    expect(r).toMatchObject({ subtotal: 0n, discountAmount: 0n, amount: 0n });
  });
  test('zero price line and 100% discount', () => {
    const r = calculateInvoice({
      lines: [
        { quantity: 1, unitPrice: 0n, discountStages: [] },
        { quantity: 1, unitPrice: 5000n, discountStages: [10000] },
      ],
      discountStages: [2500],
    });
    expect(r.amount).toBe(0n);
    expect(r.subtotal).toBe(5000n);
    expect(r.discountAmount).toBe(5000n);
  });
  test('rejects bad quantity', () => {
    for (const q of [0, -1, 1.5, NaN]) {
      expect(() =>
        calculateInvoice({
          lines: [{ quantity: q, unitPrice: 1n, discountStages: [] }],
          discountStages: [],
        }),
      ).toThrowError(code('INVALID_QUANTITY'));
    }
  });
  test('rejects negative unit price', () => {
    expect(() =>
      calculateInvoice({
        lines: [{ quantity: 1, unitPrice: -1n, discountStages: [] }],
        discountStages: [],
      }),
    ).toThrowError(code('NEGATIVE_MONEY'));
  });
  test('line multiplication overflow', () => {
    expect(() =>
      calculateInvoice({
        lines: [{ quantity: 2, unitPrice: 2n ** 62n, discountStages: [] }],
        discountStages: [],
      }),
    ).toThrowError(code('MONEY_OVERFLOW'));
  });
  test('subtotal sum overflow', () => {
    const half = 2n ** 62n;
    expect(() =>
      calculateInvoice({
        lines: [
          { quantity: 1, unitPrice: half, discountStages: [] },
          { quantity: 1, unitPrice: half, discountStages: [] },
        ],
        discountStages: [],
      }),
    ).toThrowError(code('MONEY_OVERFLOW'));
  });
  test('rejects too many stages at either level', () => {
    expect(() =>
      calculateInvoice({
        lines: [
          { quantity: 1, unitPrice: 1n, discountStages: [1, 1, 1, 1, 1] },
        ],
        discountStages: [],
      }),
    ).toThrowError(code('TOO_MANY_DISCOUNT_STAGES'));
    expect(() =>
      calculateInvoice({ lines: [], discountStages: [1, 1, 1, 1, 1] }),
    ).toThrowError(code('TOO_MANY_DISCOUNT_STAGES'));
  });
});

describe('inclusive VAT', () => {
  const line = (
    price: bigint,
    quantity = 1,
    discountStages: number[] = [],
  ) => ({ quantity, unitPrice: price, discountStages });

  test.each([
    {
      lines: [line(50000n)],
      discounts: [],
      net: [45454n],
      vat: [4546n],
      final: [50000n],
    },
    {
      lines: [line(25000n), line(25000n)],
      discounts: [],
      net: [22727n, 22727n],
      vat: [2273n, 2273n],
      final: [25000n, 25000n],
    },
    {
      lines: [line(100000n, 1, [1000])],
      discounts: [1000],
      net: [73636n],
      vat: [7364n],
      final: [81000n],
    },
    {
      lines: [line(25000n, 2)],
      discounts: [],
      net: [45454n],
      vat: [4546n],
      final: [50000n],
    },
  ])(
    'extracts VAT per transaction line: $final',
    ({ lines, discounts, net, vat, final }) => {
      const r = calculateInvoice({
        lines,
        discountStages: discounts,
        vatRateBps: 1000,
      });
      expect(r.lines.map((l) => l.taxSubtotal)).toEqual(net);
      expect(r.lines.map((l) => l.vatAmount)).toEqual(vat);
      expect(r.lines.map((l) => l.finalAmount)).toEqual(final);
      expect(r.taxSubtotal).toBe(net.reduce((a, b) => a + b, 0n));
      expect(r.vatAmount).toBe(vat.reduce((a, b) => a + b, 0n));
      expect(r.taxSubtotal + r.vatAmount).toBe(r.amount);
    },
  );

  test('allocates largest remainders with stable ties', () => {
    const r = calculateInvoice({
      lines: [line(1n), line(1n), line(1n)],
      discountStages: [5000],
    });
    expect(r.lines.map((l) => l.allocatedInvoiceDiscount)).toEqual([
      1n,
      0n,
      0n,
    ]);
    expect(r.lines.map((l) => l.finalAmount)).toEqual([0n, 1n, 1n]);
    const uneven = calculateInvoice({
      lines: [line(1n), line(2n), line(4n)],
      discountStages: [5000],
    });
    expect(uneven.lines.map((l) => l.allocatedInvoiceDiscount)).toEqual([
      0n,
      1n,
      2n,
    ]);
  });

  test.each([
    { lines: [] },
    { lines: [line(0n)] },
    { lines: [line(12n, 3, [10000])] },
  ])('handles zero bases', ({ lines }) => {
    const r = calculateInvoice({
      lines,
      discountStages: [5000],
      vatRateBps: 1000,
    });
    expect(r.taxSubtotal).toBe(0n);
    expect(r.vatAmount).toBe(0n);
    for (const l of r.lines)
      expect(l).toMatchObject({
        allocatedInvoiceDiscount: 0n,
        finalAmount: 0n,
        taxSubtotal: 0n,
        vatAmount: 0n,
      });
  });

  test('full invoice discount leaves no tax', () => {
    const r = calculateInvoice({
      lines: [line(999n)],
      discountStages: [10000],
      vatRateBps: 10000,
    });
    expect(r.lines[0]).toMatchObject({
      allocatedInvoiceDiscount: 999n,
      finalAmount: 0n,
      taxSubtotal: 0n,
      vatAmount: 0n,
    });
  });

  test('fractional rate and int64 intermediate arithmetic', () => {
    const r = calculateInvoice({
      lines: [line(10275n)],
      discountStages: [],
      vatRateBps: 275,
    });
    expect(r).toMatchObject({
      vatRateBps: 275,
      taxSubtotal: 10000n,
      vatAmount: 275n,
    });
    const max = calculateInvoice({
      lines: [line(9223372036854775807n)],
      discountStages: [5000],
      vatRateBps: 10000,
    });
    expect(max.lines[0]).toMatchObject({
      allocatedInvoiceDiscount: 4611686018427387903n,
      finalAmount: 4611686018427387904n,
      taxSubtotal: 2305843009213693952n,
      vatAmount: 2305843009213693952n,
    });
  });

  test.each([-1, 10001, 1.5, NaN, Infinity])(
    'rejects invalid VAT rate %s even on empty invoices',
    (vatRateBps) => {
      expect(() =>
        calculateInvoice({ lines: [], discountStages: [], vatRateBps }),
      ).toThrowError(code('INVALID_PERCENTAGE'));
    },
  );

  test('VAT preserves old prices, discounts and payable amount', () => {
    const input = {
      lines: [line(100000n, 2, [275]), line(123n)],
      discountStages: [1000],
    };
    const zero = calculateInvoice(input);
    const taxed = calculateInvoice({ ...input, vatRateBps: 1100 });
    expect(zero.vatRateBps).toBe(0);
    expect(zero.taxSubtotal).toBe(zero.amount);
    expect(zero.vatAmount).toBe(0n);
    for (const key of [
      'subtotal',
      'itemDiscountTotal',
      'invoiceDiscountStageAmounts',
      'invoiceDiscountTotal',
      'discountAmount',
      'amount',
    ] as const)
      expect(taxed[key]).toEqual(zero[key]);
    taxed.lines.forEach((l, i) => {
      for (const key of [
        'subtotal',
        'stageAmounts',
        'discountTotal',
        'amount',
        'allocatedInvoiceDiscount',
        'finalAmount',
      ] as const)
        expect(l[key]).toEqual(zero.lines[i]![key]);
    });
  });
});

describe('derivePaymentStatus', () => {
  test('states', () => {
    expect(derivePaymentStatus(1000n, 0n)).toBe('UNPAID');
    expect(derivePaymentStatus(1000n, 1n)).toBe('PARTIALLY_PAID');
    expect(derivePaymentStatus(1000n, 999n)).toBe('PARTIALLY_PAID');
    expect(derivePaymentStatus(1000n, 1000n)).toBe('PAID');
  });
  test('zero total is PAID', () => {
    expect(derivePaymentStatus(0n, 0n)).toBe('PAID');
  });
  test('overpayment throws', () => {
    expect(() => derivePaymentStatus(1000n, 1001n)).toThrowError(
      code('PAYMENT_EXCEEDS_AMOUNT'),
    );
    expect(() => derivePaymentStatus(0n, 1n)).toThrowError(
      code('PAYMENT_EXCEEDS_AMOUNT'),
    );
  });
  test('negatives throw', () => {
    expect(() => derivePaymentStatus(-1n, 0n)).toThrowError(
      code('NEGATIVE_MONEY'),
    );
    expect(() => derivePaymentStatus(1000n, -1n)).toThrowError(
      code('NEGATIVE_MONEY'),
    );
  });
});

describe('calculateDueDate', () => {
  test('TOP 0 is invoice date', () => {
    expect(calculateDueDate('2026-09-30', 0)).toBe('2026-09-30');
  });
  test('month and year rollover', () => {
    expect(calculateDueDate('2026-09-30', 30)).toBe('2026-10-30');
    expect(calculateDueDate('2026-12-31', 1)).toBe('2027-01-01');
  });
  test('leap days', () => {
    expect(calculateDueDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(calculateDueDate('2028-02-28', 2)).toBe('2028-03-01');
    expect(calculateDueDate('2027-02-28', 1)).toBe('2027-03-01');
    expect(calculateDueDate('2028-02-29', 365)).toBe('2029-02-28');
    expect(calculateDueDate('2028-02-29', 366)).toBe('2029-03-01');
  });
  test('rejects invalid topDays', () => {
    for (const d of [-1, 1.5, NaN, Infinity]) {
      expect(() => calculateDueDate('2026-09-30', d)).toThrowError(
        code('INVALID_TOP_DAYS'),
      );
    }
  });
  test('rejects invalid date', () => {
    expect(() => calculateDueDate('2026-02-30', 1)).toThrowError(
      code('INVALID_DATE'),
    );
    expect(() => calculateDueDate('2026-9-3', 1)).toThrowError(
      code('INVALID_DATE'),
    );
  });
});
