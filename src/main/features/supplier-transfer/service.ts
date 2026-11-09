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
  type CommitSupplierImportInput,
  type SupplierImportPreviewDto,
  type SupplierImportSummaryDto,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import {
  supplierIssue,
  planSupplierImport,
  type SupplierImportPlan,
} from './planner';
import { SupplierTransferRepository } from './repository';
interface Pending {
  session: Session;
  cashierId: string;
  fileName: string;
  fingerprint: string;
  plan: SupplierImportPlan;
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
const COMMAND = 'supplierTransfer.commitImport';
export class SupplierTransferService {
  private readonly repo: SupplierTransferRepository;
  private readonly tokens = new PreviewTokenStore<Pending>(
    IMPORT_PREVIEW_TTL_MS,
  );
  private readonly inFlight = new Map<
    string,
    {
      session: Session;
      cashierId: string;
      promise: Promise<SupplierImportSummaryDto>;
    }
  >();
  constructor(private readonly deps: Deps) {
    this.repo = new SupplierTransferRepository(deps.db);
  }
  private actor(session: Session | undefined): Session {
    const actor = requireAdmin(session);
    const current = requireAdmin(this.deps.sessions.get(actor.windowId));
    if (current !== actor) throw new DomainError('UNAUTHENTICATED');
    return current;
  }
  async previewImport(
    session: Session | undefined,
  ): Promise<SupplierImportPreviewDto> {
    this.actor(session);
    const file = await this.deps.dialogs.chooseCsvFile();
    if (file === null) return { outcome: 'CANCELLED' };
    let plan: SupplierImportPlan;
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
        summary: {
          suppliers: { creates: 0, updates: 0, unchanged: 0 },
          openings: { creates: 0, unchanged: 0, skipped: 0 },
        },
        totalOpeningAmount: '0',
        errors: [
          supplierIssue(
            readError ?? (!parsed.ok ? parsed.code : 'FILE_UNREADABLE'),
          ),
        ],
        warnings: [],
      };
    } else plan = planSupplierImport(parsed.records, this.repo);
    const token = (this.deps.newId ?? randomUUID)();
    const now = Date.parse(this.deps.clock.now());
    const pending: Pending = {
      session: actor,
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
      totalOpeningAmount: plan.totalOpeningAmount,
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
    input: CommitSupplierImportInput,
  ): Promise<SupplierImportSummaryDto> {
    try {
      const actor = this.actor(session);
      const running = this.inFlight.get(input.token);
      if (running) {
        if (running.session !== actor)
          throw new DomainError('IMPORT_PREVIEW_EXPIRED');
        return running.promise;
      }
      const pending = this.tokens.get(
        input.token,
        Date.parse(this.deps.clock.now()),
      );
      if (!pending)
        return Promise.resolve(this.replay(input.token, actor.cashierId));
      this.checkPending(pending, actor);
      if (pending.plan.errors.length)
        throw new DomainError('IMPORT_HAS_ERRORS');
      if (
        pending.plan.warnings.some((x) => x.error.code === 'DUPLICATE_PHONE') &&
        !input.acknowledgeDuplicatePhones
      )
        throw new DomainError('SUPPLIER_IMPORT_DUPLICATE_PHONES');
      const promise = this.commit(session, input.token, pending).finally(() =>
        this.inFlight.delete(input.token),
      );
      this.inFlight.set(input.token, {
        session: actor,
        cashierId: actor.cashierId,
        promise,
      });
      return promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private checkPending(pending: Pending, actor: Session) {
    if (
      pending.session !== actor ||
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
  ): Promise<SupplierImportSummaryDto> {
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
      this.checkPending(pending, actor);
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
            const id = item.existing?.id ?? (this.deps.newId ?? randomUUID)();
            const f = item.fields;
            if (item.dto.action !== 'UNCHANGED') {
              if (item.existing)
                this.deps.db
                  .prepare(
                    'UPDATE suppliers SET name=?,phone_number=?,normalized_phone=?,email=?,address=?,is_active=?,version=version+1,updated_at=? WHERE id=?',
                  )
                  .run(
                    f.name,
                    f.phoneNumber,
                    normalizePhone(f.phoneNumber ?? ''),
                    f.email,
                    f.address,
                    f.isActive ? 1 : 0,
                    at,
                    id,
                  );
              else
                this.deps.db
                  .prepare(
                    'INSERT INTO suppliers(id,external_id,name,phone_number,normalized_phone,email,address,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
                  )
                  .run(
                    id,
                    item.externalId,
                    f.name,
                    f.phoneNumber,
                    normalizePhone(f.phoneNumber ?? ''),
                    f.email,
                    f.address,
                    f.isActive ? 1 : 0,
                    at,
                    at,
                  );
            }
            if (item.opening)
              this.deps.db
                .prepare(
                  'INSERT INTO supplier_opening_balances(supplier_id,as_of_date,amount,created_at,imported_by_cashier_id) VALUES(?,?,?,?,?)',
                )
                .run(
                  id,
                  item.opening.date,
                  BigInt(item.opening.amount),
                  at,
                  actor.cashierId,
                );
          }
          appendAudit(this.deps.db, this.deps.clock, {
            cashierId: actor.cashierId,
            action: 'SUPPLIERS_IMPORTED',
            entityType: 'supplier_import',
            entityId: token,
            metadata: {
              ...pending.plan.summary,
              duplicatePhonesAcknowledged: pending.plan.warnings.length > 0,
            },
          });
          return {
            ...pending.plan.summary,
            totalOpeningAmount: pending.plan.totalOpeningAmount,
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
  private replay(token: string, cashierId: string): SupplierImportSummaryDto {
    const receipt = this.deps.db
      .prepare(
        'SELECT result FROM command_receipts WHERE request_id=? AND command=? AND actor_cashier_id=?',
      )
      .get(token, COMMAND, cashierId) as { result: string } | undefined;
    if (!receipt) throw new DomainError('IMPORT_PREVIEW_EXPIRED');
    return JSON.parse(receipt.result) as SupplierImportSummaryDto;
  }
}
