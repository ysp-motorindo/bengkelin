import type { TrackingChangeGuard } from '@/main/features/catalog/service';
import type {
  CatalogItemType,
  ImportCounts,
  ImportField,
} from '@/shared/contracts';
import { DomainError, type Instant } from '@/shared/primitives';
import { issueError, issueWarning, type Issue } from './issues';
import type { CandidateRow } from './validator';

/**
 * Diffs validated rows against the catalog at ONE import instant and decides
 * exactly what the commit will write. Runs for the preview and again inside
 * the commit transaction (same rows, current database, commit instant).
 *
 * New SKU: creates the item (STOCK_ITEM tracks inventory, SERVICE never),
 *   its barcodes, a price point at the import instant for each non-empty
 *   price, and an OPENING_BALANCE when the item is tracked and
 *   `opening_stock` is present (0 included: an explicit zero is recorded).
 * Existing SKU: empty cells change nothing. Title, description, type, unit
 *   and active flag update. A type change that flips inventory tracking is
 *   subject to T7's tracking rule. Listed barcodes are added or activated;
 *   unlisted ones are left as they are. `opening_stock` is ignored (warning).
 * Prices: compared with the price in force at the import instant. A
 *   different price appends a start-only point at that instant; an equal
 *   price appends nothing. Future points are never touched and no end
 *   timestamp exists.
 */

export interface ExistingItem {
  id: string;
  sku: string;
  type: CatalogItemType;
  title: string;
  description: string | null;
  unitId: string;
  unitCode: string;
  weight: number | null;
  trackInventory: boolean;
  isActive: boolean;
}

export interface BarcodeOwnerRef {
  barcodeId: string;
  itemId: string;
  itemSku: string | null;
  itemTitle: string;
  isActive: boolean;
}

/** The catalog reads the planner needs (implemented by the repository). */
export interface PlannerSource {
  itemBySku(sku: string): ExistingItem | undefined;
  /**
   * An existing SKU that equals `digits` once its leading zeros are
   * stripped (e.g. `00123` for `123`), if any.
   */
  skuWithLeadingZeros(digits: string): string | undefined;
  barcodeOwner(barcode: string): BarcodeOwnerRef | undefined;
  /** The price in force at `at` (start-only resolution), or null. */
  priceAt(itemId: string, channelId: string, at: Instant): bigint | null;
}

export interface PlannedFields {
  type: CatalogItemType;
  title: string;
  description: string | null;
  unitId: string;
  trackInventory: boolean;
  isActive: boolean;
}

export interface PlannedPrice {
  channelId: string;
  channelCode: string;
  from: bigint | null;
  to: bigint;
}

export interface ItemPlan {
  row: number;
  sku: string;
  action: 'CREATE' | 'UPDATE' | 'UNCHANGED';
  existing: ExistingItem | null;
  fields: PlannedFields;
  changedFields: ImportField[];
  barcodesToAdd: string[];
  barcodesToActivate: { id: string; barcode: string }[];
  prices: PlannedPrice[];
  openingStock: number | null;
}

export interface ImportPlan {
  items: ItemPlan[];
  /** Rows with a blocking planner error (excluded from `items`). */
  invalidRows: Set<number>;
  issues: Issue[];
  /** Existing items the import would touch (for the fingerprint). */
  affectedItemIds: string[];
}

