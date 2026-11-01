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
    stockLocationId: c.stockLocationId ?? invoice.stock_location_id,
    salesId: c.salesId !== undefined ? c.salesId : invoice.sales_id,
    expeditionId:
      c.expeditionId !== undefined ? c.expeditionId : invoice.expedition_id,
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
  if (c.stockLocationId !== undefined)
    repo.requireActiveStockLocation(header.stockLocationId);
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
  if (header.vehicleId !== null && header.vehicleId !== invoice.vehicle_id) {
    // A newly selected vehicle must exist and be active; one already on
    // the draft stays even if it was deactivated meanwhile.
    const vehicle = ctx.vehicles.find(header.vehicleId);
    if (!vehicle) {
      throw new DomainError('VEHICLE_NOT_FOUND', 'Vehicle not found');
    }
    if (!vehicle.isActive) {
      throw new DomainError('VEHICLE_INACTIVE', 'Vehicle is inactive');
    }
  }
  for (const entity of ['sales', 'expedition'] as const) {
    const selected = header[`${entity}Id`];
    if (selected !== null && selected !== invoice[`${entity}_id`]) {
      const reference = repo.reference(entity, selected);
      if (!reference)
        throw new DomainError('REFERENCE_NOT_FOUND', 'Reference not found');
      if (!reference.isActive)
        throw new DomainError('REFERENCE_INACTIVE', 'Reference is inactive');
    }
  }
  repo.saveHeader(invoice.id, header);
  if (c.taxInvoiceNumber !== undefined)
    repo.saveTaxNumber(invoice.id, c.taxInvoiceNumber);
}

export function setInvoiceDiscounts(
  ctx: OperationContext,
  op: Op<'setInvoiceDiscounts'>,
): void {
  ctx.repo.replaceInvoiceStages(ctx.invoice.id, op.stages, ctx.newId);
}

/**
 * Received payment rows (not payments); finalization validates non-cash excess.
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
  allocations.reduce((sum, a) => assertInt64(sum + a.amount), 0n);
  ctx.repo.replaceAllocations(ctx.invoice.id, allocations, ctx.newId);
  ctx.repo.saveCashReceived(ctx.invoice.id, null);
}
