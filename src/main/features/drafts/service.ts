import { randomUUID } from 'node:crypto';
import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { runIdempotent } from '@/main/database/idempotency';
import { toNumber } from '@/main/database/rows';
import { AdHocReferenceRepository } from '@/main/features/ad-hoc-references/repository';
import { requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import { CatalogRepository } from '@/main/features/catalog/repository';
import { stockOf } from '@/main/features/inventory/ledger';
import type { CatalogService } from '@/main/features/catalog/service';
import { CustomerRepository } from '@/main/features/customers/repository';
import { calculateDueDate } from '@/main/features/invoices/domain';
import { VehicleRepository } from '@/main/features/vehicles/repository';
import type {
  PreviewCatalogPriceInput,
  CatalogPricePreviewDto,
  CreateDraftInput,
  DraftCommandData,
  DraftSummary,
  DraftView,
  PreviewPriceRefreshInput,
  PriceRefreshPreviewDto,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { requireActiveChannel, type OperationContext } from './context';
import { runOperation } from './operations';
import { priceRefreshProposals } from './price-refresh';
import { DraftRepository, type InvoiceRow } from './repository';
import { recalculateDraft } from './totals';
import { buildDraftView, toDraftSummary, type ViewDeps } from './view';

export interface DraftServiceDeps {
  db: AppDatabase;
  clock: Clock;
  catalog: CatalogService;
  newId?: () => string;
}

/**
 * Shared, durable transaction drafts (spec 15-20, 27, 28; Part A).
 *
 * Any signed-in cashier may create, read, edit and discard any draft.
 * Every mutating command:
 *  1. runs in ONE write transaction through `runIdempotent` (a retried
 *     requestId replays the stored result and changes nothing);
 *  2. refuses a missing (DRAFT_NOT_FOUND), discarded (DRAFT_DISCARDED) or
 *     non-draft (INVOICE_NOT_DRAFT) invoice, then a stale expectedVersion
 *     (DRAFT_VERSION_CONFLICT), so a delayed command never overwrites newer
 *     state and a discarded draft never comes back;
 *  3. applies the operation, recomputes and persists the authoritative totals
 *     with the shared calculation, increments `version`, records the editor
 *     and time, and returns the new DraftView (JSON-safe, money as strings).
 * Drafts never allocate invoice numbers, record payments, or
 * move stock.
 */
export class DraftService {
  private readonly repo: DraftRepository;
  private readonly viewDeps: ViewDeps;
  private readonly adHoc: AdHocReferenceRepository;
  private readonly newId: () => string;

  constructor(private readonly deps: DraftServiceDeps) {
    this.repo = new DraftRepository(deps.db);
    this.adHoc = new AdHocReferenceRepository(deps.db);
    this.newId = deps.newId ?? randomUUID;
    const catalog = new CatalogRepository(deps.db);
    this.viewDeps = {
      itemDetails: (id) => {
        const item = catalog.find(id);
        return {
          itemCode: item?.sku ?? null,
          currentStock: item?.trackInventory ? stockOf(deps.db, id) : null,
        };
      },
      repo: this.repo,
      customers: new CustomerRepository(deps.db),
      vehicles: new VehicleRepository(deps.db),
      resolvePrice: (itemId, channelId, pricingAt) =>
        deps.catalog.resolvePrice(itemId, channelId, pricingAt),
    };
  }

  create(session: Session | undefined, input: CreateDraftInput): DraftView {
    const actor = requireSession(session);
    const { requestId, ...payload } = input;
    return this.transaction(actor, 'drafts.create', requestId, payload, () => {
      requireActiveChannel(this.repo, input.channelId);
      const id = this.newId();
      this.repo.insertDraft({
        id,
        header: {
          channelId: input.channelId,
          invoiceDate: input.invoiceDate,
          pricingAt: input.pricingAt,
          salesId: null,
          expeditionId: null,
          customerId: null,
          vehicleId: null,
          odometerKm: null,
          topDays: 0,
          dueDate: calculateDueDate(input.invoiceDate, 0),
          note: null,
        },
        cashierId: actor.cashierId,
        now: this.deps.clock.now(),
      });
      this.repo.saveCashReceived(id, 0n);
      return this.view(id);
    });
  }

  /** Open drafts (not discarded), most recently edited first. */
  list(session: Session | undefined): DraftSummary[] {
    requireSession(session);
    return this.repo.listOpenDrafts().map(toDraftSummary);
  }

  get(session: Session | undefined, id: string): DraftView {
    requireSession(session);
    return buildDraftView(this.viewDeps, this.requireOpen(id));
  }

  apply(session: Session | undefined, input: DraftCommandData): DraftView {
    const actor = requireSession(session);
    const { requestId, ...payload } = input;
    return this.transaction(actor, 'drafts.apply', requestId, payload, () => {
      const invoice = this.requireOpen(input.invoiceId);
      const expected = BigInt(input.expectedVersion);
      if (invoice.version !== expected) {
        throw new DomainError(
          'DRAFT_VERSION_CONFLICT',
          'The draft changed since it was loaded',
        );
      }
      const now = this.deps.clock.now();
      const audit = (action: string, metadata: Record<string, unknown>) =>
        appendAudit(this.deps.db, this.deps.clock, {
          cashierId: actor.cashierId,
          action,
          entityType: 'invoice',
          entityId: invoice.id,
          metadata: { invoiceId: invoice.id, ...metadata },
        });

      if (input.op.kind === 'discard') {
        this.mustSucceed(
          this.repo.discard(invoice.id, expected, actor.cashierId, now),
        );
        audit('DRAFT_DISCARDED', {
          version: toNumber(invoice.version) + 1,
          lineCount: this.repo.liveLines(invoice.id).length,
          amount: invoice.amount.toString(),
        });
        return this.view(invoice.id);
      }

      const ctx: OperationContext = {
        repo: this.repo,
        adHoc: this.adHoc,
        customers: this.viewDeps.customers,
        vehicles: this.viewDeps.vehicles,
        catalog: this.deps.catalog,
        actor,
        invoice,
        now,
        newId: this.newId,
        audit,
      };
      runOperation(ctx, input.op);
      recalculateDraft(this.repo, invoice.id);
      const recalculated = this.repo.findInvoice(invoice.id)!;
      if (recalculated.cash_received !== null) {
        const applied =
          recalculated.cash_received < recalculated.amount
            ? recalculated.cash_received
            : recalculated.amount;
        this.repo.replaceAllocations(
          invoice.id,
          applied > 0n
            ? [{ method: 'CASH', amount: applied, reference: null, note: null }]
            : [],
          this.newId,
        );
      }
      this.mustSucceed(
        this.repo.bumpVersion(invoice.id, expected, actor.cashierId, now),
      );
      return this.view(invoice.id);
    });
  }

  /**
   * Read-only proposals at the draft's current channel and pricingAt. Send
   * the selected ones back with `applyPriceRefresh` and `expectedVersion =
   * version`.
   */
  previewCatalogPrice(
    session: Session | undefined,
    input: PreviewCatalogPriceInput,
  ): CatalogPricePreviewDto {
    requireSession(session);
    const invoice = this.requireOpen(input.invoiceId);
    const item = this.deps.catalog.get(session, { id: input.catalogItemId });
    if (!item.isActive)
      throw new DomainError('CATALOG_ITEM_INACTIVE', 'Item is inactive');
    const resolved = this.deps.catalog.resolvePrice(
      item.id,
      invoice.channel_id,
      invoice.pricing_at,
    );
    return {
      invoiceId: invoice.id,
      version: toNumber(invoice.version),
      catalogItemId: item.id,
      channelId: invoice.channel_id,
      pricingAt: invoice.pricing_at,
      resolvedPriceId: resolved?.priceId ?? null,
      unitPrice: resolved?.price ?? '0',
    };
  }

  previewPriceRefresh(
    session: Session | undefined,
    input: PreviewPriceRefreshInput,
  ): PriceRefreshPreviewDto {
    requireSession(session);
    const invoice = this.requireOpen(input.invoiceId);
    return {
      invoiceId: invoice.id,
      version: toNumber(invoice.version),
      channelId: invoice.channel_id,
      pricingAt: invoice.pricing_at,
      proposals: priceRefreshProposals(
        this.repo,
        this.viewDeps.resolvePrice,
        invoice,
      ),
    };
  }

  // ---- internals ----

  private transaction<T>(
    actor: Session,
    command: string,
    requestId: string,
    payload: unknown,
    work: () => T,
  ): T {
    return withWriteTransaction(this.deps.db, () =>
      runIdempotent(
        this.deps.db,
        {
          requestId,
          command,
          payload,
          actorCashierId: actor.cashierId,
          clock: this.deps.clock,
        },
        work,
      ),
    );
  }

  private requireOpen(id: string): InvoiceRow {
    const invoice = this.repo.findInvoice(id);
    if (!invoice) throw new DomainError('DRAFT_NOT_FOUND', 'Draft not found');
    if (invoice.discarded_at !== null) {
      throw new DomainError('DRAFT_DISCARDED', 'The draft was discarded');
    }
    if (invoice.status !== 'DRAFT') {
      throw new DomainError('INVOICE_NOT_DRAFT', 'The invoice is not a draft');
    }
    return invoice;
  }

  /** The guarded UPDATE matched nothing: someone else won the race. */
  private mustSucceed(updated: boolean): void {
    if (!updated) {
      throw new DomainError(
        'DRAFT_VERSION_CONFLICT',
        'The draft changed since it was loaded',
      );
    }
  }

  private view(id: string): DraftView {
    return buildDraftView(this.viewDeps, this.repo.findInvoice(id)!);
  }
}
