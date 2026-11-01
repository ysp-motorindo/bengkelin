import { requireActiveStockLocation } from '@/main/features/references/stock-locations';
import { ReferenceRepository } from '@/main/features/references/repository';
import { randomUUID } from 'node:crypto';
import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { runIdempotent } from '@/main/database/idempotency';
import { requireAdmin, requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type { TrackingChangeGuard } from '@/main/features/catalog/service';
import type {
  AdjustStockInput,
  LedgerDto,
  ListStockInput,
  OpenBalanceInput,
  ReceiveStockInput,
  SetStockInput,
  StockChangeDto,
  StockDto,
  StockHistoryInput,
  StockItemInput,
  StockListDto,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import {
  hasLedgerEntries,
  insertEntry,
  requireTrackedItem,
  stockOf,
} from './ledger';
import { InventoryRepository } from './repository';

export interface InventoryServiceDeps {
  db: AppDatabase;
  clock: Clock;
  newId?: () => string;
}

const LIST_LIMIT = 100;
const HISTORY_LIMIT = 200;

/**
 * Inventory (spec 24, 25, 55). Stock is SUM(quantity_delta) over an
 * append-only ledger; nothing stores a total. Any signed-in cashier can read
 * stock; every write is ADMIN-only, idempotent by `requestId`, audited, and
 * computed inside the write transaction. Sales and void reversals are written
 * by finalization/void through `ledger.ts`, never through this service.
 */
export class InventoryService {
  private readonly repo: InventoryRepository;
  private readonly newId: () => string;

  constructor(private readonly deps: InventoryServiceDeps) {
    this.repo = new InventoryRepository(deps.db);
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * Catalog guard: once any ledger entry exists for an item, whether it tracks
   * inventory can no longer change (the schema enforces it too).
   */
  readonly trackingChangeGuard: TrackingChangeGuard = ({ itemId }) => {
    if (hasLedgerEntries(this.deps.db, itemId)) {
      throw new DomainError(
        'TRACKING_LOCKED_BY_LEDGER',
        'Inventory tracking cannot change after stock movements exist',
      );
    }
  };

  // ---- reads (any session) ----

  getStock(session: Session | undefined, input: StockItemInput): StockDto {
    requireSession(session);
    const exists = this.deps.db
      .prepare('SELECT 1 AS found FROM catalog_items WHERE id = ?')
      .get(input.catalogItemId);
    if (!exists) {
      throw new DomainError('CATALOG_ITEM_NOT_FOUND', 'Item not found');
    }
    return {
      stockLocation: this.location(input.stockLocationId),
      catalogItemId: input.catalogItemId,
      quantity: stockOf(
        this.deps.db,
        input.catalogItemId,
        input.stockLocationId,
      ),
    };
  }

  listStock(session: Session | undefined, input: ListStockInput): StockListDto {
    requireSession(session);
    return {
      stockLocation: this.location(input.stockLocationId),
      items: this.repo.listStock(
        input.stockLocationId,
        (input.query ?? '').trim(),
        input.negativeOnly === true,
        Math.min(input.limit ?? LIST_LIMIT, 200),
      ),
    };
  }

  history(session: Session | undefined, input: StockHistoryInput): LedgerDto {
    requireSession(session);
    return {
      stockLocation: this.location(input.stockLocationId),
      catalogItemId: input.catalogItemId,
      timezone: this.repo.shopTimezone(),
      entries: this.repo.history(
        input.catalogItemId,
        input.stockLocationId,
        Math.min(input.limit ?? HISTORY_LIMIT, 500),
      ),
    };
  }

  // ---- writes (ADMIN) ----

  /**
   * The starting quantity of an item. Only for an item with NO ledger entries
   * at all (spec 39: existing inventory changes through stock operations, not
   * repeated opening balances); otherwise OPENING_BALANCE_EXISTS.
   */
  openBalance(
    session: Session | undefined,
    input: OpenBalanceInput,
  ): StockChangeDto {
    const actor = requireAdmin(session);
    return this.idempotent(actor, 'inventory.openBalance', input, () => {
      requireActiveStockLocation(this.deps.db, input.stockLocationId);
      requireTrackedItem(this.deps.db, input.catalogItemId);
      if (
        this.deps.db
          .prepare(
            'SELECT 1 FROM stock_ledger_entries WHERE catalog_item_id = ? AND stock_location_id = ? LIMIT 1',
          )
          .get(input.catalogItemId, input.stockLocationId)
      ) {
        throw new DomainError(
          'OPENING_BALANCE_EXISTS',
          'The item already has stock history',
        );
      }
      const entryId = this.append(
        actor,
        input.catalogItemId,
        input.stockLocationId,
        {
          movementType: 'OPENING_BALANCE',
          quantityDelta: input.quantity,
        },
      );
      this.audit(actor, 'STOCK_OPENING_BALANCE_RECORDED', input.catalogItemId, {
        stockLocationId: input.stockLocationId,
        entryId,
        quantityDelta: input.quantity,
        newQuantity: input.quantity,
      });
      return this.change(
        entryId,
        input.catalogItemId,
        input.stockLocationId,
        input.quantity,
      );
    });
  }

  receive(
    session: Session | undefined,
    input: ReceiveStockInput,
  ): StockChangeDto {
    const actor = requireAdmin(session);
    return this.idempotent(actor, 'inventory.receive', input, () => {
      requireActiveStockLocation(this.deps.db, input.stockLocationId);
      requireTrackedItem(this.deps.db, input.catalogItemId);
      const previous = stockOf(
        this.deps.db,
        input.catalogItemId,
        input.stockLocationId,
      );
      const note = input.note ? input.note : null;
      const entryId = this.append(
        actor,
        input.catalogItemId,
        input.stockLocationId,
        {
          movementType: 'STOCK_IN',
          quantityDelta: input.quantity,
          note,
        },
      );
      this.audit(actor, 'STOCK_RECEIVED', input.catalogItemId, {
        stockLocationId: input.stockLocationId,
        entryId,
        quantityDelta: input.quantity,
        previousQuantity: previous,
        newQuantity: previous + input.quantity,
        note,
      });
      return this.change(
        entryId,
        input.catalogItemId,
        input.stockLocationId,
        input.quantity,
      );
    });
  }

  adjust(
    session: Session | undefined,
    input: AdjustStockInput,
  ): StockChangeDto {
    const actor = requireAdmin(session);
    const reason = requireReason(input.reason);
    return this.idempotent(actor, 'inventory.adjust', input, () => {
      requireActiveStockLocation(this.deps.db, input.stockLocationId);
      requireTrackedItem(this.deps.db, input.catalogItemId);
      return this.writeAdjustment(
        actor,
        input.catalogItemId,
        input.stockLocationId,
        input.quantityDelta,
        reason,
        'ADJUST',
      );
    });
  }

  /**
   * "Set stock to N": the delta is computed here, inside the write
   * transaction, from the committed sum, so concurrent writers each see the
   * state they actually change. A zero delta writes nothing.
   */
  setStock(session: Session | undefined, input: SetStockInput): StockChangeDto {
    const actor = requireAdmin(session);
    const reason = requireReason(input.reason);
    return this.idempotent(actor, 'inventory.setStock', input, () => {
      requireActiveStockLocation(this.deps.db, input.stockLocationId);
      requireTrackedItem(this.deps.db, input.catalogItemId);
      const current = stockOf(
        this.deps.db,
        input.catalogItemId,
        input.stockLocationId,
      );
      const delta = input.targetQuantity - current;
      if (delta === 0) {
        return {
          entryId: null,
          stockLocation: this.location(input.stockLocationId),
          catalogItemId: input.catalogItemId,
          quantityDelta: 0,
          newQuantity: current,
        };
      }
      return this.writeAdjustment(
        actor,
        input.catalogItemId,
        input.stockLocationId,
        delta,
        reason,
        'SET_STOCK',
      );
    });
  }

  private location(id: string) {
    const location = new ReferenceRepository(this.deps.db).find(
      'stockLocation',
      id,
    );
    if (!location) throw new DomainError('STOCK_LOCATION_NOT_FOUND');
    return { id: location.id, code: location.code!, label: location.label };
  }

  // ---- internals ----

  private idempotent(
    actor: Session,
    command: string,
    input: { requestId: string },
    work: () => StockChangeDto,
  ): StockChangeDto {
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

  private writeAdjustment(
    actor: Session,
    catalogItemId: string,
    stockLocationId: string,
    delta: number,
    reason: string,
    via: 'ADJUST' | 'SET_STOCK',
  ): StockChangeDto {
    const previous = stockOf(this.deps.db, catalogItemId, stockLocationId);
    const entryId = this.append(actor, catalogItemId, stockLocationId, {
      movementType: 'ADJUSTMENT',
      quantityDelta: delta,
      note: reason,
    });
    this.audit(actor, 'STOCK_ADJUSTED', catalogItemId, {
      stockLocationId,
      entryId,
      via,
      quantityDelta: delta,
      previousQuantity: previous,
      newQuantity: previous + delta,
      reason,
    });
    return this.change(entryId, catalogItemId, stockLocationId, delta);
  }

  private append(
    actor: Session,
    catalogItemId: string,
    stockLocationId: string,
    entry: {
      movementType: 'OPENING_BALANCE' | 'STOCK_IN' | 'ADJUSTMENT';
      quantityDelta: number;
      note?: string | null;
    },
  ): string {
    return insertEntry(this.deps.db, {
      id: this.newId(),
      catalogItemId,
      stockLocationId,
      ...entry,
      createdByCashierId: actor.cashierId,
      createdAt: this.deps.clock.now(),
    });
  }

  private change(
    entryId: string,
    catalogItemId: string,
    stockLocationId: string,
    quantityDelta: number,
  ): StockChangeDto {
    return {
      entryId,
      catalogItemId,
      stockLocation: this.location(stockLocationId),
      quantityDelta,
      newQuantity: stockOf(this.deps.db, catalogItemId, stockLocationId),
    };
  }

  /** Metadata: ids, quantities and the reason text; never PII. */
  private audit(
    actor: Session,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): void {
    appendAudit(this.deps.db, this.deps.clock, {
      cashierId: actor.cashierId,
      action,
      entityType: 'catalog_item',
      entityId,
      metadata,
    });
  }
}

function requireReason(reason: string | undefined): string {
  const text = (reason ?? '').trim();
  if (text === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required');
  }
  return text;
}
