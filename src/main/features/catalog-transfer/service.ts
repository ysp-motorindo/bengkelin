import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { runIdempotent } from '@/main/database/idempotency';
import { requireAdmin } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type { BackupService } from '@/main/features/backups/service';
import type { TrackingChangeGuard } from '@/main/features/catalog/service';
import { formatCsv, type CsvRow } from '@/main/features/csv/writer';
import type { FileDialogs } from '@/main/features/printing/driver';
import type { Logger } from '@/main/platform/logger';
import {
  IMPORT_ISSUES_SHOWN,
  IMPORT_ROWS_SHOWN,
  type BackupSummary,
  type CatalogFileOutcomeDto,
  type CommitImportInput,
  type ImportPreviewDto,
  type ImportRowDto,
  type ImportSummaryDto,
} from '@/shared/contracts';
import { DomainError, formatRupiah, type Instant } from '@/shared/primitives';
import { businessDay, type Clock } from '@/shared/time';
import { applyPlan } from './applier';
import { mapHeader } from './columns';
import { buildCatalogExport } from './export';
import { issueError, sortIssues, toIssueDto, type Issue } from './issues';
import {
  countPlan,
  planImport,
  planSignature,
  type ImportPlan,
  type ItemPlan,
} from './planner';
import { readCsv } from './reader';
import { CatalogTransferRepository } from './repository';
import { buildCatalogTemplate } from './template';
import { PreviewTokenStore } from './tokens';
import { validateRows, type CandidateRow, type RowOutline } from './validator';

/** How long an import preview can be committed. */
export const IMPORT_PREVIEW_TTL_MS = 30 * 60 * 1000;
/** Larger files are refused (FILE_TOO_LARGE) before they are read. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const COMMIT_COMMAND = 'catalogTransfer.commitImport';
export const TEMPLATE_FILE_NAME = 'template-katalog.csv';

export interface CatalogTransferServiceDeps {
  db: AppDatabase;
  clock: Clock;
  dialogs: FileDialogs;
  /** T14: the SAFETY backup taken before every import. */
  backups: Pick<BackupService, 'createValidatedBackup'>;
  /** T7's rule: tracking cannot change once stock has moved. */
  trackingChangeGuard: TrackingChangeGuard;
  logger: Logger;
  newId?: () => string;
}

/** What a preview token stands for. */
interface PendingImport {
  cashierId: string;
  fileName: string;
  contentHash: string;
  candidates: CandidateRow[];
  affectedItemIds: string[];
  fingerprint: string;
  signature: string;
  errorCount: number;
}

interface Analysis {
  issues: Issue[];
  candidates: CandidateRow[];
  outlines: RowOutline[];
  invalidRows: Set<number>;
  plan: ImportPlan;
  fingerprint: string;
}

type LoadedFile = { bytes: Uint8Array } | { issue: Issue };

/**
 * Catalog CSV transfer (spec 37-41, 55; Part A review focus 4). ADMIN only.
 *
 * Import: native open dialog in main -> strict parse -> validate -> plan ->
 * preview (token bound to the file's hash and a fingerprint of the catalog
 * state) -> commit. The commit re-checks the token and fingerprint, takes a
 * SAFETY backup OUTSIDE any transaction (a failure aborts with
 * IMPORT_BACKUP_FAILED and changes nothing), then re-validates, applies and
 * audits in ONE write transaction. It is idempotent by token.
 */
export class CatalogTransferService {
  private readonly repo: CatalogTransferRepository;
  private readonly newId: () => string;
  private readonly tokens = new PreviewTokenStore<PendingImport>(
    IMPORT_PREVIEW_TTL_MS,
  );
  private readonly inFlight = new Map<string, Promise<ImportSummaryDto>>();

  constructor(private readonly deps: CatalogTransferServiceDeps) {
    this.repo = new CatalogTransferRepository(deps.db);
    this.newId = deps.newId ?? randomUUID;
  }

  // ---- import ----

