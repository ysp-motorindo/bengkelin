import { createHash } from 'node:crypto';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import type { AppDatabase } from './connection';
import { DatabaseError } from './errors';

export interface IdempotentCommand {
  requestId: string;
  command: string;
  /**
   * Everything that defines the request EXCEPT `requestId` itself (ids,
   * quantities, reasons...). Its canonical hash is stored, so a retry that
   * reuses the key for a different request is refused.
   */
  payload: unknown;
  actorCashierId?: string | null;
  clock: Clock;
}

/**
 * Canonical JSON: object keys sorted (recursively), `undefined` properties
 * omitted, bigint written as its decimal string, Date as ISO text. Arrays keep
 * their order. A bigint therefore hashes like the equal string (5n and "5" are
 * the same payload); commands must not rely on telling them apart.
 */
export function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, raw: unknown) => {
    if (typeof raw === 'bigint') return raw.toString();
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      // `toJSON` (Date) has already been applied by JSON.stringify here.
      const source = raw as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) sorted[key] = source[key];
      return sorted;
    }
    return raw;
  });
}

function hashPayload(payload: unknown): string {
  let text: string | undefined;
  try {
    text = canonicalJson(payload ?? null);
  } catch (error) {
    throw new DatabaseError(
      'NON_SERIALIZABLE_PAYLOAD',
      'The request payload cannot be serialised',
      { cause: error },
    );
  }
  return createHash('sha256')
    .update(text ?? 'null')
    .digest('hex');
}

function reused(requestId: string, detail: string): DomainError {
  return new DomainError(
    'IDEMPOTENCY_KEY_REUSED',
    `Request ${requestId} was already used ${detail}`,
  );
}

/**
 * Durable command idempotency. MUST be called inside `withWriteTransaction`,
 * so the receipt commits atomically with the command's effects.
 *
 * - Known requestId + same command + same payload hash: returns the stored
 *   result; `work` is not run.
 * - Known requestId + different command or payload: throws the client error
 *   `IDEMPOTENCY_KEY_REUSED` (a `DomainError`; the IPC Result carries that code).
 * - Otherwise runs `work`, stores its result and returns it. If `work` throws,
 *   nothing is recorded (the enclosing transaction rolls back).
 * - LEGACY receipts (`payload_hash` NULL, written before migration 005):
 *   replay for the SAME command, since the original payload cannot be
 *   verified; a different command is still refused. The hash is never
 *   back-filled from a retry, because that would bless an unverified payload.
 *
 * The result is serialised ONCE and both the first run and every replay
 * return `JSON.parse` of that text, so their shapes are identical (Date ->
 * ISO string, undefined properties dropped, `undefined` -> `null`). Results
 * must be JSON-safe DTOs: a bigint anywhere raises `NON_SERIALIZABLE_RESULT`
 * (a DatabaseError, so INTERNAL_ERROR at the IPC edge: it is a programming
 * bug, not something the user can fix).
 */
export function runIdempotent<T>(
  db: AppDatabase,
  {
    requestId,
    command,
    payload,
    actorCashierId = null,
    clock,
  }: IdempotentCommand,
  work: () => T,
): T {
  if (!db.inTransaction) {
    throw new DatabaseError(
      'NOT_IN_TRANSACTION',
      'runIdempotent must run inside withWriteTransaction',
    );
  }
  const payloadHash = hashPayload(payload);
  const existing = db
    .prepare(
      'SELECT command, result, payload_hash FROM command_receipts WHERE request_id = ?',
    )
    .get(requestId) as
    | { command: string; result: string; payload_hash: string | null }
    | undefined;
  if (existing) {
    if (existing.command !== command) {
      throw reused(requestId, `for ${existing.command}`);
    }
    if (
      existing.payload_hash !== null &&
      existing.payload_hash !== payloadHash
    ) {
      throw reused(requestId, 'with a different payload');
    }
    return JSON.parse(existing.result) as T;
  }
  const result = work();
  let serialized: string;
  try {
    serialized = JSON.stringify(result ?? null);
  } catch (error) {
    throw new DatabaseError(
      'NON_SERIALIZABLE_RESULT',
      `Result of ${command} is not JSON-serialisable (bigint?)`,
      { cause: error },
    );
  }
  db.prepare(
    `INSERT INTO command_receipts (request_id, command, result, created_at, actor_cashier_id, payload_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    requestId,
    command,
    serialized,
    clock.now(),
    actorCashierId,
    payloadHash,
  );
  return JSON.parse(serialized) as T;
}