export function planImport(
  candidates: CandidateRow[],
  source: PlannerSource,
  importAt: Instant,
  trackingGuard: TrackingChangeGuard,
): ImportPlan {
  const plan: ImportPlan = {
    items: [],
    invalidRows: new Set(),
    issues: [],
    affectedItemIds: [],
  };

  for (const candidate of candidates) {
    const { row, sku } = candidate;
    const errors: Issue[] = [];
    const warnings: Issue[] = [];
    const at = (column: string | null) => ({ row, column, sku });
    const existing = source.itemBySku(sku) ?? null;
    if (existing) plan.affectedItemIds.push(existing.id);

    // ---- item fields ----
    let fields: PlannedFields;
    const changedFields: ImportField[] = [];
    if (!existing && /^[1-9][0-9]*$/.test(sku)) {
      // A spreadsheet may have dropped the leading zeros of `00123`.
      const padded = source.skuWithLeadingZeros(sku);
      if (padded !== undefined) {
        warnings.push(
          issueWarning('POSSIBLE_LEADING_ZERO_LOSS', at('sku'), {
            existingSku: padded,
          }),
        );
      }
    }
    if (!existing) {
      if (candidate.title === null)
        errors.push(issueError('TITLE_REQUIRED', at('title')));
      if (candidate.type === null)
        errors.push(issueError('TYPE_REQUIRED', at('type')));
      if (candidate.unit === null)
        errors.push(issueError('UNIT_REQUIRED', at('unit')));
      else if (!candidate.unit.isActive) {
        errors.push(
          issueError('UNIT_INACTIVE', at('unit'), {
            value: candidate.unit.code,
          }),
        );
      }
      const type = candidate.type ?? 'STOCK_ITEM';
      fields = {
        type,
        title: candidate.title ?? '',
        description: candidate.description,
        unitId: candidate.unit?.id ?? '',
        trackInventory: type === 'STOCK_ITEM',
        isActive: candidate.isActive ?? true,
      };
    } else {
      const type = candidate.type ?? existing.type;
      const typeChanged = type !== existing.type;
      fields = {
        type,
        title: candidate.title ?? existing.title,
        description: candidate.description ?? existing.description,
        unitId: candidate.unit?.id ?? existing.unitId,
        // Default semantics on a type change (spec 10); otherwise kept.
        trackInventory: typeChanged
          ? type === 'STOCK_ITEM'
          : existing.trackInventory,
        isActive: candidate.isActive ?? existing.isActive,
      };
      if (fields.title !== existing.title) changedFields.push('title');
      if (fields.description !== existing.description) {
        changedFields.push('description');
      }
      if (typeChanged) changedFields.push('type');
      if (fields.unitId !== existing.unitId) {
        changedFields.push('unit');
        if (candidate.unit && !candidate.unit.isActive) {
          errors.push(
            issueError('UNIT_INACTIVE', at('unit'), {
              value: candidate.unit.code,
            }),
          );
        }
      }
      if (fields.trackInventory !== existing.trackInventory) {
        changedFields.push('trackInventory');
        try {
          trackingGuard({
            itemId: existing.id,
            from: existing.trackInventory,
            to: fields.trackInventory,
          });
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          errors.push(issueError(error.code, at('type'), error.params));
        }
      }
      if (fields.isActive !== existing.isActive) changedFields.push('isActive');
    }

    // ---- opening stock ----
    let openingStock: number | null = null;
    if (candidate.openingStock !== null) {
      if (fields.type === 'SERVICE') {
        errors.push(
          issueError('SERVICE_WITH_OPENING_STOCK', at('opening_stock')),
        );
      } else if (existing) {
        warnings.push(
          issueWarning('OPENING_STOCK_IGNORED', at('opening_stock')),
        );
      } else if (fields.trackInventory) {
        openingStock = candidate.openingStock;
      }
    }

    // ---- barcodes: add or activate, never remove ----
    const barcodesToAdd: string[] = [];
    const barcodesToActivate: ItemPlan['barcodesToActivate'] = [];
    for (const { column, value } of candidate.barcodes) {
      const owner = source.barcodeOwner(value);
      if (!owner) {
        barcodesToAdd.push(value);
      } else if (owner.itemId !== existing?.id) {
        errors.push(
          issueError('BARCODE_OWNED_BY_OTHER_ITEM', at(column), {
            barcode: value,
            ownerSku: owner.itemSku ?? '',
            ownerTitle: owner.itemTitle,
          }),
        );
      } else if (!owner.isActive) {
        barcodesToActivate.push({ id: owner.barcodeId, barcode: value });
      }
    }

    // ---- prices at the ONE import instant ----
    const prices: PlannedPrice[] = [];
    for (const { column, channel, price } of candidate.prices) {
      const from = existing
        ? source.priceAt(existing.id, channel.id, importAt)
        : null;
      if (from === price) {
        warnings.push(
          issueWarning('PRICE_UNCHANGED', at(column), {
            price: price.toString(),
          }),
        );
        continue;
      }
      prices.push({
        channelId: channel.id,
        channelCode: channel.code,
        from,
        to: price,
      });
    }

    plan.issues.push(...errors, ...warnings);
    if (errors.length > 0) {
      plan.invalidRows.add(row);
      continue;
    }
    const changed =
      changedFields.length > 0 ||
      barcodesToAdd.length > 0 ||
      barcodesToActivate.length > 0 ||
      prices.length > 0;
    plan.items.push({
      row,
      sku,
      action: !existing ? 'CREATE' : changed ? 'UPDATE' : 'UNCHANGED',
      existing,
      fields,
      changedFields,
      barcodesToAdd,
      barcodesToActivate,
      prices,
      openingStock,
    });
  }
  return plan;
}

export function countPlan(items: ItemPlan[]): ImportCounts {
  const counts: ImportCounts = {
    creates: 0,
    updates: 0,
    unchanged: 0,
    priceChanges: 0,
    openingBalances: 0,
    barcodeChanges: 0,
  };
  for (const item of items) {
    if (item.action === 'CREATE') counts.creates += 1;
    else if (item.action === 'UPDATE') counts.updates += 1;
    else counts.unchanged += 1;
    counts.priceChanges += item.prices.length;
    if (item.openingStock !== null) counts.openingBalances += 1;
    counts.barcodeChanges +=
      item.barcodesToAdd.length + item.barcodesToActivate.length;
  }
  return counts;
}

/**
 * Everything the user confirmed, minus instants and generated ids. The
 * commit re-plans at its own instant; a different signature means the
 * preview no longer describes what would be written (IMPORT_PREVIEW_STALE),
 * for example a scheduled price that started in between.
 */
export function planSignature(items: ItemPlan[]): string {
  return JSON.stringify(
    items.map((item) => [
      item.row,
      item.sku,
      item.action,
      item.existing?.id ?? null,
      item.fields,
      item.changedFields,
      item.barcodesToAdd,
      item.barcodesToActivate.map((b) => b.id),
      item.prices.map((p) => [
        p.channelId,
        p.from?.toString() ?? null,
        p.to.toString(),
      ]),
      item.openingStock,
    ]),
  );
}
