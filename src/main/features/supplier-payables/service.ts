import { randomUUID } from 'node:crypto';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { runIdempotent } from '@/main/database/idempotency';
import { appendAudit } from '@/main/database/audit';
import { requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import { DraftRepository } from '@/main/features/drafts/repository';
import type {
  PageData,
  RecordSupplierOpeningPaymentData,
} from '@/shared/contracts';
import { DomainError, parseRupiah } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { SupplierPayablesRepository } from './repository';
export class SupplierPayablesService {
  private readonly repo: SupplierPayablesRepository;
  constructor(private readonly deps: { db: AppDatabase; clock: Clock }) {
    this.repo = new SupplierPayablesRepository(deps.db);
  }
  list(session: Session | undefined, input: { page: PageData }) {
    requireSession(session);
    return this.deps.db.transaction(() => this.repo.list(input.page))();
  }
  get(session: Session | undefined, input: { supplierId: string }) {
    requireSession(session);
    return this.deps.db.transaction(() => this.repo.get(input.supplierId))();
  }
  recordPayment(
    session: Session | undefined,
    input: RecordSupplierOpeningPaymentData,
  ) {
    const actor = requireSession(session);
    const { requestId, ...payload } = input;
    return withWriteTransaction(this.deps.db, () => {
      const now = this.deps.clock.now();
      const clock = { now: () => now };
      return runIdempotent(
        this.deps.db,
        {
          requestId,
          command: 'supplierPayables.recordPayment',
          payload,
          actorCashierId: actor.cashierId,
          clock,
        },
        () => {
          const current = this.repo.get(input.supplierId);
          const amount = parseRupiah(input.amount);
          if (amount <= 0n || amount > parseRupiah(current.outstandingAmount))
            throw new DomainError('PAYMENT_EXCEEDS_OUTSTANDING');
          const id = randomUUID();
          this.deps.db
            .prepare(
              `INSERT INTO supplier_opening_payments(id,supplier_id,method,amount,created_at,reference,note,created_by,cashier_name_snapshot) VALUES (?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              input.supplierId,
              input.method,
              amount,
              now,
              input.reference,
              input.note,
              actor.cashierId,
              new DraftRepository(this.deps.db).cashierName(actor.cashierId),
            );
          appendAudit(this.deps.db, clock, {
            cashierId: actor.cashierId,
            action: 'SUPPLIER_OPENING_PAYMENT_RECORDED',
            entityType: 'supplier',
            entityId: input.supplierId,
            metadata: {
              paymentId: id,
              amount: input.amount,
              method: input.method,
            },
          });
          return this.repo.get(input.supplierId);
        },
      );
    });
  }
}
