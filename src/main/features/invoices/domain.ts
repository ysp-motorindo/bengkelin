import { Temporal } from 'temporal-polyfill';
import {
  DomainError,
  assertInt64,
  type LocalDate,
  type PercentageBps,
} from '@/shared/primitives';

export const MAX_DISCOUNT_STAGES = 4;

export type PaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

export type DiscountResult = {
  /** Base after all stages. */
  amount: bigint;
  discountTotal: bigint;
  /** Calculated discount for each stage, in order (persisted). */
  stageAmounts: bigint[];
};

function assertNonNegative(value: bigint): bigint {
  assertInt64(value);
  if (value < 0n)
    throw new DomainError('NEGATIVE_MONEY', 'Amount must not be negative');
  return value;
}

export function applyDiscounts(
  base: bigint,
  stages: PercentageBps[],
): DiscountResult {
  assertNonNegative(base);
  if (stages.length > MAX_DISCOUNT_STAGES) {
    throw new DomainError(
      'TOO_MANY_DISCOUNT_STAGES',
      `At most ${MAX_DISCOUNT_STAGES} stages`,
    );
  }
  let remaining = base;
  const stageAmounts: bigint[] = [];
  for (const bps of stages) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
      throw new DomainError(
        'INVALID_PERCENTAGE',
        'Percentage must be an integer 0-10000 bps',
      );
    }
    const discount = (remaining * BigInt(bps)) / 10000n;
    stageAmounts.push(discount);
    remaining -= discount;
  }
  return { amount: remaining, discountTotal: base - remaining, stageAmounts };
}

export type InvoiceLineInput = {
  quantity: number;
  unitPrice: bigint;
  discountStages: PercentageBps[];
};

export type InvoiceCalculationInput = {
  vatRateBps?: number;
  lines: InvoiceLineInput[];
  discountStages: PercentageBps[];
};

export type InvoiceLineCalculation = {
  allocatedInvoiceDiscount: bigint;
  finalAmount: bigint;
  taxSubtotal: bigint;
  vatAmount: bigint;
  /** quantity x unitPrice, before line discounts. */
  subtotal: bigint;
  stageAmounts: bigint[];
  discountTotal: bigint;
  /** After line discounts. */
  amount: bigint;
};

export type InvoiceCalculation = {
  vatRateBps: number;
  taxSubtotal: bigint;
  vatAmount: bigint;
  lines: InvoiceLineCalculation[];
  /** Sum of line subtotals, before all discounts. */
  subtotal: bigint;
  itemDiscountTotal: bigint;
  invoiceDiscountStageAmounts: bigint[];
  invoiceDiscountTotal: bigint;
  /** Item plus invoice discounts. */
  discountAmount: bigint;
  /** Final amount payable. */
  amount: bigint;
};

export function calculateInvoice(
  input: InvoiceCalculationInput,
): InvoiceCalculation {
  const vatRateBps = input.vatRateBps ?? 0;
  if (!Number.isInteger(vatRateBps) || vatRateBps < 0 || vatRateBps > 10000) {
    throw new DomainError(
      'INVALID_PERCENTAGE',
      'Percentage must be an integer 0-10000 bps',
    );
  }
  let subtotal = 0n;
  let itemDiscountTotal = 0n;
  let discountedSum = 0n;
  const lines = input.lines.map((line): InvoiceLineCalculation => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new DomainError(
        'INVALID_QUANTITY',
        'Quantity must be an integer of at least 1',
      );
    }
    const lineSubtotal = assertInt64(
      assertNonNegative(line.unitPrice) * BigInt(line.quantity),
    );
    const d = applyDiscounts(lineSubtotal, line.discountStages);
    subtotal = assertInt64(subtotal + lineSubtotal);
    itemDiscountTotal += d.discountTotal;
    discountedSum = assertInt64(discountedSum + d.amount);
    return {
      allocatedInvoiceDiscount: 0n,
      finalAmount: 0n,
      taxSubtotal: 0n,
      vatAmount: 0n,
      subtotal: lineSubtotal,
      stageAmounts: d.stageAmounts,
      discountTotal: d.discountTotal,
      amount: d.amount,
    };
  });
  const inv = applyDiscounts(discountedSum, input.discountStages);
  const breakdown = calculateInclusiveVat(
    lines.map((line) => line.amount),
    inv.discountTotal,
    vatRateBps,
  );
  lines.forEach((line, index) => Object.assign(line, breakdown.lines[index]));
  return {
    vatRateBps,
    taxSubtotal: breakdown.taxSubtotal,
    vatAmount: breakdown.vatAmount,
    lines,
    subtotal,
    itemDiscountTotal,
    invoiceDiscountStageAmounts: inv.stageAmounts,
    invoiceDiscountTotal: inv.discountTotal,
    discountAmount: itemDiscountTotal + inv.discountTotal,
    amount: inv.amount,
  };
}

/** Shared by legacy readers, which must use saved amounts rather than reprice. */
export function calculateInclusiveVat(
  amounts: bigint[],
  discount: bigint,
  vatRateBps: number,
) {
  const sum = amounts.reduce((total, amount) => total + amount, 0n);
  const lines = amounts.map((amount) => ({
    allocatedInvoiceDiscount: sum === 0n ? 0n : (discount * amount) / sum,
    finalAmount: 0n,
    taxSubtotal: 0n,
    vatAmount: 0n,
  }));
  if (sum !== 0n) {
    let remainder =
      discount -
      lines.reduce((total, line) => total + line.allocatedInvoiceDiscount, 0n);
    const order = amounts
      .map((amount, index) => ({ index, remainder: (discount * amount) % sum }))
      .sort((a, b) =>
        a.remainder === b.remainder
          ? a.index - b.index
          : a.remainder > b.remainder
            ? -1
            : 1,
      );
    for (const { index } of order) {
      if (remainder === 0n) break;
      lines[index]!.allocatedInvoiceDiscount += 1n;
      remainder -= 1n;
    }
  }
  for (const [index, line] of lines.entries()) {
    line.finalAmount = amounts[index]! - line.allocatedInvoiceDiscount;
    line.taxSubtotal =
      (line.finalAmount * 10000n) / (10000n + BigInt(vatRateBps));
    line.vatAmount = line.finalAmount - line.taxSubtotal;
  }
  return {
    lines,
    taxSubtotal: lines.reduce((total, line) => total + line.taxSubtotal, 0n),
    vatAmount: lines.reduce((total, line) => total + line.vatAmount, 0n),
  };
}

export function derivePaymentStatus(
  amount: bigint,
  paid: bigint,
): PaymentStatus {
  assertNonNegative(amount);
  assertNonNegative(paid);
  if (paid > amount)
    throw new DomainError(
      'PAYMENT_EXCEEDS_AMOUNT',
      'Paid exceeds invoice amount',
    );
  if (paid === amount) return 'PAID';
  return paid === 0n ? 'UNPAID' : 'PARTIALLY_PAID';
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function calculateDueDate(
  invoiceDate: LocalDate,
  topDays: number,
): LocalDate {
  if (!Number.isInteger(topDays) || topDays < 0) {
    throw new DomainError(
      'INVALID_TOP_DAYS',
      'TOP days must be an integer of at least 0',
    );
  }
  if (!LOCAL_DATE.test(invoiceDate))
    throw new DomainError('INVALID_DATE', 'Invalid LocalDate');
  try {
    return Temporal.PlainDate.from(invoiceDate, { overflow: 'reject' })
      .add({ days: topDays })
      .toString();
  } catch {
    throw new DomainError('INVALID_DATE', 'Invalid LocalDate');
  }
}
