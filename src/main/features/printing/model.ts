import type {
  DiscountStageDto,
  InvoicePrintModel,
  InvoiceView,
  Language,
  PrintDiscountStage,
} from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';

/**
 * The print model: one per invoice, shared by every presentation. Built
 * only from the InvoiceView (frozen snapshots, stored totals and the current
 * payment history). Pure: no database, clock, filesystem or Electron.
 * Money stays exactly the Rupiah strings the invoice stored.
 */

export interface PrintModelContext {
  language: Language;
  /** The shop timezone, for the finalized/payment/void wall-clock times. */
  timezone: string;
  /** A PRINTED print job already exists for this invoice. */
  isReprint: boolean;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD HH:mm` wall-clock time of an instant in `timezone`. */
export function localDateTime(instant: Instant, timezone: string): string {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  return formatter.format(new Date(instant));
}

function stage(dto: DiscountStageDto): PrintDiscountStage {
  return {
    sequence: dto.sequence,
    percentageBps: dto.percentageBps,
    amount: dto.amount,
  };
}

export function toInvoicePrintModel(
  view: InvoiceView,
  context: PrintModelContext,
): InvoicePrintModel {
  const { timezone } = context;
  return {
    language: context.language,
    timezone,
    invoiceId: view.id,
    invoiceNumber: view.invoiceNumber,
    status: view.status,
    isReprint: context.isReprint,
    void: view.void
      ? {
          reason: view.void.reason,
          voidedAtLocal: localDateTime(view.void.voidedAt, timezone),
          voidedBy: view.void.voidedBy.displayName,
        }
      : null,
    shop: {
      name: view.shop.name,
      address: view.shop.address,
      phoneNumber: view.shop.phoneNumber,
      email: view.shop.email,
      invoiceFooter: view.shop.invoiceFooter,
      logo: view.shop.logo ?? null,
    },
    invoiceDate: view.invoiceDate,
    finalizedAt: view.finalizedAt,
    finalizedAtLocal: localDateTime(view.finalizedAt, timezone),
    topDays: view.topDays,
    dueDate: view.dueDate,
    channel: view.channel.label,
    cashier: view.cashier.displayName,
    customer: view.customer
      ? { name: view.customer.name, phoneNumber: view.customer.phoneNumber }
      : null,
    vehicle: view.vehicle
      ? {
          plateNumber: view.vehicle.plateNumber,
          description: view.vehicle.description,
        }
      : null,
    odometerKm: view.odometerKm,
    note: view.note,
    lines: view.lines.map((line, index) => ({
      position: index + 1,
      itemType: line.itemType,
      title: line.title,
      quantity: line.quantity,
      unitLabel: line.unitLabel,
      unitPrice: line.unitPrice,
      subtotal: line.subtotal,
      discounts: line.discounts.map(stage),
      discountAmount: line.discountAmount,
      amount: line.amount,
      mechanicName: line.mechanicName,
    })),
    invoiceDiscounts: view.invoiceDiscounts.map(stage),
    subtotal: view.totals.subtotal,
    itemDiscountAmount: view.totals.itemDiscountAmount,
    invoiceDiscountAmount: view.totals.invoiceDiscountAmount,
    discountAmount: view.totals.discountAmount,
    amount: view.totals.amount,
    payments: view.payments.map((payment) => ({
      method: payment.method,
      amount: payment.amount,
      paidAt: payment.paidAt,
      paidAtLocal: localDateTime(payment.paidAt, timezone),
      reference: payment.reference,
      receivedBy: payment.receivedBy.displayName,
    })),
    paidAmount: view.paidAmount,
    outstanding: view.outstandingAmount,
    paymentStatus: view.paymentStatus,
  };
}
