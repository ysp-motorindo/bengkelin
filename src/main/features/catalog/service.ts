import { randomUUID } from 'node:crypto';
import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { requireAdmin, requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type {
  AppliedPriceChangeDto,
  CatalogIdInput,
  CatalogItemDto,
  ListPricesInput,
  LookupBarcodeInput,
  PriceChangeData,
  PricePreviewDto,
  PriceTimelineDto,
  ResolvedPrice,
  SaveBarcodesData,
  SaveCatalogItemData,
  SearchCatalogInput,
  SearchCatalogResult,
} from '@/shared/contracts';
import { DomainError, type Instant } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { PricingService } from './pricing';
import { CatalogRepository, type CatalogItemFields } from './repository';

/**
 * Hook for T7 (inventory ledger). Called inside the save transaction whenever
 * an existing item's `trackInventory` value changes. T7 supplies a guard that
 * throws a DomainError (for example when ledger movements exist). The default
 * allows every change, because there is no ledger yet.
 */
export type TrackingChangeGuard = (change: {
  itemId: string;
  from: boolean;
  to: boolean;
}) => void;

export interface CatalogServiceDeps {
  db: AppDatabase;
  clock: Clock;
  newId?: () => string;
  trackingChangeGuard?: TrackingChangeGuard;
}

const DEFAULT_LIMIT = 25;

const EDITABLE: (keyof CatalogItemFields)[] = [
  'type',
  'title',
  'description',
  'sku',
  'unitId',
  'weight',
  'trackInventory',
  'isActive',
];

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

/**
 * Catalog (spec 10, 11, 13, 35, 55). ADMIN manages items, barcodes and prices;
 * any signed-in cashier may search, look up barcodes and view prices.
 * Prices are START-ONLY: see `pricing.ts` and migration 004.
 */
export class CatalogService {
  private readonly repo: CatalogRepository;
  private readonly pricing: PricingService;
  private readonly newId: () => string;
  private trackingChangeGuard: TrackingChangeGuard;

  constructor(private readonly deps: CatalogServiceDeps) {
    this.repo = new CatalogRepository(deps.db);
    this.newId = deps.newId ?? randomUUID;
    this.pricing = new PricingService({ ...deps, newId: this.newId });
    this.trackingChangeGuard = deps.trackingChangeGuard ?? (() => undefined);
  }

  /** T7 installs its ledger-aware guard here (see `TrackingChangeGuard`). */
  setTrackingChangeGuard(guard: TrackingChangeGuard): void {
    this.trackingChangeGuard = guard;
  }

  // ---- reads (any session) ----

  search(
    session: Session | undefined,
    input: SearchCatalogInput,
  ): SearchCatalogResult {
    requireSession(session);
    return {
      results: this.repo.search(
        (input.query ?? '').trim(),
        input.includeInactive === true,
        Math.min(input.limit ?? DEFAULT_LIMIT, 50),
      ),
    };
  }

  get(session: Session | undefined, input: CatalogIdInput): CatalogItemDto {
    requireSession(session);
    return this.mustFind(input.id);
  }

  /**
   * Scanner lookup. Returns the item, or a typed error: UNKNOWN_BARCODE,
   * BARCODE_INACTIVE, CATALOG_ITEM_INACTIVE. Never creates anything.
   */
  lookupBarcode(
    session: Session | undefined,
    input: LookupBarcodeInput,
  ): CatalogItemDto {
    requireSession(session);
    const code = input.code.trim();
    const owner = code === '' ? undefined : this.repo.findBarcodeOwner(code);
    if (!owner) throw new DomainError('UNKNOWN_BARCODE', 'Unknown barcode');
    if (!owner.isActive) {
      throw new DomainError('BARCODE_INACTIVE', 'Barcode is inactive');
    }
    if (!owner.itemIsActive) {
      throw new DomainError('CATALOG_ITEM_INACTIVE', 'Item is inactive');
    }
    return this.mustFind(owner.itemId);
  }

  listPrices(
    session: Session | undefined,
    input: ListPricesInput,
  ): PriceTimelineDto {
    requireSession(session);
    return this.pricing.timeline(input.catalogItemId);
  }

  /** Internal (drafts, T8): the price in force at `pricingAt`, or null. */
  resolvePrice(
    itemId: string,
    channelId: string,
    pricingAt: Instant,
  ): ResolvedPrice | null {
    return this.pricing.resolvePrice(itemId, channelId, pricingAt);
  }

  // ---- writes (ADMIN) ----

  save(
    session: Session | undefined,
    input: SaveCatalogItemData,
  ): CatalogItemDto {
    const actor = requireAdmin(session);
    return withWriteTransaction(this.deps.db, () => {
      const now = this.deps.clock.now();
      const existing = input.id ? this.mustFind(input.id) : undefined;
      const fields: CatalogItemFields = {
        type: input.type,
        title: input.title,
        description: input.description,
        sku: input.sku,
        unitId: input.unitId,
        weight: input.weight,
        trackInventory:
          input.type === 'SERVICE'
            ? false
            : (input.trackInventory ?? existing?.trackInventory ?? true),
        isActive: input.isActive ?? existing?.isActive ?? true,
      };

      const unit = this.repo.unit(fields.unitId);
      if (!unit) throw new DomainError('UNIT_NOT_FOUND', 'Unit not found');
      if (!unit.isActive && existing?.unitId !== fields.unitId) {
        throw new DomainError('UNIT_INACTIVE', 'Unit is inactive');
      }

      const id = existing?.id ?? this.newId();
      if (fields.sku !== null && this.repo.skuOwner(fields.sku, id)) {
        throw new DomainError('DUPLICATE_SKU', 'SKU already in use');
      }

      if (existing) {
        if (existing.trackInventory !== fields.trackInventory) {
          this.trackingChangeGuard({
            itemId: existing.id,
            from: existing.trackInventory,
            to: fields.trackInventory,
          });
        }
        try {
          this.repo.update(id, fields, now);
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new DomainError('DUPLICATE_SKU', 'SKU already in use');
          }
          throw error;
        }
        this.audit(actor, 'CATALOG_ITEM_UPDATED', id, {
          changedFields: EDITABLE.filter(
            (key) => existing[key] !== fields[key],
          ),
        });
      } else {
        try {
          this.repo.insert(id, fields, now);
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new DomainError('DUPLICATE_SKU', 'SKU already in use');
          }
          throw error;
        }
        this.audit(actor, 'CATALOG_ITEM_CREATED', id, {
          type: fields.type,
          sku: fields.sku,
        });
      }
      return this.mustFind(id);
    });
  }

  saveBarcodes(
    session: Session | undefined,
    input: SaveBarcodesData,
  ): CatalogItemDto {
    const actor = requireAdmin(session);
    return withWriteTransaction(this.deps.db, () => {
      const now = this.deps.clock.now();
      this.mustFind(input.catalogItemId);
      const added: string[] = [];
      const changed: string[] = [];
      for (const entry of input.barcodes) {
        const owner = this.repo.findBarcodeOwner(entry.barcode);
        if (owner && owner.itemId !== input.catalogItemId) {
          throw new DomainError(
            'DUPLICATE_BARCODE',
            'Barcode belongs to another item',
            { barcode: entry.barcode, owner: owner.itemTitle },
          );
        }
        if (!owner) {
          this.repo.insertBarcode(
            this.newId(),
            input.catalogItemId,
            entry.barcode,
            entry.isActive,
          );
          added.push(entry.barcode);
        } else if (owner.isActive !== entry.isActive) {
          this.repo.setBarcodeActive(owner.barcodeId, entry.isActive);
          changed.push(entry.barcode);
        }
      }
      if (added.length > 0 || changed.length > 0) {
        this.repo.touch(input.catalogItemId, now);
        this.audit(actor, 'CATALOG_BARCODES_UPDATED', input.catalogItemId, {
          added,
          activeFlagChanged: changed,
        });
      }
      return this.mustFind(input.catalogItemId);
    });
  }

  previewPriceChange(
    session: Session | undefined,
    input: PriceChangeData,
  ): PricePreviewDto {
    return this.pricing.preview(session, input);
  }

  applyPriceChange(
    session: Session | undefined,
    token: string,
  ): AppliedPriceChangeDto {
    return this.pricing.apply(session, token);
  }

  private mustFind(id: string): CatalogItemDto {
    const found = this.repo.find(id);
    if (!found) {
      throw new DomainError('CATALOG_ITEM_NOT_FOUND', 'Item not found');
    }
    return found;
  }

  /** Metadata: ids, flags and field NAMES only (barcodes and SKUs are business identifiers, not PII). */
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
