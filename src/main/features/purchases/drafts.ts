import { randomUUID } from 'node:crypto';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { runIdempotent } from '@/main/database/idempotency';
import { appendAudit } from '@/main/database/audit';
import { requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type { CatalogService } from '@/main/features/catalog/service';
import { SupplierService } from '@/main/features/suppliers/service';
import { calculateDueDate } from '@/main/features/invoices/domain';
import type {
  PurchaseDraftCommand,
  PurchaseDraftOperation,
  PurchaseDraftView,
} from '@/shared/contracts';
import { DomainError, parseRupiah } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { PurchaseRepository } from './repository';
export class PurchaseDraftService {
  readonly repo: PurchaseRepository;
  constructor(
    private readonly deps: {
      db: AppDatabase;
      clock: Clock;
      catalog: CatalogService;
    },
  ) {
    this.repo = new PurchaseRepository(deps.db);
  }
  create(
    session: Session | undefined,
    input: { requestId: string; billDate: string },
  ): PurchaseDraftView {
    const actor = requireSession(session);
    return this.write(actor, 'purchaseDrafts.create', input, () => {
      const id = randomUUID();
      const now = this.deps.clock.now();
      this.deps.db
        .prepare(
          'INSERT INTO purchases(id,bill_date,due_date,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          id,
          input.billDate,
          input.billDate,
          actor.cashierId,
          actor.cashierId,
          now,
          now,
        );
      this.repo.recalculate(id);
      return this.repo.draftView(actor, id, this.deps.clock);
    });
  }
  list(session: Session | undefined): PurchaseDraftView[] {
    const actor = requireSession(session);
    return (
      this.deps.db
        .prepare(
          "SELECT id FROM purchases WHERE status='DRAFT' AND discarded_at IS NULL ORDER BY updated_at DESC,id",
        )
        .all() as { id: string }[]
    ).map((r) => this.repo.draftView(actor, r.id, this.deps.clock));
  }
  get(session: Session | undefined, input: { purchaseId: string }) {
    const actor = requireSession(session);
    this.repo.open(input.purchaseId);
    return this.repo.draftView(actor, input.purchaseId, this.deps.clock);
  }
  apply(session: Session | undefined, input: PurchaseDraftCommand) {
    const actor = requireSession(session);
    return this.write(actor, 'purchaseDrafts.apply', input, () => {
      const r = this.repo.open(input.purchaseId);
      if (r.version !== BigInt(input.expectedVersion))
        throw new DomainError('DRAFT_VERSION_CONFLICT');
      const now = this.deps.clock.now();
      const { db } = this.deps;
      if (input.op.kind === 'discard') {
        db.prepare(
          'UPDATE purchases SET discarded_at=?,version=version+1,updated_at=?,updated_by=? WHERE id=?',
        ).run(now, now, actor.cashierId, r.id);
      } else {
        this.operation(actor, r.id, input.op);
        this.repo.recalculate(r.id);
        db.prepare(
          'UPDATE purchases SET version=version+1,updated_at=?,updated_by=? WHERE id=?',
        ).run(now, actor.cashierId, r.id);
      }
      appendAudit(db, this.deps.clock, {
        cashierId: actor.cashierId,
        action: 'PURCHASE_DRAFT_' + input.op.kind.toUpperCase(),
        entityType: 'purchase',
        entityId: r.id,
        metadata: { version: input.expectedVersion + 1 },
      });
      return this.repo.draftView(actor, r.id, this.deps.clock);
    });
  }
  private write<T>(
    actor: Session,
    command: string,
    input: { requestId: string },
    work: () => T,
  ): T {
    const { requestId, ...payload } = input;
    return withWriteTransaction(this.deps.db, () =>
      runIdempotent(
        this.deps.db,
        {
          requestId,
          command,
          payload,
          actorCashierId: actor.cashierId,
          clock: this.deps.clock,
        },
        work,
      ),
    );
  }
  private operation(
    actor: Session,
    id: string,
    op: PurchaseDraftOperation,
  ): void {
    const { db, clock, catalog } = this.deps;
    switch (op.kind) {
      case 'updateHeader': {
        const row = this.repo.find(id);
        const c = op.changes;
        const supplierId =
          c.supplierId === undefined ? row.supplier_id : c.supplierId;
        if (
          c.supplierId &&
          !new SupplierService({ db, clock }).get(actor, { id: c.supplierId })
            .isActive
        )
          throw new DomainError('SUPPLIER_INACTIVE');
        const date = c.billDate ?? row.bill_date;
        const top = c.topDays ?? Number(row.top_days);
        db.prepare(
          'UPDATE purchases SET supplier_id=?,supplier_bill_reference=?,bill_date=?,top_days=?,due_date=?,note=? WHERE id=?',
        ).run(
          supplierId,
          c.supplierBillReference === undefined
            ? row.supplier_bill_reference
            : c.supplierBillReference,
          date,
          top,
          calculateDueDate(date, top),
          c.note === undefined ? row.note : c.note,
          id,
        );
        return;
      }
      case 'addCatalogLine': {
        const item = op.barcode
          ? catalog.lookupBarcode(actor, { code: op.barcode })
          : catalog.get(actor, { id: op.catalogItemId! });
        if (!item.isActive) throw new DomainError('CATALOG_ITEM_INACTIVE');
        const old = this.repo
          .lines(id)
          .findLast(
            (l) =>
              l.catalog_item_id === item.id &&
              l.unit_price === null &&
              this.repo.stages(id, l.id).length === 0,
          );
        if (old) {
          const qty = Number(old.quantity) + (op.quantity ?? 1);
          if (qty > 1000000) throw new DomainError('INVALID_QUANTITY');
          db.prepare('UPDATE purchase_items SET quantity=? WHERE id=?').run(
            qty,
            old.id,
          );
          return;
        }
        this.insertLine(id, {
          catalogItemId: item.id,
          type: item.type,
          title: item.title,
          itemCode: item.sku,
          unitLabel: item.unitLabel,
          trackInventory: item.trackInventory,
          quantity: op.quantity ?? 1,
          unitPrice: null,
        });
        return;
      }
      case 'addCustomLine': {
        const unit = db
          .prepare('SELECT label FROM units WHERE id=? AND is_active=1')
          .get(op.unitId) as { label: string } | undefined;
        if (!unit) throw new DomainError('REFERENCE_NOT_FOUND');
        this.insertLine(id, {
          catalogItemId: null,
          type: op.type,
          title: op.title,
          itemCode: null,
          unitLabel: unit.label,
          trackInventory: false,
          quantity: op.quantity ?? 1,
          unitPrice: op.unitPrice ?? null,
        });
        return;
      }
      case 'updateLine': {
        const l = this.repo.line(id, op.lineId);
        const c = op.changes;
        db.prepare(
          'UPDATE purchase_items SET title=?,quantity=?,unit_price=? WHERE id=?',
        ).run(
          c.title ?? l.title,
          c.quantity ?? l.quantity,
          c.unitPrice === undefined
            ? l.unit_price
            : c.unitPrice === null
              ? null
              : parseRupiah(c.unitPrice),
          l.id,
        );
        return;
      }
      case 'removeLine':
        this.repo.line(id, op.lineId);
        db.prepare('UPDATE purchase_items SET removed_at=? WHERE id=?').run(
          clock.now(),
          op.lineId,
        );
        return;
      case 'setDiscounts':
        if (op.lineId) this.repo.line(id, op.lineId);
        db.prepare(
          'DELETE FROM purchase_discounts WHERE purchase_id=? AND purchase_item_id IS ?',
        ).run(id, op.lineId);
        op.stages.forEach((bps, i) =>
          db
            .prepare(
              'INSERT INTO purchase_discounts(id,purchase_id,purchase_item_id,sequence,percentage_bps) VALUES(?,?,?,?,?)',
            )
            .run(randomUUID(), id, op.lineId, i + 1, bps),
        );
        return;
      case 'setVatRate':
        db.prepare('UPDATE purchases SET vat_rate_bps=? WHERE id=?').run(
          op.vatRateBps,
          id,
        );
        return;
      case 'setPayments':
        db.prepare(
          'DELETE FROM purchase_checkout_allocations WHERE purchase_id=?',
        ).run(id);
        for (const a of op.payments)
          db.prepare(
            'INSERT INTO purchase_checkout_allocations(id,purchase_id,method,amount,reference,note) VALUES(?,?,?,?,?,?)',
          ).run(
            randomUUID(),
            id,
            a.method,
            parseRupiah(a.amount),
            a.reference,
            a.note,
          );
        return;
    }
  }
  private insertLine(
    purchaseId: string,
    l: {
      catalogItemId: string | null;
      type: string;
      title: string;
      itemCode: string | null;
      unitLabel: string;
      trackInventory: boolean;
      quantity: number;
      unitPrice: string | null;
    },
  ) {
    const position = this.repo
      .lines(purchaseId)
      .reduce((n, r) => Math.max(n, Number(r.position) + 1), 0);
    this.deps.db
      .prepare(
        'INSERT INTO purchase_items(id,purchase_id,position,catalog_item_id,type,title,item_code,unit_label,track_inventory,quantity,unit_price) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        purchaseId,
        position,
        l.catalogItemId,
        l.type,
        l.title,
        l.itemCode,
        l.unitLabel,
        l.trackInventory ? 1 : 0,
        l.quantity,
        l.unitPrice === null ? null : parseRupiah(l.unitPrice),
      );
  }
}
