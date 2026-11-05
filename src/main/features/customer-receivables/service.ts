import { OpeningImportService } from './import-service';
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
import type { PageData, RecordOpeningPaymentData } from '@/shared/contracts';
import { DomainError, parseRupiah } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { CustomerReceivablesRepository } from './repository';
export class CustomerReceivablesService {
  private readonly repo: CustomerReceivablesRepository;
  constructor(
    private readonly deps: { db: AppDatabase; clock: Clock },
    private readonly imports: OpeningImportService,
  ) {
    this.repo = new CustomerReceivablesRepository(deps.db);
  }
  previewImport(session: Session | undefined) {
    return this.imports.previewImport(session);
  }
  commitImport(session: Session | undefined, input: { token: string }) {
    return this.imports.commitImport(session, input);
  }
  list(session: Session | undefined, input: { page: PageData }) {
    requireSession(session);
    return this.deps.db.transaction(() => this.repo.list(input.page))();
  }
  get(session: Session | undefined, input: { customerId: string }) {
    requireSession(session);
    return this.deps.db.transaction(() => this.repo.get(input.customerId))();
  }
  recordPayment(session: Session | undefined, input: RecordOpeningPaymentData) {
    const actor = requireSession(session);
    const { requestId, ...payload } = input;
    return withWriteTransaction(this.deps.db, () => {
      const now = this.deps.clock.now();
      const clock = { now: () => now };
      return runIdempotent(
        this.deps.db,
        {
          requestId,
          command: 'customerReceivables.recordPayment',
          payload,
          actorCashierId: actor.cashierId,
          clock,
        },
        () => {
          const current = this.repo.get(input.customerId);
          const amount = parseRupiah(input.amount);
          if (amount <= 0n || amount > parseRupiah(current.outstandingAmount))
            throw new DomainError('PAYMENT_EXCEEDS_OUTSTANDING');
          const id = randomUUID();
          this.deps.db
            .prepare(
              `INSERT INTO customer_opening_payments(id,customer_id,method,amount,paid_at,reference,note,received_by_cashier_id,received_by_name_snapshot) VALUES (?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              input.customerId,
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
            action: 'CUSTOMER_OPENING_PAYMENT_RECORDED',
            entityType: 'customer',
            entityId: input.customerId,
            metadata: {
              paymentId: id,
              amount: input.amount,
              method: input.method,
            },
          });
          return this.repo.get(input.customerId);
        },
      );
    });
  }
}
