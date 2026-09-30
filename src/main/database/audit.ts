import type { Clock } from '@/shared/time';
import type { AppDatabase } from './connection';

export interface AuditEntry {
  /** Acting cashier; null for unauthenticated events (failed login). */
  cashierId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  /** JSON-serializable facts. Never passwords, hashes or customer PII. */
  metadata?: Record<string, unknown>;
}

/**
 * Appends to the business audit log (spec 47). Call inside the same write
 * transaction as the change being audited so both commit or neither does.
 */
export function appendAudit(
  db: AppDatabase,
  clock: Clock,
  entry: AuditEntry,
): void {
  db.prepare(
    `INSERT INTO audit_log (cashier_id, action, entity_type, entity_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.cashierId,
    entry.action,
    entry.entityType ?? null,
    entry.entityId ?? null,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
    clock.now(),
  );
}
