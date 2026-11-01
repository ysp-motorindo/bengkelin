import type {
  CheckoutAllocationDto,
  CheckoutPaymentSummary,
} from './contracts';
import {
  assertInt64,
  formatRupiah,
  parseRupiah,
  type Rupiah,
} from './primitives';

export function calculateCheckoutPayments(
  amount: Rupiah,
  tenders: readonly CheckoutAllocationDto[],
): { allocations: CheckoutAllocationDto[]; summary: CheckoutPaymentSummary } {
  const total = parseRupiah(amount);
  let received = 0n;
  let cash = 0n;
  let nonCash = 0n;
  for (const tender of tenders) {
    const value = parseRupiah(tender.amount);
    received = assertInt64(received + value);
    if (tender.method === 'CASH') cash = assertInt64(cash + value);
    else nonCash = assertInt64(nonCash + value);
  }
  let remaining = total > nonCash ? total - nonCash : 0n;
  const allocations = tenders.flatMap((tender) => {
    if (tender.method !== 'CASH') return [{ ...tender }];
    const value = parseRupiah(tender.amount);
    const applied = value < remaining ? value : remaining;
    remaining -= applied;
    return applied > 0n ? [{ ...tender, amount: formatRupiah(applied) }] : [];
  });
  const appliedCash =
    total > nonCash ? (cash < total - nonCash ? cash : total - nonCash) : 0n;
  return {
    allocations,
    summary: {
      receivedAmount: formatRupiah(received),
      cashReceived: formatRupiah(cash),
      changeAmount: nonCash > total ? null : formatRupiah(cash - appliedCash),
      nonCashExcess: formatRupiah(nonCash > total ? nonCash - total : 0n),
    },
  };
}
