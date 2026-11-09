import { z } from 'zod';
import {
  localDateSchema,
  optionalPhone,
  optionalText,
  requiredText,
  uuidSchema,
} from './common';
import { priceSchema } from './catalog';
import {
  discountStagesSchema,
  MAX_LINE_QUANTITY,
  MAX_TOP_DAYS,
} from './drafts';
import { paymentMethodSchema, type PaymentMethod } from './payments';
import type { Instant, Rupiah } from '../primitives';

const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const quantity = z.number().int().min(1).max(MAX_LINE_QUANTITY);
const positiveMoney = priceSchema.refine(
  (v) => BigInt(v) > 0n,
  'validation.invalidMoney',
);
const text = (max: number) => z.string().trim().max(max).nullable();
const stages = discountStagesSchema;
const mutation = {
  requestId: uuidSchema,
  purchaseId: uuidSchema,
  expectedVersion: version,
};
export const purchaseIdInputSchema = z.strictObject({ purchaseId: uuidSchema });
export const saveSupplierInputSchema = z
  .strictObject({
    expectedVersion: version.optional(),
    requestId: uuidSchema,
    id: uuidSchema.optional(),
    name: requiredText(120),
    phoneNumber: optionalPhone,
    email: z
      .string()
      .trim()
      .max(200)
      .refine(
        (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        'validation.invalidEmail',
      )
      .nullish()
      .transform((v) => v || null),
    address: optionalText(300),
    isActive: z.boolean().optional(),
    acknowledgeDuplicates: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.id) === (v.expectedVersion !== undefined), {
    message: 'validation.required',
    path: ['expectedVersion'],
  });
export const searchSuppliersInputSchema = z.strictObject({
  query: z.string().trim().max(100),
  includeInactive: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export const supplierIdInputSchema = z.strictObject({ id: uuidSchema });
export type SaveSupplierInput = z.input<typeof saveSupplierInputSchema>;
export type SaveSupplierData = z.output<typeof saveSupplierInputSchema>;
export type SearchSuppliersInput = z.infer<typeof searchSuppliersInputSchema>;
export interface SupplierDto {
  externalId: string | null;
  version: number;
  id: string;
  name: string;
  phoneNumber: string | null;
  email: string | null;
  address: string | null;
  isActive: boolean;
  createdAt: Instant;
  updatedAt: Instant;
}
export type SaveSupplierResult =
  | { saved: true; supplier: SupplierDto }
  | {
      saved: false;
      warning: { code: 'DUPLICATE_PHONE'; matches: SupplierDto[] };
    };
export interface PurchaseAllocation {
  method: PaymentMethod;
  amount: Rupiah;
  reference: string | null;
  note: string | null;
}
const allocation = z.strictObject({
  method: paymentMethodSchema,
  amount: positiveMoney,
  reference: optionalText(100),
  note: optionalText(500),
});
export const createPurchaseDraftInputSchema = z.strictObject({
  requestId: uuidSchema,
  billDate: localDateSchema,
});
export const purchaseDraftCommandSchema = z.strictObject({
  ...mutation,
  op: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('updateHeader'),
      changes: z.strictObject({
        supplierId: uuidSchema.nullable().optional(),
        supplierBillReference: text(100).optional(),
        billDate: localDateSchema.optional(),
        topDays: z.number().int().min(0).max(MAX_TOP_DAYS).optional(),
        note: text(1000).optional(),
      }),
    }),
    z
      .strictObject({
        kind: z.literal('addCatalogLine'),
        catalogItemId: uuidSchema.optional(),
        barcode: requiredText(100).optional(),
        quantity: quantity.optional(),
      })
      .refine(
        (v) => Boolean(v.catalogItemId) !== Boolean(v.barcode),
        'validation.required',
      ),
    z.strictObject({
      kind: z.literal('addCustomLine'),
      type: z.enum(['SERVICE', 'NON_STOCK_ITEM']),
      title: requiredText(200),
      unitId: uuidSchema,
      quantity: quantity.optional(),
      unitPrice: priceSchema.nullable().optional(),
    }),
    z.strictObject({
      kind: z.literal('updateLine'),
      lineId: uuidSchema,
      changes: z.strictObject({
        quantity: quantity.optional(),
        unitPrice: priceSchema.nullable().optional(),
        title: requiredText(200).optional(),
      }),
    }),
    z.strictObject({ kind: z.literal('removeLine'), lineId: uuidSchema }),
    z.strictObject({
      kind: z.literal('setDiscounts'),
      lineId: uuidSchema.nullable(),
      stages,
    }),
    z.strictObject({
      kind: z.literal('setVatRate'),
      vatRateBps: z.number().int().min(0).max(10000),
    }),
    z.strictObject({
      kind: z.literal('setPayments'),
      payments: z.array(allocation).max(10),
    }),
    z.strictObject({ kind: z.literal('discard') }),
  ]),
});
export type PurchaseDraftCommand = z.output<typeof purchaseDraftCommandSchema>;
export type PurchaseDraftOperation = PurchaseDraftCommand['op'];
export interface PurchaseTotals {
  itemDiscountAmount: Rupiah;
  billDiscountAmount: Rupiah;
  subtotal: Rupiah;
  discountAmount: Rupiah;
  amount: Rupiah;
  taxSubtotal: Rupiah;
  vatAmount: Rupiah;
}
export interface PurchaseLineDto {
  id: string;
  catalogItemId: string | null;
  type: 'STOCK_ITEM' | 'NON_STOCK_ITEM' | 'SERVICE';
  title: string;
  itemCode: string | null;
  unitLabel: string;
  trackInventory: boolean;
  quantity: number;
  unitPrice: Rupiah | null;
  discountStages: number[];
  amount: Rupiah | null;
  taxSubtotal: Rupiah | null;
  vatAmount: Rupiah | null;
  receivedQuantity: number;
  creditedQuantity: number;
  remainingQuantity: number;
}
export interface PurchaseDraftView {
  id: string;
  version: number;
  status: 'DRAFT' | 'FINALIZED' | 'VOID';
  supplier: SupplierDto | null;
  supplierBillReference: string | null;
  billDate: string;
  topDays: number;
  dueDate: string;
  note: string | null;
  vatRateBps: number;
  discountStages: number[];
  lines: PurchaseLineDto[];
  payments: PurchaseAllocation[];
  totals: PurchaseTotals | null;
  createdAt: Instant;
  updatedAt: Instant;
  discardedAt: Instant | null;
}
export interface PurchaseWarning {
  code: 'ZERO_UNIT_PRICE' | 'NEGATIVE_STOCK';
  params: Record<string, string>;
}
export const purchaseWarningSchema = z.strictObject({
  code: z.enum(['ZERO_UNIT_PRICE', 'NEGATIVE_STOCK']),
  params: z.record(z.string(), z.string()),
});
export interface PurchaseIssue {
  code: string;
  params?: Record<string, string>;
}
export interface PurchaseFinalizePreview {
  purchaseId: string;
  version: number;
  totals: PurchaseTotals | null;
  errors: PurchaseIssue[];
  warnings: PurchaseWarning[];
}
export const finalizePurchaseInputSchema = z.strictObject({
  ...mutation,
  acknowledgedWarnings: z.array(purchaseWarningSchema).max(500),
});
export const purchaseMoneyInputSchema = z.strictObject({
  ...mutation,
  ...allocation.shape,
});
export const voidPurchaseInputSchema = z.strictObject({
  ...mutation,
  reason: requiredText(500),
});
export const receivePurchaseInputSchema = z.strictObject({
  ...mutation,
  stockLocationId: uuidSchema,
  lines: z
    .array(z.strictObject({ purchaseLineId: uuidSchema, quantity }))
    .min(1)
    .max(500),
  note: optionalText(500),
});
export const reversePurchaseReceiptInputSchema = z.strictObject({
  ...mutation,
  receiptId: uuidSchema,
  reason: requiredText(500),
  acknowledgedWarnings: z.array(purchaseWarningSchema).max(500),
});
const creditLine = z.strictObject({
  purchaseLineId: uuidSchema,
  receiptItemId: uuidSchema.nullable(),
  quantity,
});
export const previewPurchaseCreditInputSchema = z.strictObject({
  purchaseId: uuidSchema,
  lines: z.array(creditLine).min(1).max(500),
});
export const purchaseCreditInputSchema = z.strictObject({
  ...mutation,
  lines: z.array(creditLine).min(1).max(500),
  reason: requiredText(500),
  acknowledgedWarnings: z.array(purchaseWarningSchema).max(500),
});
export type FinalizePurchaseData = z.output<typeof finalizePurchaseInputSchema>;
export type PurchaseMoneyData = z.output<typeof purchaseMoneyInputSchema>;
export type ReceivePurchaseData = z.output<typeof receivePurchaseInputSchema>;
export type ReversePurchaseReceiptData = z.output<
  typeof reversePurchaseReceiptInputSchema
