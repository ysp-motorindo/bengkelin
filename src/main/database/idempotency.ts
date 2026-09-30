import type { Clock } from '@/shared/time';
import type { AppDatabase } from './connection';
import { DatabaseError } from './errors';

export type IdempotentCommand = {
  requestId: string;
  command: string;
  actorCashierId?: string | null;
  clock: Clock;
};

/**
 * Durable command idempotency. MUST be called inside `withWriteTransaction`,
 * so the receipt commits atomically with the command's effects.
 *
 * - Known requestId + same command: returns the stored result, `work` is not run.
 * - Known requestId + different command: throws IDEMPOTENCY_KEY_REUSED.
 * - Otherwise runs `work`, stores its JSON result and returns it. If `work`
 *   throws, nothing is recorded (the enclosing transaction rolls back).
 *
 * The result must be JSON-serializable (no bigint: use Rupiah strings as on
 * the IPC boundary); `undefined` is stored and replayed as `null`.
 */
export function runIdempotent<T>(
  db: AppDatabase,
  { requestId, command, actorCashierId = null, clock }: IdempotentCommand,
  work: () => T,
): T {
  if (!db.inTransaction) {
    throw new DatabaseError(
      'NOT_IN_TRANSACTION',
      'runIdempotent must run inside withWriteTransaction',
    );
  }
  const existing = db
    .prepare(
      'SELECT command, result FROM command_receipts WHERE request_id = ?',
    )
    .get(requestId) as { command: string; result: string } | undefined;
  if (existing) {
    if (existing.command !== command) {
      throw new DatabaseError(
        'IDEMPOTENCY_KEY_REUSED',
        `Request ${requestId} was already used for ${existing.command}`,
      );
    }
    return JSON.parse(existing.result) as T;
  }
  const result = work();
  db.prepare(
    `INSERT INTO command_receipts (request_id, command, result, created_at, actor_cashier_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    requestId,
    command,
    JSON.stringify(result ?? null),
    clock.now(),
    actorCashierId,
  );
  return (result ?? null) as T;
}
