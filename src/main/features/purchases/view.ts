import type { AppDatabase } from '@/main/database/connection';
import type { Session } from '@/main/features/auth/sessions';
import type { Clock } from '@/shared/time';
import type {
  PurchaseCreditDto,
  PurchaseMoneyDto,
  PurchaseReceiptDto,
  PurchaseView,
} from '@/shared/contracts';
import { PurchaseRepository } from './repository';
import { purchaseBalance } from './domain';
export function purchaseView(
  db: AppDatabase,
  clock: Clock,
  actor: Session,
  id: string,
): PurchaseView {
  const repo = new PurchaseRepository(db);
  const row = repo.find(id);
  const draft = repo.draftView(actor, id, clock);
  const money = (
    table: 'purchase_payments' | 'purchase_refunds',
  ): PurchaseMoneyDto[] =>
    (
      db
        .prepare(
          `SELECT id,method,amount,reference,note,created_at,cashier_name_snapshot FROM ${table} WHERE purchase_id=? ORDER BY created_at,id`,
        )
        .all(id) as {
        id: string;
        method: PurchaseMoneyDto['method'];
        amount: bigint;
        reference: string | null;
        note: string | null;
        created_at: string;
        cashier_name_snapshot: string;
      }[]
    ).map((r) => ({
      id: r.id,
      method: r.method,
      amount: r.amount.toString(),
      reference: r.reference,
      note: r.note,
      createdAt: r.created_at,
      cashierName: r.cashier_name_snapshot,
    }));
  const outgoingPayments = money('purchase_payments');
  const refunds = money('purchase_refunds');
  const credits: PurchaseCreditDto[] = (
    db
      .prepare(
        'SELECT * FROM purchase_credits WHERE purchase_id=? ORDER BY created_at,id',
      )
      .all(id) as {
      id: string;
      document_number: string;
      amount: bigint;
      tax_subtotal: bigint;
      vat_amount: bigint;
      created_at: string;
      cashier_name_snapshot: string;
      reason: string;
    }[]
  ).map((r) => ({
    id: r.id,
    documentNumber: r.document_number,
    amount: r.amount.toString(),
    taxSubtotal: r.tax_subtotal.toString(),
    vatAmount: r.vat_amount.toString(),
    createdAt: r.created_at,
    cashierName: r.cashier_name_snapshot,
    reason: r.reason,
    lines: (
      db
        .prepare(
          'SELECT * FROM purchase_credit_items WHERE credit_id=? ORDER BY rowid',
        )
        .all(r.id) as {
        purchase_item_id: string;
        receipt_item_id: string | null;
        quantity: bigint;
        amount: bigint;
      }[]
    ).map((l) => ({
      purchaseLineId: l.purchase_item_id,
      receiptItemId: l.receipt_item_id,
      quantity: Number(l.quantity),
      amount: l.amount.toString(),
    })),
  }));
  const receipts: PurchaseReceiptDto[] = (
    db
      .prepare(
        'SELECT r.*,v.created_at AS reversed_at FROM purchase_receipts r LEFT JOIN purchase_receipt_reversals v ON v.receipt_id=r.id WHERE r.purchase_id=? ORDER BY r.created_at,r.id',
      )
      .all(id) as {
      id: string;
      document_number: string;
      stock_location_id: string;
      location_snapshot: string;
      created_at: string;
      cashier_name_snapshot: string;
      note: string | null;
      reversed_at: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    documentNumber: r.document_number,
    stockLocationId: r.stock_location_id,
    locationLabel: (JSON.parse(r.location_snapshot) as { label: string }).label,
    createdAt: r.created_at,
    cashierName: r.cashier_name_snapshot,
    note: r.note,
    reversedAt: r.reversed_at,
    lines: (
      db
        .prepare(
          'SELECT * FROM purchase_receipt_items WHERE receipt_id=? ORDER BY rowid',
        )
        .all(r.id) as {
        id: string;
        purchase_item_id: string;
        quantity: bigint;
      }[]
    ).map((l) => ({
      id: l.id,
      purchaseLineId: l.purchase_item_id,
      quantity: Number(l.quantity),
      creditedQuantity: credits.reduce(
        (s, c) =>
          s +
          c.lines
            .filter((x) => x.receiptItemId === l.id)
            .reduce((a, x) => a + x.quantity, 0),
        0,
      ),
    })),
  }));
  const sum = (items: { amount: string }[]) =>
    items.reduce((s, r) => s + BigInt(r.amount), 0n);
  const balance = purchaseBalance(
    row.amount ?? 0n,
    sum(credits),
    sum(outgoingPayments),
    sum(refunds),
  );
  const lines = draft.lines.map((l) => {
    const received = receipts
      .filter((r) => !r.reversedAt)
      .reduce(
        (s, r) =>
          s +
          r.lines
            .filter((x) => x.purchaseLineId === l.id)
            .reduce((a, x) => a + x.quantity, 0),
        0,
      );
    const unreceived = credits.reduce(
      (s, c) =>
        s +
        c.lines
          .filter((x) => x.purchaseLineId === l.id && !x.receiptItemId)
          .reduce((a, x) => a + x.quantity, 0),
      0,
    );
    return {
      ...l,
      receivedQuantity: received,
      creditedQuantity: credits.reduce(
        (s, c) =>
          s +
          c.lines
            .filter((x) => x.purchaseLineId === l.id)
            .reduce((a, x) => a + x.quantity, 0),
        0,
      ),
      remainingQuantity:
        row.status === 'VOID' ? 0 : l.quantity - received - unreceived,
    };
  });
  return {
    ...draft,
    lines,
    supplier: row.supplier_snapshot
      ? (JSON.parse(row.supplier_snapshot) as PurchaseView['supplier'])
      : draft.supplier,
    documentNumber: row.document_number!,
    finalizedAt: row.finalized_at!,
    shop: row.shop_snapshot
      ? (JSON.parse(row.shop_snapshot) as PurchaseView['shop'])
      : { name: '', address: null, phoneNumber: null },
    outgoingPayments,
    refunds,
    credits,
    receipts,
    creditedAmount: sum(credits).toString(),
    netAmount: (
      (row.amount ?? 0n) -
      sum(credits) -
      (row.void_amount ?? 0n)
    ).toString(),
    paidAmount: sum(outgoingPayments).toString(),
    refundedAmount: sum(refunds).toString(),
    outstandingAmount:
      row.status === 'VOID' ? '0' : balance.outstanding.toString(),
    refundDue: balance.refundDue.toString(),
    settlementStatus:
      balance.refundDue > 0n
        ? 'REFUND_DUE'
        : balance.outstanding === 0n
          ? 'SETTLED'
          : sum(outgoingPayments) === 0n
            ? 'UNPAID'
            : 'PARTIALLY_PAID',
    receivingStatus: lines.every((l) => l.remainingQuantity === 0)
      ? 'COMPLETE'
      : lines.some((l) => l.receivedQuantity > 0)
        ? 'PARTIALLY_RECEIVED'
        : 'NOT_RECEIVED',
    void: row.voided_at
      ? {
          at: row.voided_at,
          reason: row.void_reason!,
          amount: row.void_amount!.toString(),
        }
      : null,
  };
}
