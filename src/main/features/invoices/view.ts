import { bool, toNumber } from '@/main/database/rows';
import type {
  DraftRepository,
  LineRow,
  StageRow,
} from '@/main/features/drafts/repository';
import type {
  DiscountStageDto,
  InvoiceLineDto,
  InvoiceView,
  PaymentDto,
  ShopIdentitySnapshot,
} from '@/shared/contracts';
import { formatRupiah } from '@/shared/primitives';
import { derivePaymentStatus } from './domain';
import type { PaymentRepository, PaymentRow } from './payments-repository';
import type { FullInvoiceRow, InvoiceRepository } from './repository';

/**
 * InvoiceView of an issued invoice, built only from its own rows and frozen
 * snapshots (never from current master data). Money leaves as Rupiah strings.
 */

export interface InvoiceViewDeps {
  drafts: DraftRepository;
  invoices: InvoiceRepository;
  payments: PaymentRepository;
}

const money = formatRupiah;

function toStageDto(row: StageRow): DiscountStageDto {
  return {
    sequence: toNumber(row.sequence),
    percentageBps: toNumber(row.percentage_bps),
    amount: money(row.amount),
  };
}

function toLineDto(line: LineRow, stages: StageRow[]): InvoiceLineDto {
  return {
    id: line.id,
    position: toNumber(line.position),
    catalogItemId: line.catalog_item_id,
    adHocItemReferenceId: line.ad_hoc_item_reference_id,
    itemType: line.item_type_snapshot,
    title: line.title_snapshot,
    unitLabel: line.unit_snapshot,
    mechanicId: line.mechanic_id,
    mechanicName: line.mechanic_name_snapshot,
    quantity: toNumber(line.quantity),
    listedUnitPrice:
      line.listed_unit_price === null ? null : money(line.listed_unit_price),
    unitPrice: money(line.unit_price),
    manualPriceOverride: bool(line.manual_price_override),
    subtotal: money(line.subtotal),
    discountAmount: money(line.discount_amount),
    amount: money(line.amount),
    discounts: stages.map(toStageDto),
  };
}

export function toPaymentDto(row: PaymentRow): PaymentDto {
  return {
    id: row.id,
    method: row.method,
    amount: money(row.amount),
    paidAt: row.paid_at,
    reference: row.reference,
    note: row.note,
    receivedBy: {
      id: row.received_by_cashier_id,
      displayName: row.received_by_name_snapshot,
    },
    source: row.source,
  };
}

/** Requires a FINALIZED or VOID row (the CHECKs guarantee its snapshots). */
export function buildInvoiceView(
  deps: InvoiceViewDeps,
  invoice: FullInvoiceRow,
): InvoiceView {
  if (invoice.status === 'DRAFT') throw new Error('not an issued invoice');
  const stages = new Map<string, StageRow[]>();
  for (const stage of deps.drafts.lineStages(invoice.id)) {
    const list = stages.get(stage.owner_id) ?? [];
    list.push(stage);
    stages.set(stage.owner_id, list);
  }
  const paymentRows = deps.payments.forInvoice(invoice.id);
  const paid = paymentRows.reduce((sum, p) => sum + p.amount, 0n);

  return {
    id: invoice.id,
    invoiceNumber: invoice.invoice_number!,
    status: invoice.status,
    version: toNumber(invoice.version),
    invoiceDate: invoice.invoice_date,
    pricingAt: invoice.pricing_at,
    topDays: toNumber(invoice.top_days),
    dueDate: invoice.due_date,
    finalizedAt: invoice.finalized_at!,
    channel: {
      id: invoice.channel_id,
      label: invoice.channel_label_snapshot!,
    },
    customer:
      invoice.customer_id === null
        ? null
        : {
            id: invoice.customer_id,
            name: invoice.customer_name_snapshot,
            phoneNumber: invoice.customer_phone_snapshot,
          },
    vehicle:
      invoice.vehicle_id === null
        ? null
        : {
            id: invoice.vehicle_id,
            plateNumber: invoice.plate_number_snapshot,
            description: invoice.vehicle_description_snapshot,
          },
    odometerKm:
      invoice.odometer_km === null ? null : toNumber(invoice.odometer_km),
    note: invoice.note,
    cashier: {
      id: invoice.cashier_id!,
      displayName: invoice.cashier_name_snapshot!,
    },
    createdBy: {
      id: invoice.created_by_cashier_id,
      displayName: invoice.created_by_name,
    },
    shop: JSON.parse(invoice.shop_identity_snapshot!) as ShopIdentitySnapshot,
    lines: deps.drafts
      .liveLines(invoice.id)
      .map((line) => toLineDto(line, stages.get(line.id) ?? [])),
    invoiceDiscounts: deps.drafts.invoiceStages(invoice.id).map(toStageDto),
    totals: {
      subtotal: money(invoice.subtotal),
      itemDiscountAmount: money(invoice.item_discount_amount),
      invoiceDiscountAmount: money(invoice.invoice_discount_amount),
      discountAmount: money(invoice.discount_amount),
      amount: money(invoice.amount),
    },
    payments: paymentRows.map(toPaymentDto),
    paidAmount: money(paid),
    outstandingAmount: money(invoice.amount - paid),
    paymentStatus: derivePaymentStatus(invoice.amount, paid),
    void:
      invoice.voided_at === null
        ? null
        : {
            voidedAt: invoice.voided_at,
            voidedBy: {
              id: invoice.voided_by_cashier_id!,
              displayName: invoice.voided_by_name_snapshot!,
            },
            reason: invoice.void_reason!,
          },
  };
}

export function loadInvoiceView(
  deps: InvoiceViewDeps,
  invoiceId: string,
): InvoiceView | undefined {
  const row = deps.invoices.findFull(invoiceId);
  return row && row.status !== 'DRAFT'
    ? buildInvoiceView(deps, row)
    : undefined;
}