  async previewImport(session: Session | undefined): Promise<ImportPreviewDto> {
    requireAdmin(session);
    const file = await this.deps.dialogs.chooseCsvFile();
    if (file === null) return { outcome: 'CANCELLED' };
    const loaded = await this.load(file);
    // The dialog and the read awaited: re-check the role.
    const actor = requireAdmin(session);

    const now = this.deps.clock.now();
    const bytes = 'bytes' in loaded ? loaded.bytes : new Uint8Array();
    const analysis = this.analyze(loaded, now);
    const errorCount = analysis.issues.filter(
      (i) => i.severity === 'error',
    ).length;
    const token = this.newId();
    const fileName = path.basename(file);
    const expiresAtMs = this.tokens.put(
      token,
      {
        cashierId: actor.cashierId,
        fileName,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        candidates: analysis.candidates,
        affectedItemIds: analysis.plan.affectedItemIds,
        fingerprint: analysis.fingerprint,
        signature: planSignature(analysis.plan.items),
        errorCount,
      },
      Date.parse(now),
    );

    const errors = analysis.issues.filter((i) => i.severity === 'error');
    const warnings = analysis.issues.filter((i) => i.severity === 'warning');
    const rows = toRowDtos(analysis);
    return {
      outcome: 'READY',
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      fileName,
      summary: countPlan(analysis.plan.items),
      totalRows: rows.length,
      rows: rows.slice(0, IMPORT_ROWS_SHOWN),
      rowsTruncated: rows.length > IMPORT_ROWS_SHOWN,
      errors: errors.slice(0, IMPORT_ISSUES_SHOWN).map(toIssueDto),
      errorCount,
      warnings: warnings.slice(0, IMPORT_ISSUES_SHOWN).map(toIssueDto),
      warningCount: warnings.length,
      canCommit: errorCount === 0,
    };
  }