>;
export type PurchaseCreditData = z.output<typeof purchaseCreditInputSchema>;
export type PreviewPurchaseCreditData = z.output<
  typeof previewPurchaseCreditInputSchema
>;
export interface PurchaseMoneyDto extends PurchaseAllocation {
  id: string;
  createdAt: Instant;
  cashierName: string;
}
export interface PurchaseReceiptDto {
  id: string;
  documentNumber: string;
  stockLocationId: string;
  locationLabel: string;
  createdAt: Instant;
  cashierName: string;
  note: string | null;
  reversedAt: Instant | null;
  lines: {
    id: string;
    purchaseLineId: string;
    quantity: number;
    creditedQuantity: number;
  }[];
}
export interface PurchaseCreditDto {
  id: string;
  documentNumber: string;
  amount: Rupiah;
  taxSubtotal: Rupiah;
  vatAmount: Rupiah;
  createdAt: Instant;
  cashierName: string;
  reason: string;
  lines: {
    purchaseLineId: string;
    receiptItemId: string | null;
    quantity: number;
    amount: Rupiah;
  }[];
}
export interface PurchaseView extends PurchaseDraftView {
  documentNumber: string;
  finalizedAt: Instant;
  shop: { name: string; address: string | null; phoneNumber: string | null };
  outgoingPayments: PurchaseMoneyDto[];
  refunds: PurchaseMoneyDto[];
  receipts: PurchaseReceiptDto[];
  credits: PurchaseCreditDto[];
  creditedAmount: Rupiah;
  netAmount: Rupiah;
  paidAmount: Rupiah;
  refundedAmount: Rupiah;
  outstandingAmount: Rupiah;
  refundDue: Rupiah;
  settlementStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'SETTLED' | 'REFUND_DUE';
  receivingStatus: 'NOT_RECEIVED' | 'PARTIALLY_RECEIVED' | 'COMPLETE';
  void: { at: Instant; reason: string; amount: Rupiah } | null;
}
export interface PurchaseCreditPreview {
  purchaseId: string;
  version: number;
  totals: PurchaseTotals;
  warnings: PurchaseWarning[];
}
export const searchPurchasesInputSchema = z.strictObject({
  query: z.string().trim().max(100).optional(),
  supplierId: uuidSchema.optional(),
  fromDate: localDateSchema.optional(),
  toDate: localDateSchema.optional(),
  receivingOnly: z.boolean().optional(),
  settlement: z.enum(['PAYABLE', 'REFUND_DUE']).optional(),
  page: z.number().int().min(1).max(1000000).optional(),
});
export type SearchPurchasesData = z.output<typeof searchPurchasesInputSchema>;
export interface PurchasePage {
  items: PurchaseView[];
  page: number;
  hasMore: boolean;
  payableAmount: Rupiah;
  refundDue: Rupiah;
}
export const purchasePrintInputSchema = z.strictObject({
  purchaseId: uuidSchema,
  documentType: z.enum(['BILL', 'RECEIPT', 'CREDIT']),
  documentId: uuidSchema,
  format: z.enum(['A4', 'THERMAL_58', 'THERMAL_80']),
});
export type PurchasePrintInput = z.infer<typeof purchasePrintInputSchema>;

export const previewPurchaseReceiptReversalInputSchema = z.strictObject({
  purchaseId: uuidSchema,
  receiptId: uuidSchema,
});
