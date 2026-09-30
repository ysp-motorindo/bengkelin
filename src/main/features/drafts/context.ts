import type { AdHocReferenceRepository } from '@/main/features/ad-hoc-references/repository';
import type { Session } from '@/main/features/auth/sessions';
import type { CatalogService } from '@/main/features/catalog/service';
import type { CustomerRepository } from '@/main/features/customers/repository';
import type { VehicleRepository } from '@/main/features/vehicles/repository';
import type { DraftOperationData, PriceChangeKind } from '@/shared/contracts';
import { DomainError, type Instant } from '@/shared/primitives';
import type { DraftRepository, InvoiceRow, LineRow } from './repository';

/** The parsed operation of one kind. */
export type DraftOp<K extends DraftOperationData['kind']> = Extract<
  DraftOperationData,
  { kind: K }
>;

/**
 * Everything one draft operation needs. Built by DraftService inside the
 * command's write transaction, after authorization, idempotency and the
 * version/status checks. `invoice` is the row as it was before the command.
 */
export interface OperationContext {
  repo: DraftRepository;
  adHoc: AdHocReferenceRepository;
  customers: CustomerRepository;
  vehicles: VehicleRepository;
  catalog: CatalogService;
  actor: Session;
  invoice: InvoiceRow;
  now: Instant;
  newId: () => string;
  /** Appends a business audit row (spec 47) for this draft. */
  audit: (action: string, metadata: Record<string, unknown>) => void;
}

/** A live line of THIS draft, else LINE_NOT_FOUND (removed lines included). */
export function requireLine(ctx: OperationContext, lineId: string): LineRow {
  const line = ctx.repo.findLiveLine(ctx.invoice.id, lineId);
  if (!line) throw new DomainError('LINE_NOT_FOUND', 'Line not found');
  return line;
}

export function requireActiveChannel(
  repo: DraftRepository,
  channelId: string,
): void {
  const channel = repo.channel(channelId);
  if (!channel) throw new DomainError('CHANNEL_NOT_FOUND', 'Channel not found');
  if (!channel.isActive) {
    throw new DomainError('CHANNEL_INACTIVE', 'Channel is inactive');
  }
}

/** Appends to the line's append-only price history (spec 19). */
export function recordPriceChange(
  ctx: OperationContext,
  change: {
    lineId: string;
    kind: PriceChangeKind;
    previousPrice: bigint | null;
    newPrice: bigint;
    reason: string | null;
  },
): void {
  ctx.repo.appendPriceChange({
    id: ctx.newId(),
    ...change,
    cashierId: ctx.actor.cashierId,
    at: ctx.now,
  });
}
