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
import { normalizePhone } from '@/main/features/vehicles/normalization';
import type { Logger } from '@/main/platform/logger';
import {
  IMPORT_ROWS_SHOWN,
  IMPORT_ISSUES_SHOWN,
  type CommitCustomerImportInput,
  type CustomerImportPreviewDto,
  type CustomerImportSummaryDto,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import {
  customerIssue,
  planCustomerImport,
  type CustomerImportPlan,
} from './planner';
import { CustomerTransferRepository } from './repository';
interface Pending {
  cashierId: string;
  fileName: string;
  fingerprint: string;
  plan: CustomerImportPlan;
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
const COMMAND = 'customerTransfer.commitImport';
export class CustomerTransferService {
  private readonly repo: CustomerTransferRepository;
  private readonly tokens = new PreviewTokenStore<Pending>(
    IMPORT_PREVIEW_TTL_MS,
  );
  private readonly inFlight = new Map<
    string,
    { cashierId: string; promise: Promise<CustomerImportSummaryDto> }
  >();
  constructor(private readonly deps: Deps) {
    this.repo = new CustomerTransferRepository(deps.db);
  }
  private actor(session: Session | undefined): Session {
    const actor = requireAdmin(session);
    const current = requireAdmin(this.deps.sessions.get(actor.windowId));
    if (current.cashierId !== actor.cashierId)
      throw new DomainError('UNAUTHENTICATED');
    return current;
  }
  async previewImport(
    session: Session | undefined,
  ): Promise<CustomerImportPreviewDto> {
    this.actor(session);
    const file = await this.deps.dialogs.chooseCsvFile();
    if (file === null) return { outcome: 'CANCELLED' };
    let plan: CustomerImportPlan;
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
        items: [],
        rows: [],
        summary: { creates: 0, updates: 0, unchanged: 0 },
        errors: [
          customerIssue(
            readError ?? (!parsed.ok ? parsed.code : 'FILE_UNREADABLE'),
          ),
        ],
        warnings: [],
      };
    } else plan = planCustomerImport(parsed.records, this.repo);
    const token = (this.deps.newId ?? randomUUID)();
    const now = Date.parse(this.deps.clock.now());
    const pending: Pending = {
      cashierId: actor.cashierId,
      fileName: path.basename(file),
      fingerprint: this.repo.fingerprint(),
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
      totalRows: plan.rows.length,
      rows: plan.rows.slice(0, IMPORT_ROWS_SHOWN),
      rowsTruncated: plan.rows.length > IMPORT_ROWS_SHOWN,
      errors: plan.errors.slice(0, IMPORT_ISSUES_SHOWN),
      errorCount: plan.errors.length,
      warnings: plan.warnings.slice(0, IMPORT_ISSUES_SHOWN),
      warningCount: plan.warnings.length,
      requiresDuplicatePhoneAcknowledgement: plan.warnings.some(
        (x) => x.error.code === 'DUPLICATE_PHONE',
      ),
      canCommit: plan.errors.length === 0,
    };
  }
  commitImport(
    session: Session | undefined,
    input: CommitCustomerImportInput,
  ): Promise<CustomerImportSummaryDto> {
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
      if (
        pending.plan.warnings.some((x) => x.error.code === 'DUPLICATE_PHONE') &&
        !input.acknowledgeDuplicatePhones
      )
        throw new DomainError('CUSTOMER_IMPORT_DUPLICATE_PHONES');
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
    if (this.repo.fingerprint() !== pending.fingerprint)
      throw new DomainError('IMPORT_PREVIEW_STALE');
  }
  private async commit(
    session: Session | undefined,
    token: string,
    pending: Pending,
  ): Promise<CustomerImportSummaryDto> {
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
          for (const item of pending.plan.items) {
            if (item.dto.action === 'UNCHANGED') continue;
            const id = item.existing?.id ?? (this.deps.newId ?? randomUUID)();
            const phone = normalizePhone(item.fields.phoneNumber ?? '');
            if (item.existing)
              this.repo.customers.update(id, item.fields, phone, at);
            else
              this.repo.customers.insert(
                id,
                item.fields,
                phone,
                at,
                item.externalId,
              );
          }
          appendAudit(this.deps.db, this.deps.clock, {
            cashierId: actor.cashierId,
            action: 'CUSTOMERS_IMPORTED',
            entityType: 'customer_import',
            entityId: token,
            metadata: {
              ...pending.plan.summary,
              duplicatePhonesAcknowledged: pending.plan.warnings.length > 0,
            },
          });
          return {
            ...pending.plan.summary,
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
  private replay(token: string, cashierId: string): CustomerImportSummaryDto {
    const receipt = this.deps.db
      .prepare(
        'SELECT result FROM command_receipts WHERE request_id=? AND command=? AND actor_cashier_id=?',
      )
      .get(token, COMMAND, cashierId) as { result: string } | undefined;
    if (!receipt) throw new DomainError('IMPORT_PREVIEW_EXPIRED');
    return JSON.parse(receipt.result) as CustomerImportSummaryDto;
  }
}
