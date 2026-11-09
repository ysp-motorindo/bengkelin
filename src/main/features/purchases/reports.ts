import type { AppDatabase } from '@/main/database/connection';
import {
  PAYMENT_METHODS,
  type PurchaseReporting,
  type PurchaseCashFlow,
  type PaymentMethod,
} from '@/shared/contracts';
import { formatRupiah } from '@/shared/primitives';
import type { InstantRange } from '@/shared/time';
export function emptyPurchasingReport(): PurchaseReporting {
  const flow = () => ({
    amount: '0',
    count: 0,
    byMethod: PAYMENT_METHODS.map((method) => ({
      method,
      count: 0,
      amount: '0',
    })),
  });
  return {
    purchases: {
      billCount: 0,
      grossSubtotal: '0',
      discountAmount: '0',
      netBeforeAdjustments: '0',
      voidCount: 0,
      voidDeduction: '0',
      creditCount: 0,
      creditAmount: '0',
      netAfterAdjustments: '0',
    },
    purchasePayments: flow(),
    supplierRefunds: flow(),
  };
}
export function readPurchasingReport(
  db: AppDatabase,
  range: InstantRange,
  cashierId?: string,
): PurchaseReporting {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchases'",
      )
      .get()
  )
    return emptyPurchasingReport();
  const params = [range.start, range.end, ...(cashierId ? [cashierId] : [])];
  const where = (instant: string, actor: string) =>
    `${instant}>=? AND ${instant}<?${cashierId ? ' AND ' + actor + '=?' : ''}`;
  const bills = db
    .prepare(
      `SELECT count(*) AS n,COALESCE(sum(subtotal),0) AS gross,COALESCE(sum(discount_amount),0) AS discount,COALESCE(sum(amount),0) AS net FROM purchases WHERE status<>'DRAFT' AND ${where('finalized_at', 'finalized_by')}`,
    )
    .get(...params) as {
    n: bigint;
    gross: bigint;
    discount: bigint;
    net: bigint;
  };
  const voids = db
    .prepare(
      `SELECT count(*) AS n,COALESCE(sum(void_amount),0) AS amount FROM purchases WHERE status='VOID' AND ${where('voided_at', 'voided_by')}`,
    )
    .get(...params) as { n: bigint; amount: bigint };
  const credits = db
    .prepare(
      `SELECT count(*) AS n,COALESCE(sum(amount),0) AS amount FROM purchase_credits WHERE ${where('created_at', 'created_by')}`,
    )
    .get(...params) as { n: bigint; amount: bigint };
  const flow = (
    table: 'purchase_payments' | 'purchase_refunds',
  ): PurchaseCashFlow => {
    const rows = db
      .prepare(
        `SELECT method,count(*) AS n,sum(amount) AS amount FROM ${table === 'purchase_payments' ? '(SELECT method,amount,created_at,created_by FROM purchase_payments UNION ALL SELECT method,amount,created_at,created_by FROM supplier_opening_payments)' : table} WHERE ${where('created_at', 'created_by')} GROUP BY method`,
      )
      .all(...params) as { method: PaymentMethod; n: bigint; amount: bigint }[];
    return {
      amount: formatRupiah(rows.reduce((s, r) => s + r.amount, 0n)),
      count: Number(rows.reduce((s, r) => s + r.n, 0n)),
      byMethod: PAYMENT_METHODS.map((method) => {
        const r = rows.find((x) => x.method === method);
        return {
          method,
          count: Number(r?.n ?? 0n),
          amount: formatRupiah(r?.amount ?? 0n),
        };
      }),
    };
  };
  return {
    purchases: {
      billCount: Number(bills.n),
      grossSubtotal: formatRupiah(bills.gross),
      discountAmount: formatRupiah(bills.discount),
      netBeforeAdjustments: formatRupiah(bills.net),
      voidCount: Number(voids.n),
      voidDeduction: formatRupiah(voids.amount),
      creditCount: Number(credits.n),
      creditAmount: formatRupiah(credits.amount),
      netAfterAdjustments: formatRupiah(
        bills.net - voids.amount - credits.amount,
      ),
    },
    purchasePayments: flow('purchase_payments'),
    supplierRefunds: flow('purchase_refunds'),
  };
}
