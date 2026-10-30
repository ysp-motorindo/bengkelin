import { bool, toNumber } from '@/main/database/rows';
import type { CustomerRepository } from '@/main/features/customers/repository';
import type { VehicleRepository } from '@/main/features/vehicles/repository';
import type {
  CheckoutAllocationDto,
  DiscountStageDto,
  DraftLineDto,
  DraftSummary,
  DraftView,
  LinePricingDto,
  PriceChangeDto,
  ResolvedPrice,
} from '@/shared/contracts';
import { detectOwnerMismatch } from '@/shared/ownership';
import { formatRupiah, type Instant } from '@/shared/primitives';
import type {
  DraftRepository,
  DraftSummaryRow,
  InvoiceRow,
  LineRow,
  PriceChangeRow,
  StageRow,
} from './repository';

export type ResolvePrice = (
  itemId: string,
  channelId: string,
  pricingAt: Instant,
) => ResolvedPrice | null;

export interface ViewDeps {
  repo: DraftRepository;
  customers: CustomerRepository;
  vehicles: VehicleRepository;
  resolvePrice: ResolvePrice;
}

const money = formatRupiah;

function toStageDto(row: StageRow): DiscountStageDto {
  return {
    sequence: toNumber(row.sequence),
    percentageBps: toNumber(row.percentage_bps),
    amount: money(row.amount),
  };
}

function toPriceChangeDto(row: PriceChangeRow): PriceChangeDto {
  return {
    id: row.id,
    sequence: toNumber(row.sequence),
    kind: row.kind,
    previousPrice:
      row.previous_price === null ? null : money(row.previous_price),
    newPrice: money(row.new_price),
    changedBy: {
      id: row.changed_by_cashier_id,
      displayName: row.changed_by_name,
    },
    changedAt: row.changed_at,
    reason: row.reason,
  };
}

function group<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(key(row)) ?? [];
    list.push(row);
    map.set(key(row), list);
  }
  return map;
}

/**
 * Provenance plus an informational comparison with what the draft's current
 * channel and pricingAt resolve to now. Nothing here changes a price.
 */
function linePricing(
  line: LineRow,
  invoice: InvoiceRow,
  resolvePrice: ResolvePrice,
): LinePricingDto {
  const current =
    line.catalog_item_id === null
      ? null
      : resolvePrice(
          line.catalog_item_id,
          invoice.channel_id,
          invoice.pricing_at,
        );
  const listed =
    line.listed_unit_price === null ? null : money(line.listed_unit_price);
  return {
    resolvedPriceId: line.resolved_price_id,
    priceResolvedAt: line.price_resolved_at,
    manualPriceOverride: bool(line.manual_price_override),
    currentResolvedPriceId: current?.priceId ?? null,
    currentListedPrice: current?.price ?? null,
    listedPriceDiffersFromCurrent:
      line.catalog_item_id !== null &&
      ((current?.priceId ?? null) !== line.resolved_price_id ||
        (current?.price ?? null) !== listed),
  };
}

function toLineDto(
  line: LineRow,
  invoice: InvoiceRow,
  stages: StageRow[],
  changes: PriceChangeRow[],
  resolvePrice: ResolvePrice,
): DraftLineDto {
  return {
    id: line.id,
    position: toNumber(line.position),
    source: line.catalog_item_id === null ? 'CUSTOM' : 'CATALOG',
    catalogItemId: line.catalog_item_id,
    adHocItemReferenceId: line.ad_hoc_item_reference_id,
    itemType: line.item_type_snapshot,
    title: line.title_snapshot,
    unitId: line.unit_id,
    unitLabel: line.unit_snapshot,
    mechanicId: line.mechanic_id,
    mechanicName: line.mechanic_name_snapshot,
    quantity: toNumber(line.quantity),
    listedUnitPrice:
      line.listed_unit_price === null ? null : money(line.listed_unit_price),
    unitPrice: money(line.unit_price),
    subtotal: money(line.subtotal),
    discountAmount: money(line.discount_amount),
    amount: money(line.amount),
    discounts: stages.map(toStageDto),
    pricing: linePricing(line, invoice, resolvePrice),
    priceChanges: changes.map(toPriceChangeDto),
    createdAt: line.created_at,
    updatedAt: line.updated_at,
  };
}

