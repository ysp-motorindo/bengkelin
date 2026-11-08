import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { runIdempotent } from '@/main/database/idempotency';
import { appendAudit } from '@/main/database/audit';
import type { Session } from '@/main/features/auth/sessions';
import { requireSession } from '@/main/features/auth/authorize';
import { DomainError } from '@/shared/primitives';
import { businessDay, type Clock } from '@/shared/time';
import { SettingsRepository } from '@/main/features/settings/repository';
import { PurchaseRepository, type PurchaseRow } from './repository';
export interface PurchaseContext {
  db: AppDatabase;
  clock: Clock;
  repo: PurchaseRepository;
}
export function allocatePurchaseNumber(
  ctx: PurchaseContext,
  kind: 'PUR' | 'RCV' | 'PCN',
): string {
  const day = businessDay(
    ctx.clock.now(),
    new SettingsRepository(ctx.db).getShop().timezone,
  );
  const r = ctx.db
    .prepare(
      'INSERT INTO purchase_daily_counters(kind,business_date,last_sequence) VALUES(?,?,1) ON CONFLICT(kind,business_date) DO UPDATE SET last_sequence=last_sequence+1 RETURNING last_sequence',
    )
    .get(kind, day) as { last_sequence: bigint };
  return `${kind}-${day.replaceAll('-', '')}-${r.last_sequence.toString().padStart(4, '0')}`;
}
export function writePurchase<T>(
  deps: { db: AppDatabase; clock: Clock },
  session: Session | undefined,
  command: string,
  input: { requestId: string; purchaseId: string; expectedVersion: number },
  work: (ctx: PurchaseContext, actor: Session, row: PurchaseRow) => T,
): T {
  const actor = requireSession(session);
  const { requestId, ...payload } = input;
  return withWriteTransaction(deps.db, () => {
    const now = deps.clock.now();
    const clock = { now: () => now };
    const repo = new PurchaseRepository(deps.db);
    const ctx = { db: deps.db, clock, repo };
    return runIdempotent(
      deps.db,
      { requestId, command, payload, actorCashierId: actor.cashierId, clock },
      () => {
        const row = repo.find(input.purchaseId);
        if (row.discarded_at) throw new DomainError('DRAFT_DISCARDED');
        if (row.version !== BigInt(input.expectedVersion))
          throw new DomainError('DRAFT_VERSION_CONFLICT');
        const result = work(ctx, actor, row);
        appendAudit(deps.db, clock, {
          cashierId: actor.cashierId,
          action: command,
          entityType: 'purchase',
          entityId: row.id,
          metadata: { version: input.expectedVersion + 1 },
        });
        return result;
      },
    );
  });
}
export function requireIssued(row: PurchaseRow) {
  if (row.status === 'VOID') throw new DomainError('PURCHASE_VOID');
  if (row.status !== 'FINALIZED')
    throw new DomainError('PURCHASE_NOT_FINALIZED');
}
export function bumpPurchase(ctx: PurchaseContext, actor: Session, id: string) {
  ctx.db
    .prepare(
      'UPDATE purchases SET version=version+1,updated_at=?,updated_by=? WHERE id=?',
    )
    .run(ctx.clock.now(), actor.cashierId, id);
}
