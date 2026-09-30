import { toNumber } from '@/main/database/rows';
import type {
  InvoicePage,
  InvoiceSearchData,
  InvoiceSummaryDto,
  PageData,
  ReceivableKind,
  ReceivablesPage,
} from '@/shared/contracts';
import { formatRupiah, type LocalDate } from '@/shared/primitives';
import { derivePaymentStatus } from './domain';
import type {
  InvoiceHistoryRepository,
  InvoiceSummaryRow,
  PageWindow,
} from './history-repository';

/** History and receivables pages built from snapshot rows (view mapping). */

export function toInvoiceSummaryDto(row: InvoiceSummaryRow): InvoiceSummaryDto {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    dueDate: row.due_date,
    finalizedAt: row.finalized_at,
    voidedAt: row.voided_at,
    customerName: row.customer_name_snapshot,
    customerPhone: row.customer_phone_snapshot,
    plateNumber: row.plate_number_snapshot,
    channel: { id: row.channel_id, label: row.channel_label_snapshot },
    cashier: { id: row.cashier_id, displayName: row.cashier_name_snapshot },
    amount: formatRupiah(row.amount),
    paidAmount: formatRupiah(row.paid),
    outstandingAmount: formatRupiah(row.amount - row.paid),
    status: row.status,
    paymentStatus: derivePaymentStatus(row.amount, row.paid),
  };
}

function window(page: PageData): PageWindow {
  return { limit: page.size, offset: (page.number - 1) * page.size };
}

function toPage(
  rows: InvoiceSummaryRow[],
  total: bigint,
  page: PageData,
): InvoicePage {
  const count = toNumber(total);
  return {
    items: rows.map(toInvoiceSummaryDto),
    total: count,
    pageNumber: page.number,
    pageSize: page.size,
    hasMore: page.number * page.size < count,
  };
}

export function searchInvoices(
  repo: InvoiceHistoryRepository,
  input: InvoiceSearchData,
): InvoicePage {
  const { rows, total } = repo.search(input.filters, window(input.page));
  return toPage(rows, total, input.page);
}

export function listReceivables(
  repo: InvoiceHistoryRepository,
  kind: ReceivableKind,
  today: LocalDate,
  page: PageData,
): ReceivablesPage {
  const { rows, total, totalOutstanding } = repo.receivables(
    kind,
    today,
    window(page),
  );
  return {
    ...toPage(rows, total, page),
    kind,
    today,
    totalOutstanding: formatRupiah(totalOutstanding),
  };
}