/** The complete DraftView of an invoice row (any status; callers check it). */
export function buildDraftView(deps: ViewDeps, invoice: InvoiceRow): DraftView {
  const { repo } = deps;
  const lineStages = group(repo.lineStages(invoice.id), (s) => s.owner_id);
  const changes = group(
    repo.priceChanges(invoice.id),
    (c) => c.invoice_item_id,
  );
  const allocationRows = repo.allocations(invoice.id);
  const allocations: CheckoutAllocationDto[] = allocationRows.map((a) => ({
    sequence: toNumber(a.sequence),
    method: a.method,
    amount: money(a.amount),
    reference: a.reference,
    note: a.note,
  }));
  const allocated = allocationRows.reduce((sum, a) => sum + a.amount, 0n);

  const customer =
    invoice.customer_id === null
      ? undefined
      : deps.customers.find(invoice.customer_id);
  const vehicle =
    invoice.vehicle_id === null
      ? undefined
      : deps.vehicles.find(invoice.vehicle_id);
  const description = vehicle
    ? [vehicle.brandName, vehicle.modelName].filter(Boolean).join(' ') || null
    : null;

  return {
    id: invoice.id,
    status: invoice.status,
    version: toNumber(invoice.version),
    invoiceNumber: invoice.reserved_invoice_number,
    taxInvoiceNumber: invoice.tax_invoice_number,
    channelId: invoice.channel_id,
    channelLabel: repo.channel(invoice.channel_id)?.label ?? '',
    sales:
      invoice.sales_id === null
        ? null
        : {
            id: invoice.sales_id,
            name: repo.reference('sales', invoice.sales_id)?.label ?? '',
          },
    expedition:
      invoice.expedition_id === null
        ? null
        : {
            id: invoice.expedition_id,
            name:
              repo.reference('expedition', invoice.expedition_id)?.label ?? '',
          },
    invoiceDate: invoice.invoice_date,
    pricingAt: invoice.pricing_at,
    topDays: toNumber(invoice.top_days),
    dueDate: invoice.due_date,
    customer: customer
      ? {
          id: customer.id,
          name: customer.name,
          phoneNumber: customer.phoneNumber,
        }
      : null,
    vehicle: vehicle
      ? {
          id: vehicle.id,
          plateNumber: vehicle.plateNumber,
          description,
          activeOwnerId: vehicle.activeOwnerId,
        }
      : null,
    ownerMismatch: detectOwnerMismatch(
      vehicle?.activeOwnerId ?? null,
      invoice.customer_id,
    ),
    odometerKm:
      invoice.odometer_km === null ? null : toNumber(invoice.odometer_km),
    note: invoice.note,
    lines: repo
      .liveLines(invoice.id)
      .map((line) =>
        toLineDto(
          line,
          invoice,
          lineStages.get(line.id) ?? [],
          changes.get(line.id) ?? [],
          deps.resolvePrice,
        ),
      ),
    invoiceDiscounts: repo.invoiceStages(invoice.id).map(toStageDto),
    checkoutAllocations: allocations,
    totals: {
      subtotal: money(invoice.subtotal),
      itemDiscountAmount: money(invoice.item_discount_amount),
      invoiceDiscountAmount: money(invoice.invoice_discount_amount),
      discountAmount: money(invoice.discount_amount),
      amount: money(invoice.amount),
      allocatedAmount: money(allocated),
      unallocatedAmount: money(invoice.amount - allocated),
    },
    allocationsExceedAmount: allocated > invoice.amount,
    createdBy: {
      id: invoice.created_by_cashier_id,
      displayName: repo.cashierName(invoice.created_by_cashier_id),
    },
    lastEditedBy: {
      id: invoice.last_edited_by_cashier_id,
      displayName: repo.cashierName(invoice.last_edited_by_cashier_id),
    },
    createdAt: invoice.created_at,
    updatedAt: invoice.updated_at,
    discardedAt: invoice.discarded_at,
  };
}

export function toDraftSummary(row: DraftSummaryRow): DraftSummary {
  return {
    invoiceNumber: row.reserved_invoice_number,
    id: row.id,
    version: toNumber(row.version),
    channelId: row.channel_id,
    channelLabel: row.channel_label,
    invoiceDate: row.invoice_date,
    customerLabel: row.customer_name || row.customer_phone || null,
    plateNumber: row.plate_number,
    amount: money(row.amount),
    lineCount: toNumber(row.line_count),
    createdBy: {
      id: row.created_by_cashier_id,
      displayName: row.created_by_name,
    },
    lastEditedBy: {
      id: row.last_edited_by_cashier_id,
      displayName: row.last_edited_by_name,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
