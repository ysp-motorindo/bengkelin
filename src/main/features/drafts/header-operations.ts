import { toNumber } from '@/main/database/rows';
import { calculateDueDate } from '@/main/features/invoices/domain';
import { DomainError, assertInt64, parseRupiah } from '@/shared/primitives';
import {
  requireActiveChannel,
  type DraftOp as Op,
  type OperationContext,
} from './context';
import type { DraftHeader } from './repository';

/**
 * Header edits. Only the sent fields change. Changing the channel or
 * pricingAt deliberately leaves every line price as it is (Part A: retain
 * prices; refresh is a separate reviewed step). Selecting a customer or a
 * vehicle never changes vehicle ownership.
 */
export function updateHeader(
  ctx: OperationContext,
  op: Op<'updateHeader'>,
): void {
  const { invoice, repo } = ctx;
  const c = op.changes;
  const invoiceDate = c.invoiceDate ?? invoice.invoice_date;
  const topDays = c.topDays ?? toNumber(invoice.top_days);
  const header: DraftHeader = {
    channelId: c.channelId ?? invoice.channel_id,
    invoiceDate,
    pricingAt: c.pricingAt ?? invoice.pricing_at,
    customerId: c.customerId !== undefined ? c.customerId : invoice.customer_id,
    vehicleId: c.vehicleId !== undefined ? c.vehicleId : invoice.vehicle_id,
    odometerKm:
      c.odometerKm !== undefined
        ? c.odometerKm
        : invoice.odometer_km === null
          ? null
          : toNumber(invoice.odometer_km),
    topDays,
    dueDate: calculateDueDate(invoiceDate, topDays),
    note: c.note !== undefined ? c.note : invoice.note,
  };
  if (header.channelId !== invoice.channel_id) {
    requireActiveChannel(repo, header.channelId);
  }
  if (
    header.customerId !== null &&
    header.customerId !== invoice.customer_id &&
    !ctx.customers.find(header.customerId)
  ) {
    throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer not found');
  }
  if (
    header.vehicleId !== null &&
    header.vehicleId !== invoice.vehicle_id &&
    !ctx.vehicles.find(header.vehicleId)
  ) {
    throw new DomainError('VEHICLE_NOT_FOUND', 'Vehicle not found');
  }
  repo.saveHeader(invoice.id, header);
}

export function setInvoiceDiscounts(
  ctx: OperationContext,
  op: Op<'setInvoiceDiscounts'>,
): void {
  ctx.repo.replaceInvoiceStages(ctx.invoice.id, op.stages, ctx.newId);
}

/**
 * Planned payment split (not payments). The sum may leave part of the amount
 * as credit but may not exceed the draft's current amount.
 */
export function setCheckoutAllocations(
  ctx: OperationContext,
  op: Op<'setCheckoutAllocations'>,
): void {
  const allocations = op.allocations.map((a) => ({
    method: a.method,
    amount: parseRupiah(a.amount),
    reference: a.reference ?? null,
    note: a.note ?? null,
  }));
  const total = allocations.reduce((sum, a) => assertInt64(sum + a.amount), 0n);
  if (total > ctx.invoice.amount) {
    throw new DomainError(
      'ALLOCATION_EXCEEDS_AMOUNT',
      'Planned payments exceed the invoice amount',
    );
  }
  ctx.repo.replaceAllocations(ctx.invoice.id, allocations, ctx.newId);
}
