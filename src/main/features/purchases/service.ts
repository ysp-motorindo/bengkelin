import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/main/database/connection';
import { requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import { SettingsRepository } from '@/main/features/settings/repository';
import { CatalogRepository } from '@/main/features/catalog/repository';
import { canonicalJson } from '@/main/database/idempotency';
import type {
  FinalizePurchaseData,
  PurchaseFinalizePreview,
  PurchaseMoneyData,
  PurchasePage,
  PurchaseView,
  SearchPurchasesData,
} from '@/shared/contracts';
import { DomainError, parseRupiah } from '@/shared/primitives';
import { businessDay, type Clock } from '@/shared/time';
import { PurchaseRepository } from './repository';
import {
  allocatePurchaseNumber,
  bumpPurchase,
  requireIssued,
  writePurchase,
  type PurchaseContext,
} from './context';
import { purchaseView } from './view';
export class PurchaseService {
  constructor(private readonly deps: { db: AppDatabase; clock: Clock }) {}
  previewFinalize(
    session: Session | undefined,
    input: { purchaseId: string },
  ): PurchaseFinalizePreview {
    const actor = requireSession(session);
    return this.deps.db.transaction(() =>
      this.preview(
        {
          db: this.deps.db,
          clock: this.deps.clock,
          repo: new PurchaseRepository(this.deps.db),
        },
        actor,
        input.purchaseId,
      ),
    )();
  }
  private preview(
    ctx: PurchaseContext,
    actor: Session,
    id: string,
  ): PurchaseFinalizePreview {
    const row = ctx.repo.open(id);
    const view = ctx.repo.draftView(actor, id, ctx.clock);
    const errors: PurchaseFinalizePreview['errors'] = [];
    const warnings: PurchaseFinalizePreview['warnings'] = [];
    if (!view.supplier) errors.push({ code: 'SUPPLIER_REQUIRED' });
    else if (!view.supplier.isActive)
      errors.push({ code: 'SUPPLIER_INACTIVE' });
    if (!view.lines.length) errors.push({ code: 'DRAFT_EMPTY' });
    if (view.lines.some((l) => l.unitPrice === null))
      errors.push({ code: 'PRICE_REQUIRED' });
    for (const line of view.lines) {
      if (line.unitPrice === '0')
        warnings.push({
          code: 'ZERO_UNIT_PRICE',
          params: { lineId: line.id, title: line.title },
        });
      if (
        line.catalogItemId &&
        !new CatalogRepository(ctx.db).find(line.catalogItemId)?.isActive
      )
        errors.push({
          code: 'CATALOG_ITEM_INACTIVE',
          params: { title: line.title },
        });
    }
    if (
      row.bill_date >
      businessDay(
        ctx.clock.now(),
        new SettingsRepository(ctx.db).getShop().timezone,
      )
    )
      errors.push({ code: 'INVOICE_DATE_IN_FUTURE' });
    if (
      view.totals &&
      view.payments.reduce((s, p) => s + parseRupiah(p.amount), 0n) >
        parseRupiah(view.totals.amount)
    )
      errors.push({ code: 'PAYMENT_EXCEEDS_AMOUNT' });
    return {
      purchaseId: id,
      version: view.version,
      totals: view.totals,
      errors,
      warnings,
    };
  }
  finalize(
    session: Session | undefined,
    input: FinalizePurchaseData,
  ): PurchaseView {
    return writePurchase(
      this.deps,
      session,
      'purchases.finalize',
      input,
      (ctx, actor, row) => {
        const preview = this.preview(ctx, actor, row.id);
        if (preview.errors.length)
          throw new DomainError(preview.errors[0]!.code);
        if (
          canonicalJson(preview.warnings) !==
          canonicalJson(input.acknowledgedWarnings)
        )
          throw new DomainError('FINALIZE_WARNINGS_CHANGED');
        const view = ctx.repo.draftView(actor, row.id, ctx.clock);
        const number = allocatePurchaseNumber(ctx, 'PUR');
        ctx.db
          .prepare(
            "UPDATE purchases SET status='FINALIZED',document_number=?,supplier_snapshot=?,shop_snapshot=?,finalized_at=?,finalized_by=?,version=version+1,updated_at=?,updated_by=? WHERE id=?",
          )
          .run(
            number,
            JSON.stringify(view.supplier),
            JSON.stringify(new SettingsRepository(ctx.db).getShop()),
            ctx.clock.now(),
            actor.cashierId,
            ctx.clock.now(),
            actor.cashierId,
            row.id,
          );
        for (const p of view.payments)
          ctx.db
            .prepare(
              "INSERT INTO purchase_payments(id,purchase_id,method,amount,reference,note,created_at,created_by,cashier_name_snapshot,source) VALUES(?,?,?,?,?,?,?,?,?,'CHECKOUT')",
            )
            .run(
              randomUUID(),
              row.id,
              p.method,
              parseRupiah(p.amount),
              p.reference,
              p.note,
              ctx.clock.now(),
              actor.cashierId,
              actor.displayName,
            );
        return purchaseView(ctx.db, ctx.clock, actor, row.id);
      },
    );
  }
  get(
    session: Session | undefined,
    input: { purchaseId: string },
  ): PurchaseView {
    const actor = requireSession(session);
    return this.deps.db.transaction(() => {
      const row = new PurchaseRepository(this.deps.db).find(input.purchaseId);
      if (row.status === 'DRAFT')
        throw new DomainError('PURCHASE_NOT_FINALIZED');
      return purchaseView(this.deps.db, this.deps.clock, actor, row.id);
    })();
  }
  recordPayment(session: Session | undefined, input: PurchaseMoneyData) {
    return this.money(session, input, false);
  }
  recordRefund(session: Session | undefined, input: PurchaseMoneyData) {
    return this.money(session, input, true);
  }
  private money(
    session: Session | undefined,
    input: PurchaseMoneyData,
    refund: boolean,
  ) {
    return writePurchase(
      this.deps,
      session,
      refund ? 'purchases.recordRefund' : 'purchases.recordPayment',
      input,
      (ctx, actor, row) => {
        requireIssued(row);
        const view = purchaseView(ctx.db, ctx.clock, actor, row.id);
        const amount = parseRupiah(input.amount);
        if (amount <= 0n) throw new DomainError('INVALID_MONEY');
        if (
          amount > parseRupiah(refund ? view.refundDue : view.outstandingAmount)
        )
          throw new DomainError(
            refund ? 'REFUND_EXCEEDS_AMOUNT' : 'PAYMENT_EXCEEDS_AMOUNT',
          );
        const values = [
          randomUUID(),
          row.id,
          input.method,
          amount,
          input.reference,
          input.note,
          ctx.clock.now(),
          actor.cashierId,
          actor.displayName,
        ];
        if (refund)
          ctx.db
            .prepare(
              'INSERT INTO purchase_refunds(id,purchase_id,method,amount,reference,note,created_at,created_by,cashier_name_snapshot) VALUES(?,?,?,?,?,?,?,?,?)',
            )
            .run(...values);
        else
          ctx.db
            .prepare(
              "INSERT INTO purchase_payments(id,purchase_id,method,amount,reference,note,created_at,created_by,cashier_name_snapshot,source) VALUES(?,?,?,?,?,?,?,?,?,'LATER')",
            )
            .run(...values);
        bumpPurchase(ctx, actor, row.id);
        return purchaseView(ctx.db, ctx.clock, actor, row.id);
      },
    );
  }
  void(
    session: Session | undefined,
    input: {
      requestId: string;
      purchaseId: string;
      expectedVersion: number;
      reason: string;
    },
  ) {
    return writePurchase(
      this.deps,
      session,
      'purchases.void',
      input,
      (ctx, actor, row) => {
        requireIssued(row);
        const view = purchaseView(ctx.db, ctx.clock, actor, row.id);
        if (view.outgoingPayments.length)
          throw new DomainError('PAID_INVOICE_CANNOT_BE_VOIDED');
        if (view.receipts.some((r) => !r.reversedAt))
          throw new DomainError('PURCHASE_RECEIPTS_MUST_BE_REVERSED');
        if (!input.reason.trim()) throw new DomainError('VOID_REASON_REQUIRED');
        ctx.db
          .prepare(
            "UPDATE purchases SET status='VOID',voided_at=?,voided_by=?,void_reason=?,void_amount=?,version=version+1,updated_at=?,updated_by=? WHERE id=?",
          )
          .run(
            ctx.clock.now(),
            actor.cashierId,
            input.reason,
            parseRupiah(view.outstandingAmount),
            ctx.clock.now(),
            actor.cashierId,
            row.id,
          );
        return purchaseView(ctx.db, ctx.clock, actor, row.id);
      },
    );
  }
  search(
    session: Session | undefined,
    input: SearchPurchasesData,
  ): PurchasePage {
    const actor = requireSession(session);
    return this.deps.db.transaction(() => {
      // Settlement filters use posted event sums; never net one bill against another.
      const where = ["p.status<>'DRAFT'"];
      const args: (string | number)[] = [];
      if (input.supplierId) {
        where.push('p.supplier_id=?');
        args.push(input.supplierId);
      }
      if (input.fromDate) {
        where.push('p.bill_date>=?');
        args.push(input.fromDate);
      }
      if (input.toDate) {
        where.push('p.bill_date<=?');
        args.push(input.toDate);
      }
      if (input.query) {
        where.push(
          "(instr(lower(p.document_number),lower(?))>0 OR instr(lower(COALESCE(p.supplier_bill_reference,'')),lower(?))>0 OR instr(lower(json_extract(p.supplier_snapshot,'$.name')),lower(?))>0)",
        );
        args.push(input.query, input.query, input.query);
      }
      const net =
        'p.amount - COALESCE((SELECT SUM(c.amount) FROM purchase_credits c WHERE c.purchase_id=p.id),0) - COALESCE((SELECT SUM(m.amount) FROM purchase_payments m WHERE m.purchase_id=p.id),0) + COALESCE((SELECT SUM(r.amount) FROM purchase_refunds r WHERE r.purchase_id=p.id),0)';
      if (input.receivingOnly)
        where.push(
          "p.status='FINALIZED' AND EXISTS(SELECT 1 FROM purchase_items i WHERE i.purchase_id=p.id AND i.removed_at IS NULL AND i.quantity > COALESCE((SELECT SUM(ri.quantity) FROM purchase_receipt_items ri JOIN purchase_receipts r ON r.id=ri.receipt_id WHERE ri.purchase_item_id=i.id AND NOT EXISTS(SELECT 1 FROM purchase_receipt_reversals rv WHERE rv.receipt_id=r.id)),0) + COALESCE((SELECT SUM(ci.quantity) FROM purchase_credit_items ci WHERE ci.purchase_item_id=i.id AND ci.receipt_item_id IS NULL),0))",
        );
      if (input.settlement)
        where.push(
          "p.status='FINALIZED' AND (" +
            net +
            ')' +
            (input.settlement === 'PAYABLE' ? '>0' : '<0'),
        );
      const query = `FROM purchases p WHERE ${where.join(' AND ')}`;
      const page = input.page ?? 1;
      const rows = this.deps.db
        .prepare(
          `SELECT p.id ${query} ORDER BY p.finalized_at DESC,p.id DESC LIMIT 51 OFFSET ?`,
        )
        .all(...args, (page - 1) * 50) as { id: string }[];
      const balance = `CASE WHEN p.status='VOID' THEN 0 ELSE (${net}) END`;
      const totals = this.deps.db
        .prepare(
          `SELECT COALESCE(SUM(MAX(${balance},0)),0) AS payable,COALESCE(SUM(MAX(-(${balance}),0)),0) AS refund ${query}`,
        )
        .get(...args) as { payable: bigint; refund: bigint };
      return {
        items: rows
          .slice(0, 50)
          .map((r) => purchaseView(this.deps.db, this.deps.clock, actor, r.id)),
        page,
        hasMore: rows.length > 50,
        payableAmount: totals.payable.toString(),
        refundDue: totals.refund.toString(),
      };
    })();
  }
}
