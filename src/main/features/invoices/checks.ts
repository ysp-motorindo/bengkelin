import type { AppDatabase } from '@/main/database/connection';
import { canonicalJson } from '@/main/database/idempotency';
import { toNumber } from '@/main/database/rows';
import type { CustomerRepository } from '@/main/features/customers/repository';
import {
  calculateDraftTotals,
  type DraftCalculation,
} from '@/main/features/drafts/totals';
import type {
  AllocationRow,
  DraftRepository,
  InvoiceRow,
} from '@/main/features/drafts/repository';
import { stockOf } from '@/main/features/inventory/ledger';
import type { VehicleRepository } from '@/main/features/vehicles/repository';
import type {
  FinalizeIssue,
  FinalizeWarning,
  PaymentStatus,
} from '@/shared/contracts';
import { detectOwnerMismatch } from '@/shared/ownership';
import { formatRupiah, type LocalDate } from '@/shared/primitives';
import { derivePaymentStatus } from './domain';
import type { InvoiceRepository, TrackedDemandRow } from './repository';

/**
 * Finalization validation and warnings (spec 15, 22, 25, 26; Part A). Pure
 * reads: `previewFinalize` runs it on its own, and `finalize` runs it again
 * INSIDE its write transaction so the decision is made on committed state.
 */

export interface CheckDeps {
  db: AppDatabase;
  drafts: DraftRepository;
  invoices: InvoiceRepository;
  customers: CustomerRepository;
  vehicles: VehicleRepository;
}

export interface FinalizationCheck {
  calculation: DraftCalculation;
  allocations: AllocationRow[];
  allocatedAmount: bigint;
  demand: TrackedDemandRow[];
  errors: FinalizeIssue[];
  warnings: FinalizeWarning[];
  /** Derived status right after checkout; null while there are errors. */
  paymentStatusAfterCheckout: PaymentStatus | null;
}

export function checkFinalization(
  deps: CheckDeps,
  invoice: InvoiceRow,
  today: LocalDate,
): FinalizationCheck {
  const calculation = calculateDraftTotals(deps.drafts, invoice.id);
  const amount = calculation.calc.amount;
  const allocations = deps.drafts.allocations(invoice.id);
  const allocatedAmount = allocations.reduce((sum, a) => sum + a.amount, 0n);
  const demand = deps.invoices.trackedDemand(invoice.id);

  // ---- blocking errors ----
  const errors: FinalizeIssue[] = [];
  if (calculation.lines.length === 0) {
    errors.push({ code: 'DRAFT_EMPTY', params: {} });
  }
  // LocalDate strings compare chronologically.
  if (invoice.invoice_date > today) {
    errors.push({
      code: 'INVOICE_DATE_IN_FUTURE',
      params: { invoiceDate: invoice.invoice_date, today },
    });
  }
  const channel = deps.drafts.channel(invoice.channel_id);
  if (!channel?.isActive) {
    errors.push({
      code: 'CHANNEL_INACTIVE',
      params: { channel: channel?.label ?? '' },
    });
  }
  // Inactive items cannot be sold (spec 11), even if deactivated after the
  // line was added. Ad-hoc references, mechanics and units do not block.
  for (const item of deps.invoices.inactiveCatalogItems(invoice.id)) {
    errors.push({
      code: 'CATALOG_ITEM_INACTIVE',
      params: { catalogItemId: item.catalog_item_id, title: item.title },
    });
  }
  if (amount === 0n && allocations.length > 0) {
    errors.push({
      code: 'ZERO_TOTAL_WITH_ALLOCATIONS',
      params: { allocatedAmount: formatRupiah(allocatedAmount) },
    });
  } else if (allocatedAmount > amount) {
    errors.push({
      code: 'ALLOCATION_EXCEEDS_AMOUNT',
      params: {
        allocatedAmount: formatRupiah(allocatedAmount),
        amount: formatRupiah(amount),
      },
    });
  }

  // ---- warnings (never block; must be acknowledged as observed) ----
  const warnings: FinalizeWarning[] = [];
  for (const item of demand) {
    const observedStock = stockOf(deps.db, item.catalog_item_id);
    const quantity = toNumber(item.demand);
    const resultingStock = observedStock - quantity;
    if (resultingStock < 0) {
      warnings.push({
        code: 'NEGATIVE_STOCK',
        params: {
          catalogItemId: item.catalog_item_id,
          title: item.title,
          observedStock,
          demand: quantity,
          resultingStock,
        },
      });
    }
  }
  if (invoice.vehicle_id !== null) {
    if (invoice.odometer_km !== null) {
      const previous = deps.invoices.previousOdometer(
        invoice.vehicle_id,
        invoice.id,
      );
      if (previous !== null && invoice.odometer_km < previous) {
        warnings.push({
          code: 'ODOMETER_LOWER_THAN_PREVIOUS',
          params: { previousOdometer: toNumber(previous) },
        });
      }
    }
    const activeOwnerId =
      deps.vehicles.find(invoice.vehicle_id)?.activeOwnerId ?? null;
    if (
      activeOwnerId !== null &&
      detectOwnerMismatch(activeOwnerId, invoice.customer_id)
    ) {
      warnings.push({ code: 'OWNER_MISMATCH', params: { activeOwnerId } });
    }
  }

  return {
    calculation,
    allocations,
    allocatedAmount,
    demand,
    errors,
    warnings,
    paymentStatusAfterCheckout:
      errors.length === 0 ? derivePaymentStatus(amount, allocatedAmount) : null,
  };
}

function warningKey(warning: FinalizeWarning): string {
  return warning.code === 'NEGATIVE_STOCK'
    ? `${warning.code}:${warning.params.catalogItemId}`
    : warning.code;
}

/**
 * True when the acknowledged warnings are exactly the current ones: the same
 * set, with the same observed values (stock balances, previous odometer,
 * owner). Order does not matter.
 */
export function sameWarnings(
  current: FinalizeWarning[],
  acknowledged: FinalizeWarning[],
): boolean {
  const canonical = (list: FinalizeWarning[]) =>
    canonicalJson(
      [...list].sort((a, b) => warningKey(a).localeCompare(warningKey(b))),
    );
  return canonical(current) === canonical(acknowledged);
}
