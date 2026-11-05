import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { appendAudit } from '@/main/database/audit';
import { runIdempotent } from '@/main/database/idempotency';
import { requireAdmin } from '@/main/features/auth/authorize';
import type { Session, SessionStore } from '@/main/features/auth/sessions';
import type { BackupService } from '@/main/features/backups/service';
import type { FileDialogs } from '@/main/features/printing/driver';
import { readCsv } from '@/main/features/catalog-transfer/reader';
import { PreviewTokenStore } from '@/main/features/catalog-transfer/tokens';
import {
  IMPORT_PREVIEW_TTL_MS,
  MAX_IMPORT_BYTES,
} from '@/main/features/catalog-transfer/service';
import type { Logger } from '@/main/platform/logger';
import {
  IMPORT_ROWS_SHOWN,
  IMPORT_ISSUES_SHOWN,
  type CommitOpeningImportInput,
  type OpeningImportPreview,
  type OpeningImportSummary,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { customerIssue } from '@/main/features/customer-transfer/planner';
import { planOpeningImport } from './import-planner';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@/main/database/idempotency';
interface Pending {
  cashierId: string;
  fileName: string;
  fingerprint: string;
  plan: ReturnType<typeof planOpeningImport>;
  expiresAt: number;
}
interface Deps {
  db: AppDatabase;
  clock: Clock;
  dialogs: FileDialogs;
  backups: Pick<BackupService, 'createValidatedBackup'>;
  logger: Logger;
  sessions: SessionStore;
  newId?: () => string;
}
const COMMAND = 'customerReceivables.commitImport';
export class OpeningImportService {
  private readonly tokens = new PreviewTokenStore<Pending>(
    IMPORT_PREVIEW_TTL_MS,
  );
  private readonly inFlight = new Map<
    string,
    { cashierId: string; promise: Promise<OpeningImportSummary> }
  >();
  constructor(private readonly deps: Deps) {}
  private actor(session: Session | undefined): Session {
    const actor = requireAdmin(session);
    const current = requireAdmin(this.deps.sessions.get(actor.windowId));
    if (current.cashierId !== actor.cashierId)
      throw new DomainError('UNAUTHENTICATED');
    return current;
  }
  async previewImport(
    session: Session | undefined,
  ): Promise<OpeningImportPreview> {
    this.actor(session);
    const file = await this.deps.dialogs.chooseCsvFile();
    if (file === null) return { outcome: 'CANCELLED' };
    let plan: ReturnType<typeof planOpeningImport>;
    let readError: string | null = null;
    let bytes: Uint8Array = new Uint8Array();
    try {
      const handle = await fs.open(file, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) readError = 'FILE_UNREADABLE';
        else if (stat.size > MAX_IMPORT_BYTES) readError = 'FILE_TOO_LARGE';
        else {
          const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1);
          let used = 0;
          while (used < buffer.length) {
            const { bytesRead } = await handle.read(
              buffer,
              used,
              buffer.length - used,
              null,
            );
            if (!bytesRead) break;
            used += bytesRead;
          }
          if (used > MAX_IMPORT_BYTES) readError = 'FILE_TOO_LARGE';
          else bytes = buffer.subarray(0, used);
        }
      } finally {
        await handle.close();
      }
    } catch {
      readError = 'FILE_UNREADABLE';
    }
    const actor = this.actor(session);
    const parsed = readCsv(bytes);
    if (readError || !parsed.ok) {
      plan = {
        rows: [],
        summary: { creates: 0, unchanged: 0 },
        totalAmount: '0',
        errors: [
          customerIssue(
            readError ?? (!parsed.ok ? parsed.code : 'FILE_UNREADABLE'),
          ),
        ],
      };
    } else plan = planOpeningImport(parsed.records, this.deps.db);
    const token = (this.deps.newId ?? randomUUID)();
    const now = Date.parse(this.deps.clock.now());
    const pending: Pending = {
      cashierId: actor.cashierId,
      fileName: path.basename(file),
      fingerprint: this.fingerprint(),
      plan,
      expiresAt: now + IMPORT_PREVIEW_TTL_MS,
    };
    this.tokens.put(token, pending, now);
    return {
      outcome: 'READY',
      token,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      fileName: pending.fileName,
      summary: plan.summary,
      totalAmount: plan.totalAmount,
      totalRows: plan.rows.length,
      rows: plan.rows.slice(0, IMPORT_ROWS_SHOWN),
      rowsTruncated: plan.rows.length > IMPORT_ROWS_SHOWN,
      errors: plan.errors.slice(0, IMPORT_ISSUES_SHOWN),
      errorCount: plan.errors.length,
      canCommit: plan.errors.length === 0,
    };
  }
  commitImport(
    session: Session | undefined,
    input: CommitOpeningImportInput,
  ): Promise<OpeningImportSummary> {
    try {
      const actor = this.actor(session);
      const running = this.inFlight.get(input.token);
      if (running) {
        if (running.cashierId !== actor.cashierId)
          throw new DomainError('IMPORT_PREVIEW_EXPIRED');
        return running.promise;
      }
      const pending = this.tokens.get(
        input.token,
        Date.parse(this.deps.clock.now()),
      );
      if (!pending)
        return Promise.resolve(this.replay(input.token, actor.cashierId));
      this.checkPending(pending, actor.cashierId);
      if (pending.plan.errors.length)
        throw new DomainError('IMPORT_HAS_ERRORS');
      const promise = this.commit(session, input.token, pending).finally(() =>
        this.inFlight.delete(input.token),
      );
      this.inFlight.set(input.token, { cashierId: actor.cashierId, promise });
      return promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private checkPending(pending: Pending, cashierId: string) {
    if (
      pending.cashierId !== cashierId ||
      Date.parse(this.deps.clock.now()) >= pending.expiresAt
    )
      throw new DomainError('IMPORT_PREVIEW_EXPIRED');
    if (this.fingerprint() !== pending.fingerprint)
      throw new DomainError('IMPORT_PREVIEW_STALE');
  }
  private async commit(
    session: Session | undefined,
    token: string,
    pending: Pending,
  ): Promise<OpeningImportSummary> {
    let backup;
    try {
      backup = await this.deps.backups.createValidatedBackup({
        kind: 'SAFETY',
      });
    } catch {
      throw new DomainError('IMPORT_BACKUP_FAILED');
    }
    const actor = this.actor(session);
    const summary = withWriteTransaction(this.deps.db, () => {
      this.checkPending(pending, actor.cashierId);
      return runIdempotent(
        this.deps.db,
        {
          requestId: token,
          command: COMMAND,
          payload: { cashierId: actor.cashierId },
          actorCashierId: actor.cashierId,
          clock: this.deps.clock,
        },
        () => {
          const at = this.deps.clock.now();
          for (const row of pending.plan.rows) {
            if (row.action !== 'CREATE') continue;
            this.deps.db
              .prepare(
                'INSERT INTO customer_opening_balances(customer_id,as_of_date,amount,created_at,imported_by_cashier_id) VALUES (?,?,?,?,?)',
              )
              .run(
                row.customerId,
                row.asOfDate,
                BigInt(row.amount!),
                at,
                actor.cashierId,
              );
          }
          appendAudit(this.deps.db, this.deps.clock, {
            cashierId: actor.cashierId,
            action: 'CUSTOMER_OPENINGS_IMPORTED',
            entityType: 'customer_opening_import',
            entityId: token,
            metadata: {
              ...pending.plan.summary,
              totalAmount: pending.plan.totalAmount,
            },
          });
          return {
            ...pending.plan.summary,
            totalAmount: pending.plan.totalAmount,
            importedAt: at,
            fileName: pending.fileName,
            backupFileName: backup.fileName,
          };
        },
      );
    });
    this.tokens.delete(token);
    return summary;
  }
  private fingerprint(): string {
    return createHash('sha256')
      .update(
        canonicalJson([
          this.deps.db.prepare('SELECT * FROM customers ORDER BY id').all(),
          this.deps.db
            .prepare(
              'SELECT * FROM customer_opening_balances ORDER BY customer_id',
            )
            .all(),
        ])!,
      )
      .digest('hex');
  }
  private replay(token: string, cashierId: string): OpeningImportSummary {
    const receipt = this.deps.db
      .prepare(
        'SELECT result FROM command_receipts WHERE request_id=? AND command=? AND actor_cashier_id=?',
      )
      .get(token, COMMAND, cashierId) as { result: string } | undefined;
    if (!receipt) throw new DomainError('IMPORT_PREVIEW_EXPIRED');
    return JSON.parse(receipt.result) as OpeningImportSummary;
  }
}
