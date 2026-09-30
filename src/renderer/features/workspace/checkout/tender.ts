import type { CheckoutAllocationDto } from '@/shared/contracts';
import type { Rupiah } from '@/shared/primitives';

/**
 * Cash tender/change (UI state only, never stored): change is the tendered
 * cash minus the planned CASH allocations, or minus the whole amount when no
 * cash is planned. Negative means the tendered cash is short.
 */
export function cashChange(
  tendered: Rupiah,
  amount: Rupiah,
  allocations: readonly CheckoutAllocationDto[],
): Rupiah {
  const cash = allocations
    .filter((allocation) => allocation.method === 'CASH')
    .reduce((total, allocation) => total + BigInt(allocation.amount), 0n);
  const due = cash > 0n ? cash : BigInt(amount);
  return (BigInt(tendered) - due).toString();
}
