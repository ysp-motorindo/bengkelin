import { randomUUID } from 'node:crypto';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { runIdempotent } from '@/main/database/idempotency';
import { toNumber } from '@/main/database/rows';
import { requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import { CustomerRepository } from '@/main/features/customers/repository';
import {
  DraftRepository,
  type InvoiceRow,
} from '@/main/features/drafts/repository';
import { SettingsRepository } from '@/main/features/settings/repository';
import { VehicleRepository } from '@/main/features/vehicles/repository';
import type {
  FinalizeData,
  FinalizePreviewDto,
  InvoiceIdInput,
  InvoicePage,
  InvoiceSearchData,
  InvoiceView,
  PreviewFinalizeInput,
  ReceivablesData,
  ReceivablesPage,
  RecordPaymentData,
  VoidInvoiceData,
} from '@/shared/contracts';
import { DomainError, formatRupiah } from '@/shared/primitives';
import { businessDay, type Clock } from '@/shared/time';
import { checkFinalization } from './checks';
import {
  finalizeDraft,
  type FinalizationContext,
  type FinalizeStep,
} from './finalization';
import { listReceivables, searchInvoices } from './history';
import { InvoiceHistoryRepository } from './history-repository';
import { recordLaterPayment } from './payments';
import { PaymentRepository } from './payments-repository';
import { InvoiceRepository } from './repository';
import { loadInvoiceView, type InvoiceViewDeps } from './view';
import { voidIssuedInvoice } from './voiding';

export { FINALIZE_STEPS, type FinalizeStep } from './finalization';

export interface InvoiceServiceDeps {
  db: AppDatabase;
  clock: Clock;
  newId?: () => string;
  /**
   * TEST ONLY (fault injection): called after each finalization write
   * boundary. Never exposed via IPC and never set by `compose.ts`.
   */
  onStep?: (step: FinalizeStep) => void;
}

/**
 * Official invoices: finalization preview, atomic finalization with checkout
 * payments, later payments, voids, history and receivables. Any signed-in
 * cashier (CASHIER or ADMIN) may use them; the acting cashier is always the
 * session's cashier.
 */
export class InvoiceService {
  private readonly ctx: FinalizationContext;
  private readonly settings: SettingsRepository;
  private readonly viewDeps: InvoiceViewDeps;
  private readonly history: InvoiceHistoryRepository;

  constructor(private readonly deps: InvoiceServiceDeps) {
    const { db } = deps;
    this.settings = new SettingsRepository(db);
    this.ctx = {
      db,
      clock: deps.clock,
      drafts: new DraftRepository(db),
      invoices: new InvoiceRepository(db),
      customers: new CustomerRepository(db),
      vehicles: new VehicleRepository(db),
      settings: this.settings,
      payments: new PaymentRepository(db),
      newId: deps.newId ?? randomUUID,
      onStep: deps.onStep,
    };
    this.viewDeps = {
      drafts: this.ctx.drafts,
      invoices: this.ctx.invoices,
      payments: this.ctx.payments,
    };
    this.history = new InvoiceHistoryRepository(db);
  }

  /**
   * Read-only: what finalization would do now. Errors block; warnings must be
   * sent back unchanged as `acknowledgedWarnings` with `expectedVersion =
   * draftVersion`.
   */
  previewFinalize(
    session: Session | undefined,
    input: PreviewFinalizeInput,
  ): FinalizePreviewDto {
    requireSession(session);
    // One consistent read snapshot (deferred transaction: no write lock).
    return this.deps.db.transaction(() => {
      const invoice = this.requireOpenDraft(input.invoiceId);
      const check = checkFinalization(this.ctx, invoice, this.today().today);
      const { calc } = check.calculation;
      return {
        invoiceId: invoice.id,
        draftVersion: toNumber(invoice.version),
        totals: {
          subtotal: formatRupiah(calc.subtotal),
          itemDiscountAmount: formatRupiah(calc.itemDiscountTotal),
          invoiceDiscountAmount: formatRupiah(calc.invoiceDiscountTotal),
          discountAmount: formatRupiah(calc.discountAmount),
          amount: formatRupiah(calc.amount),
          checkoutPaymentAmount: formatRupiah(check.allocatedAmount),
          outstandingAmount: formatRupiah(calc.amount - check.allocatedAmount),
        },
        checkoutPayments: check.allocations.map((a) => ({
          method: a.method,
          amount: formatRupiah(a.amount),
          reference: a.reference,
          note: a.note,
        })),
        paymentStatusAfterCheckout: check.paymentStatusAfterCheckout,
        errors: check.errors,
        warnings: check.warnings,
      };
    })();
  }

  /**
   * Atomic finalization (spec 26): ONE write transaction wrapping
   * `runIdempotent`. A retried requestId returns the stored InvoiceView and
   * changes nothing; a new requestId on an issued invoice is
   * INVOICE_NOT_DRAFT and never allocates another number.
   */
  finalize(session: Session | undefined, input: FinalizeData): InvoiceView {
    const actor = requireSession(session);
    const { requestId, ...payload } = input;
    return withWriteTransaction(this.deps.db, () =>
      runIdempotent(
        this.deps.db,
        {
          requestId,
          command: 'invoices.finalize',
          payload,
          actorCashierId: actor.cashierId,
          clock: this.deps.clock,
        },
        () => {
          const invoice = this.requireOpenDraft(input.invoiceId);
          if (invoice.version !== BigInt(input.expectedVersion)) {
            throw new DomainError(
              'DRAFT_VERSION_CONFLICT',
              'The draft changed since it was loaded',
            );
          }
          const { today, timezone } = this.today();
          finalizeDraft(this.ctx, invoice, input, actor, timezone, today);
          return loadInvoiceView(this.viewDeps, invoice.id)!;
        },
      ),
    );
  }

  /** An issued (FINALIZED or VOID) invoice; drafts are INVOICE_NOT_FOUND. */
  get(session: Session | undefined, input: InvoiceIdInput): InvoiceView {
    requireSession(session);
    const view = this.deps.db.transaction(() =>
      loadInvoiceView(this.viewDeps, input.invoiceId),
    )();
    if (!view) throw new DomainError('INVOICE_NOT_FOUND', 'Invoice not found');
    return view;
  }

  /**
   * A later payment (spec 22): one write transaction wrapping
   * `runIdempotent`. A retried requestId returns the stored InvoiceView and
   * adds nothing.
   */
  recordPayment(
    session: Session | undefined,
    input: RecordPaymentData,
  ): InvoiceView {
    const actor = requireSession(session);
    return this.idempotent('invoices.recordPayment', actor, input, () => {
      recordLaterPayment(this.ctx, input, actor);
      return loadInvoiceView(this.viewDeps, input.invoiceId)!;
    });
  }

  /**
   * Voids an unpaid invoice (spec 29): stock reversals, VOID marking and the
   * audit row in one write transaction. A retried requestId replays; a new
   * one on a VOID invoice is INVOICE_ALREADY_VOID.
   */
  void(session: Session | undefined, input: VoidInvoiceData): InvoiceView {
    const actor = requireSession(session);
    if (input.reason.trim() === '') {
      throw new DomainError('VOID_REASON_REQUIRED', 'A void needs a reason');
    }
    return this.idempotent('invoices.void', actor, input, () => {
      voidIssuedInvoice(this.ctx, input, actor);
      return loadInvoiceView(this.viewDeps, input.invoiceId)!;
    });
  }

  /** History (spec 34): FINALIZED and VOID invoices matched on snapshots. */
  search(session: Session | undefined, input: InvoiceSearchData): InvoicePage {
    requireSession(session);
    return this.deps.db.transaction(() =>
      searchInvoices(this.history, input),
    )();
  }

  /** Outstanding or overdue FINALIZED invoices (VOID excluded). */
  receivables(
    session: Session | undefined,
    input: ReceivablesData,
  ): ReceivablesPage {
    requireSession(session);
    const { today } = this.today();
    return this.deps.db.transaction(() =>
      listReceivables(this.history, input.kind, today, input.page),
    )();
  }

  // ---- internals ----

  private idempotent<T>(
    command: string,
    actor: Session,
    input: { requestId: string },
    work: () => T,
  ): T {
    const { requestId, ...payload } = input;
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

  /** The finalization business day in the shop timezone. */
  private today(): { today: string; timezone: string } {
    const { timezone } = this.settings.getShop();
    return { today: businessDay(this.deps.clock.now(), timezone), timezone };
  }

  private requireOpenDraft(id: string): InvoiceRow {
    const invoice = this.ctx.drafts.findInvoice(id);
    if (!invoice) throw new DomainError('DRAFT_NOT_FOUND', 'Draft not found');
    if (invoice.discarded_at !== null) {
      throw new DomainError('DRAFT_DISCARDED', 'The draft was discarded');
    }
    if (invoice.status !== 'DRAFT') {
      throw new DomainError('INVOICE_NOT_DRAFT', 'The invoice is not a draft');
    }
    return invoice;
  }
}
