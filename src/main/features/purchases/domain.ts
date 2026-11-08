import { assertInt64, DomainError } from '@/shared/primitives';

function nonnegative(value: bigint): bigint {
  if (assertInt64(value) < 0n) throw new DomainError('INVALID_MONEY');
  return value;
}

export function purchaseBalance(
  amount: bigint,
  credits: bigint,
  paid: bigint,
  refunded: bigint,
) {
  [amount, credits, paid, refunded].forEach(nonnegative);
  if (credits > amount || refunded > paid)
    throw new DomainError('INVALID_PURCHASE_BALANCE');
  const balance = assertInt64(amount - credits - paid + refunded);
  return {
    outstanding: balance > 0n ? balance : 0n,
    refundDue: balance < 0n ? -balance : 0n,
  };
}

export interface CreditOriginal {
  quantity: number;
  amount: bigint;
  taxSubtotal: bigint;
}
export function creditPortion(
  original: CreditOriginal,
  alreadyCreditedQuantity: number,
  quantity: number,
) {
  const { quantity: total, amount, taxSubtotal } = original;
  nonnegative(amount);
  nonnegative(taxSubtotal);
  if (
    !Number.isSafeInteger(total) ||
    total < 1 ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    !Number.isSafeInteger(alreadyCreditedQuantity) ||
    alreadyCreditedQuantity < 0 ||
    alreadyCreditedQuantity + quantity > total ||
    taxSubtotal > amount
  )
    throw new DomainError('INVALID_CREDIT_QUANTITY');
  const cumulative = (units: number) => {
    const credited = (amount * BigInt(units)) / BigInt(total);
    return {
      amount: credited,
      tax: amount === 0n ? 0n : (taxSubtotal * credited) / amount,
    };
  };
  const before = cumulative(alreadyCreditedQuantity);
  const after = cumulative(alreadyCreditedQuantity + quantity);
  const value = after.amount - before.amount;
  const tax = after.tax - before.tax;
  return { amount: value, taxSubtotal: tax, vatAmount: value - tax };
}