  /**
   * Commits a preview. Not `async` on purpose: the checks and the in-flight
   * registration run synchronously, so a concurrent retry of the same token
   * joins the running commit instead of starting another.
   */
  commitImport(
    session: Session | undefined,
    input: CommitImportInput,
  ): Promise<ImportSummaryDto> {
    try {
      const actor = requireAdmin(session);
      const { token } = input;
      const running = this.inFlight.get(token);
      if (running) return running;

      const nowMs = Date.parse(this.deps.clock.now());
      const pending = this.tokens.get(token, nowMs);
      if (!pending || pending.cashierId !== actor.cashierId) {
        // Consumed (a retry: return the stored summary), unknown or expired.
        return Promise.resolve(this.replay(token, actor.cashierId));
      }
      if (pending.errorCount > 0) {
        throw new DomainError('IMPORT_HAS_ERRORS', 'The file has errors');
      }
      if (
        this.repo.fingerprint(pending.affectedItemIds) !== pending.fingerprint
      ) {
        this.tokens.delete(token);
        throw stale();
      }
      const promise = this.commit(session, token, pending).finally(() => {
        this.inFlight.delete(token);
      });
      this.inFlight.set(token, promise);
      return promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // ---- export and template ----

  async exportCatalog(
    session: Session | undefined,
  ): Promise<CatalogFileOutcomeDto> {
    requireAdmin(session);
    const day = businessDay(this.deps.clock.now(), this.repo.shopTimezone());
    const target = await this.deps.dialogs.chooseCsvDestination(
      `katalog-${day.replaceAll('-', '')}.csv`,
    );
    if (target === null) return { outcome: 'CANCELLED' };
    const actor = requireAdmin(session);
    // Read after the dialog: the file is the state at the moment it is saved.
    const exported = buildCatalogExport(this.repo, this.deps.clock.now());
    if (!(await this.write(target, exported.rows))) {
      return { outcome: 'FAILED', code: 'EXPORT_FAILED' };
    }
    const fileName = path.basename(target);
    withWriteTransaction(this.deps.db, () =>
      appendAudit(this.deps.db, this.deps.clock, {
        cashierId: actor.cashierId,
        action: 'CATALOG_EXPORTED',
        entityType: 'catalog',
        metadata: {
          fileName,
          itemCount: exported.itemCount,
          skuMissingCount: exported.skuMissingCount,
        },
      }),
    );
    return {
      outcome: 'SAVED',
      fileName,
      itemCount: exported.itemCount,
      skuMissingCount: exported.skuMissingCount,
    };
  }

  async downloadTemplate(
    session: Session | undefined,
  ): Promise<CatalogFileOutcomeDto> {
    requireAdmin(session);
    const target =
      await this.deps.dialogs.chooseCsvDestination(TEMPLATE_FILE_NAME);
    if (target === null) return { outcome: 'CANCELLED' };
    requireAdmin(session);
    const rows = buildCatalogTemplate(this.repo.channels(), this.repo.units());
    if (!(await this.write(target, rows))) {
      return { outcome: 'FAILED', code: 'EXPORT_FAILED' };
    }
    return {
      outcome: 'SAVED',
      fileName: path.basename(target),
      itemCount: rows.length - 1,
      skuMissingCount: 0,
    };
  }

  // ---- internals ----

  private async commit(
    session: Session | undefined,
    token: string,
    pending: PendingImport,
  ): Promise<ImportSummaryDto> {
    let backup: BackupSummary;
    try {
      // Never inside a transaction: the backup is async and must not hold
      // the write lock; ordinary work continues meanwhile.
      backup = await this.deps.backups.createValidatedBackup({
        kind: 'SAFETY',
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      this.deps.logger.warn('catalog_import.backup_failed', {
        code: error.code,
      });
      // The token stays valid: the import can be retried once the backup
      // folder is available again (the fingerprint is checked again).
      throw new DomainError('IMPORT_BACKUP_FAILED', 'Safety backup failed', {
        backupCode: error.code,
      });
    }
    const actor = requireAdmin(session);
    // Single use from here on, whatever the outcome.
    this.tokens.delete(token);

    const { db, clock } = this.deps;
    const summary = withWriteTransaction(db, () =>
      runIdempotent(
        db,
        {
          requestId: token,
          command: COMMIT_COMMAND,
          payload: {},
          actorCashierId: actor.cashierId,
          clock,
        },
        (): ImportSummaryDto => {
          // Re-validate against the database as it is now, under the lock.
          if (
            this.repo.fingerprint(pending.affectedItemIds) !==
            pending.fingerprint
          ) {
            throw stale();
          }
          const importAt = clock.now();
          const plan = planImport(
            pending.candidates,
            this.repo,
            importAt,
            this.deps.trackingChangeGuard,
          );
          if (plan.issues.some((i) => i.severity === 'error')) {
            throw new DomainError('IMPORT_HAS_ERRORS', 'The file has errors');
          }
          if (planSignature(plan.items) !== pending.signature) throw stale();

          applyPlan(
            {
              db,
              newId: this.newId,
              cashierId: actor.cashierId,
              importAt,
              importId: token,
            },
            plan.items,
          );
          const counts = countPlan(plan.items);
          appendAudit(db, clock, {
            cashierId: actor.cashierId,
            action: 'CATALOG_IMPORTED',
            entityType: 'catalog_import',
            entityId: token,
            metadata: {
              ...counts,
              importedAt: importAt,
              fileName: pending.fileName,
              contentHash: pending.contentHash,
              backupFileName: backup.fileName,
            },
          });
          return {
            ...counts,
            importedAt: importAt,
            fileName: pending.fileName,
            backupFileName: backup.fileName,
          };
        },
      ),
    );
    this.deps.logger.info('catalog_import.committed', {
      creates: summary.creates,
      updates: summary.updates,
      priceChanges: summary.priceChanges,
    });
    return summary;
  }

  /** A retried commit: the stored summary, else IMPORT_PREVIEW_EXPIRED. */
  private replay(token: string, cashierId: string): ImportSummaryDto {
    return withWriteTransaction(this.deps.db, () =>
      runIdempotent(
        this.deps.db,
        {
          requestId: token,
          command: COMMIT_COMMAND,
          payload: {},
          actorCashierId: cashierId,
          clock: this.deps.clock,
        },
        (): ImportSummaryDto => {
          throw new DomainError(
            'IMPORT_PREVIEW_EXPIRED',
            'The preview expired; preview the file again',
          );
        },
      ),
    );
  }

  private async load(file: string): Promise<LoadedFile> {
    const tooLarge = {
      issue: issueError(
        'FILE_TOO_LARGE',
        { row: null },
        { maxMegabytes: String(MAX_IMPORT_BYTES / (1024 * 1024)) },
      ),
    };
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) {
        return { issue: issueError('FILE_UNREADABLE', { row: null }) };
      }
      if (stat.size > MAX_IMPORT_BYTES) return tooLarge;
      const bytes = await fs.readFile(file);
      if (bytes.length > MAX_IMPORT_BYTES) return tooLarge;
      return { bytes };
    } catch (error) {
      this.deps.logger.warn('catalog_import.read_failed', { error });
      return { issue: issueError('FILE_UNREADABLE', { row: null }) };
    }
  }

  /** Parse, validate and plan in one synchronous pass over the database. */
  private analyze(loaded: LoadedFile, at: Instant): Analysis {
    const issues: Issue[] = [];
    let candidates: CandidateRow[] = [];
    let outlines: RowOutline[] = [];
    const invalidRows = new Set<number>();
    let plan: ImportPlan = {
      items: [],
      invalidRows: new Set(),
      issues: [],
      affectedItemIds: [],
    };

    if ('issue' in loaded) {
      issues.push(loaded.issue);
    } else {
      const read = readCsv(loaded.bytes);
      if (!read.ok) {
        issues.push(issueError(read.code, { row: read.row }));
      } else if (read.records.length === 0) {
        issues.push(issueError('EMPTY_FILE', { row: null }));
      } else {
        const [header, ...data] = read.records as [string[], ...string[][]];
        const mapped = mapHeader(header, this.repo.channels());
        issues.push(...mapped.issues);
        if (data.length === 0) {
          issues.push(issueError('NO_DATA_ROWS', { row: null }));
        }
        // Rows are only checked against a usable header.
        if (!mapped.issues.some((i) => i.severity === 'error')) {
          const validated = validateRows(
            data,
            mapped.columns,
            this.repo.units(),
          );
          issues.push(...validated.issues);
          candidates = validated.candidates;
          outlines = validated.outlines;
          for (const row of validated.invalidRows) invalidRows.add(row);
          plan = planImport(
            candidates,
            this.repo,
            at,
            this.deps.trackingChangeGuard,
          );
          issues.push(...plan.issues);
          for (const row of plan.invalidRows) invalidRows.add(row);
        }
      }
    }
    return {
      issues: sortIssues(issues),
      candidates,
      outlines,
      invalidRows,
      plan,
      fingerprint: this.repo.fingerprint(plan.affectedItemIds),
    };
  }

  private async write(target: string, rows: CsvRow[]): Promise<boolean> {
    try {
      await fs.writeFile(target, formatCsv(rows), 'utf8');
      return true;
    } catch (error) {
      this.deps.logger.warn('catalog_transfer.write_failed', { error });
      return false;
    }
  }
}

function stale(): DomainError {
  return new DomainError(
    'IMPORT_PREVIEW_STALE',
    'The catalog changed since the preview; preview the file again',
  );
}

function toRowDtos(analysis: Analysis): ImportRowDto[] {
  const planned = new Map<number, ItemPlan>(
    analysis.plan.items.map((item) => [item.row, item]),
  );
  return analysis.outlines.map((outline): ImportRowDto => {
    const item = planned.get(outline.row);
    if (!item || analysis.invalidRows.has(outline.row)) {
      return {
        row: outline.row,
        sku: outline.sku,
        title: outline.title,
        action: 'INVALID',
        changedFields: [],
        priceChanges: [],
        barcodesAdded: [],
        barcodesActivated: [],
        openingStock: null,
      };
    }
    return {
      row: item.row,
      sku: item.sku,
      title: item.fields.title,
      action: item.action,
      changedFields: item.changedFields,
      priceChanges: item.prices.map((p) => ({
        channelCode: p.channelCode,
        from: p.from === null ? null : formatRupiah(p.from),
        to: formatRupiah(p.to),
      })),
      barcodesAdded: item.barcodesToAdd,
      barcodesActivated: item.barcodesToActivate.map((b) => b.barcode),
      openingStock: item.openingStock,
    };
  });
}
