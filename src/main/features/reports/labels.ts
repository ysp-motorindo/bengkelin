import {
  PURCHASE_LABELS,
  type PurchaseLabels,
} from '@/main/features/purchases/labels';
import { PRINT_LABELS } from '@/main/features/printing/templates/labels';
import type { Language, PaymentMethod } from '@/shared/contracts';

/**
 * Wording of the printed and exported daily report, in the shop language
 * (spec 54). Shared by the CSV writer and the A4 template so both say the
 * same thing. Payment-method names and page counters come from the invoice
 * print labels.
 */
export interface ReportLabels {
  purchase: PurchaseLabels;
  title: string;
  date: string;
  timezone: string;
  generatedAt: string;
  cashierFilter: string;
  channelFilter: string;
  all: string;
  salesSummary: string;
  salesBasis: string;
  paymentsBasis: string;
  metric: string;
  value: string;
  invoiceCount: string;
  grossSubtotal: string;
  itemDiscounts: string;
  invoiceDiscounts: string;
  netBeforeVoids: string;
  voidCount: string;
  voidDeduction: string;
  netAfterVoids: string;
  byChannel: string;
  byCashier: string;
  channel: string;
  cashier: string;
  netSales: string;
  voids: string;
  invoiceNumber: string;
  finalizedDate: string;
  voidedAt: string;
  voidedBy: string;
  reason: string;
  amount: string;
  paymentsByMethod: string;
  method: string;
  count: string;
  paymentSplit: string;
  received: string;
  sameDayInvoices: string;
  olderInvoices: string;
  openingBalanceRepayments: string;
  openingChannelNote: string;
  paymentCount: string;
  none: string;
  paymentMethod: Record<PaymentMethod, string>;
  pageOf: { before: string; middle: string };
  locale: string;
  /** Base name of the exported file, e.g. `laporan-harian-2026-09-30.csv`. */
  fileName: (date: string) => string;
}

export const REPORT_LABELS: Record<Language, ReportLabels> = {
  id: {
    purchase: PURCHASE_LABELS.id,
    title: 'Laporan Harian',
    date: 'Tanggal',
    timezone: 'Zona waktu',
    generatedAt: 'Dibuat',
    cashierFilter: 'Filter kasir',
    channelFilter: 'Filter kanal penjualan',
    all: 'Semua',
    salesSummary: 'Ringkasan penjualan',
    salesBasis: 'Penjualan menurut waktu finalisasi faktur',
    paymentsBasis: 'Pembayaran menurut waktu diterima',
    metric: 'Keterangan',
    value: 'Nilai',
    invoiceCount: 'Jumlah faktur',
    grossSubtotal: 'Subtotal kotor',
    itemDiscounts: 'Diskon barang',
    invoiceDiscounts: 'Diskon faktur',
    netBeforeVoids: 'Penjualan bersih sebelum void',
    voidCount: 'Jumlah void',
    voidDeduction: 'Potongan void',
    netAfterVoids: 'Penjualan bersih setelah void',
    byChannel: 'Penjualan per kanal',
    byCashier: 'Penjualan per kasir',
    channel: 'Kanal',
    cashier: 'Kasir',
    netSales: 'Penjualan bersih',
    voids: 'Faktur dibatalkan (void)',
    invoiceNumber: 'No. faktur',
    finalizedDate: 'Tanggal penjualan',
    voidedAt: 'Waktu void',
    voidedBy: 'Dibatalkan oleh',
    reason: 'Alasan',
    amount: 'Jumlah',
    paymentsByMethod: 'Pembayaran per metode',
    method: 'Metode',
    count: 'Transaksi',
    paymentSplit: 'Rincian pembayaran',
    received: 'Total uang diterima',
    sameDayInvoices: 'Untuk faktur hari ini',
    olderInvoices: 'Untuk faktur sebelumnya',
    openingBalanceRepayments: 'Pembayaran saldo awal pelanggan',
    openingChannelNote:
      'Filter kanal mengecualikan pembayaran saldo awal pelanggan karena tidak memiliki kanal faktur.',
    paymentCount: 'Jumlah pembayaran',
    none: 'Tidak ada',
    paymentMethod: PRINT_LABELS.id.paymentMethod,
    pageOf: PRINT_LABELS.id.pageOf,
    locale: PRINT_LABELS.id.locale,
    fileName: (date) => `laporan-harian-${date}.csv`,
  },
  en: {
    purchase: PURCHASE_LABELS.en,
    title: 'Daily Report',
    date: 'Date',
    timezone: 'Time zone',
    generatedAt: 'Generated',
    cashierFilter: 'Cashier filter',
    channelFilter: 'Sales channel filter',
    all: 'All',
    salesSummary: 'Sales summary',
    salesBasis: 'Sales by invoice finalization time',
    paymentsBasis: 'Payments by time received',
    metric: 'Item',
    value: 'Value',
    invoiceCount: 'Invoices',
    grossSubtotal: 'Gross subtotal',
    itemDiscounts: 'Item discounts',
    invoiceDiscounts: 'Invoice discounts',
    netBeforeVoids: 'Net sales before voids',
    voidCount: 'Voids',
    voidDeduction: 'Void deductions',
    netAfterVoids: 'Net sales after voids',
    byChannel: 'Sales by channel',
    byCashier: 'Sales by cashier',
    channel: 'Channel',
    cashier: 'Cashier',
    netSales: 'Net sales',
    voids: 'Voided invoices',
    invoiceNumber: 'Invoice no.',
    finalizedDate: 'Sale date',
    voidedAt: 'Voided at',
    voidedBy: 'Voided by',
    reason: 'Reason',
    amount: 'Amount',
    paymentsByMethod: 'Payments by method',
    method: 'Method',
    count: 'Count',
    paymentSplit: 'Payment breakdown',
    received: 'Total money received',
    sameDayInvoices: "On today's invoices",
    olderInvoices: 'On earlier invoices',
    openingBalanceRepayments: 'Customer opening balance repayments',
    openingChannelNote:
      'Channel filters exclude opening balance repayments because they have no invoice channel.',
    paymentCount: 'Payments',
    none: 'None',
    paymentMethod: PRINT_LABELS.en.paymentMethod,
    pageOf: PRINT_LABELS.en.pageOf,
    locale: PRINT_LABELS.en.locale,
    fileName: (date) => `daily-report-${date}.csv`,
  },
};
