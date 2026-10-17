import type {
  Language,
  PaymentMethod,
  PaymentStatus,
} from '@/shared/contracts';

/**
 * Printed wording in both languages (spec 54). The shop language setting
 * picks one. `Record<Language, PrintLabels>` makes a missing key a type error.
 */
export interface PrintLabels {
  invoice: string;
  reprint: string;
  void: string;
  voidBanner: string;
  voidReason: string;
  voidedBy: string;
  invoiceNumber: string;
  invoiceDate: string;
  finalizedAt: string;
  top: string;
  topDays: (days: number, formatted?: string) => string;
  method: string;
  dueDate: string;
  channel: string;
  cashier: string;
  customer: string;
  phone: string;
  vehicle: string;
  plate: string;
  odometer: string;
  note: string;
  item: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  amount: string;
  mechanic: string;
  stage: (sequence: number, percent: string) => string;
  invoiceDiscount: (sequence: number, percent: string) => string;
  subtotal: string;
  itemDiscounts: string;
  invoiceDiscounts: string;
  discountTotal: string;
  total: string;
  payments: string;
  noPayments: string;
  paid: string;
  outstanding: string;
  paymentStatus: string;
  reference: string;
  receivedBy: string;
  continued: string;
  /** Static text around the CSS page counters. */
  pageOf: { before: string; middle: string };
  paymentMethod: Record<PaymentMethod, string>;
  status: Record<PaymentStatus, string>;
  locale: string;
  decimal: string;
}

export const PRINT_LABELS: Record<Language, PrintLabels> = {
  id: {
    invoice: 'FAKTUR',
    reprint: 'CETAK ULANG',
    void: 'VOID',
    voidBanner: 'DIBATALKAN (VOID)',
    voidReason: 'Alasan',
    voidedBy: 'Dibatalkan oleh',
    invoiceNumber: 'No. Faktur',
    invoiceDate: 'Tanggal',
    finalizedAt: 'Waktu final',
    top: 'TOP',
    topDays: (days, formatted) => `${formatted ?? days} hari`,
    method: 'Metode',
    dueDate: 'Jatuh tempo',
    channel: 'Kanal',
    cashier: 'Kasir',
    customer: 'Pelanggan',
    phone: 'Telepon',
    vehicle: 'Kendaraan',
    plate: 'No. polisi',
    odometer: 'Odometer',
    note: 'Catatan',
    item: 'Barang/Jasa',
    quantity: 'Qty',
    unitPrice: 'Harga',
    discount: 'Diskon',
    amount: 'Jumlah',
    mechanic: 'Mekanik',
    stage: (n, p) => `Diskon ${n} (${p}%)`,
    invoiceDiscount: (n, p) => `Diskon faktur ${n} (${p}%)`,
    subtotal: 'Subtotal',
    itemDiscounts: 'Diskon barang',
    invoiceDiscounts: 'Diskon faktur',
    discountTotal: 'Total diskon',
    total: 'TOTAL',
    payments: 'Pembayaran',
    noPayments: 'Belum ada pembayaran',
    paid: 'Dibayar',
    outstanding: 'Sisa tagihan',
    paymentStatus: 'Status',
    reference: 'Ref.',
    receivedBy: 'Diterima',
    continued: 'lanjutan',
    pageOf: { before: 'Hal. ', middle: '/' },
    paymentMethod: {
      CASH: 'Tunai',
      QRIS: 'QRIS',
      BANK_TRANSFER: 'Transfer bank',
      DEBIT_CARD: 'Kartu debit',
      CREDIT_CARD: 'Kartu kredit',
      OTHER: 'Lainnya',
    },
    status: {
      UNPAID: 'Belum dibayar',
      PARTIALLY_PAID: 'Dibayar sebagian',
      PAID: 'Lunas',
    },
    locale: 'id-ID',
    decimal: ',',
  },
  en: {
    invoice: 'INVOICE',
    reprint: 'REPRINT',
    void: 'VOID',
    voidBanner: 'CANCELLED (VOID)',
    voidReason: 'Reason',
    voidedBy: 'Voided by',
    invoiceNumber: 'Invoice no.',
    invoiceDate: 'Date',
    finalizedAt: 'Finalized',
    top: 'TOP',
    topDays: (days, formatted) =>
      `${formatted ?? days} ${days === 1 ? 'day' : 'days'}`,
    method: 'Method',
    dueDate: 'Due date',
    channel: 'Channel',
    cashier: 'Cashier',
    customer: 'Customer',
    phone: 'Phone',
    vehicle: 'Vehicle',
    plate: 'Plate no.',
    odometer: 'Odometer',
    note: 'Note',
    item: 'Item/Service',
    quantity: 'Qty',
    unitPrice: 'Price',
    discount: 'Discount',
    amount: 'Amount',
    mechanic: 'Mechanic',
    stage: (n, p) => `Discount ${n} (${p}%)`,
    invoiceDiscount: (n, p) => `Invoice discount ${n} (${p}%)`,
    subtotal: 'Subtotal',
    itemDiscounts: 'Item discounts',
    invoiceDiscounts: 'Invoice discounts',
    discountTotal: 'Total discount',
    total: 'TOTAL',
    payments: 'Payments',
    noPayments: 'No payments yet',
    paid: 'Paid',
    outstanding: 'Outstanding',
    paymentStatus: 'Status',
    reference: 'Ref.',
    receivedBy: 'Received by',
    continued: 'continued',
    pageOf: { before: 'Page ', middle: ' of ' },
    paymentMethod: {
      CASH: 'Cash',
      QRIS: 'QRIS',
      BANK_TRANSFER: 'Bank transfer',
      DEBIT_CARD: 'Debit card',
      CREDIT_CARD: 'Credit card',
      OTHER: 'Other',
    },
    status: {
      UNPAID: 'Unpaid',
      PARTIALLY_PAID: 'Partially paid',
      PAID: 'Paid',
    },
    locale: 'en-GB',
    decimal: '.',
  },
};
