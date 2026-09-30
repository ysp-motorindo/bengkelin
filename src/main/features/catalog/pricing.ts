import { randomUUID } from 'node:crypto';
import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { requireAdmin } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type {
  AppliedPriceChangeDto,
  PriceChangeData,
  PricePointDto,
  PricePointRef,
  PricePointState,
  PricePreviewDto,
  PriceTimelineDto,
  ResolvedPrice,
} from '@/shared/contracts';
import {
  DomainError,
  formatRupiah,
  parseRupiah,
  type Instant,
} from '@/shared/primitives';
import { isInstant, type Clock } from '@/shared/time';
import {
  PriceRepository,
  type NewPricePoint,
  type PriceRow,
} from './price-repository';

/** How long a preview token stays valid. */
export const PRICE_PREVIEW_TTL_MS = 10 * 60 * 1000;

export interface PricingServiceDeps {
  db: AppDatabase;
  clock: Clock;
  newId?: () => string;
}

interface PendingChange {
  input: PriceChangeData;
  price: bigint;
  fingerprint: string;
  cashierId: string;
  expiresAtMs: number;
}

const ref = (row: PriceRow): PricePointRef => ({
  priceId: row.id,
  price: formatRupiah(row.price),
  effectiveStartAt: row.effective_start_at,
});

/**
 * Appends one price point (ordinary change). MUST run inside a write
 * transaction. Refuses an exact (item, channel, start) that already has a
 * non-superseded point with PRICE_START_CONFLICT. Never updates an existing
 * point. T15 (CSV import) and price-change apply both go through this.
 */
export function appendPricePoint(
  repo: PriceRepository,
  point: NewPricePoint,
): void {
  if (!isInstant(point.effectiveStartAt)) {
    throw new DomainError(
      'INVALID_INSTANT',
      'Start must be a canonical instant',
    );
  }
  if (point.price < 0n) {
    throw new DomainError('NEGATIVE_MONEY', 'Price cannot be negative');
  }
  const taken = repo.liveAtStart(
    point.catalogItemId,
    point.channelId,
    point.effectiveStartAt,
  );
  if (taken) {
    throw new DomainError(
      'PRICE_START_CONFLICT',
      'A price already starts at that exact time',
    );
  }
  repo.insertPoint(point);
}

/**
 * Timeline states relative to `now`. Rows must be ordered by channel then
 * start (as `PriceRepository.listForItem` returns them).
 */
export function toPricePointDtos(
  rows: PriceRow[],
  now: Instant,
): PricePointDto[] {
  const currentIds = new Set<string>();
  const latest = new Map<string, PriceRow>();
  for (const row of rows) {
    if (row.superseded_at !== null || row.effective_start_at > now) continue;
    const best = latest.get(row.channel_id);
    if (!best || row.effective_start_at >= best.effective_start_at) {
      latest.set(row.channel_id, row);
    }
  }
  for (const row of latest.values()) currentIds.add(row.id);

  return rows.map((row) => {
    let state: PricePointState;
    if (row.superseded_at !== null) state = 'SUPERSEDED';
    else if (row.effective_start_at > now) state = 'SCHEDULED';
    else state = currentIds.has(row.id) ? 'CURRENT' : 'PREVIOUS';
    return {
      id: row.id,
      catalogItemId: row.catalog_item_id,
      channelId: row.channel_id,
      effectiveStartAt: row.effective_start_at,
      price: formatRupiah(row.price),
      state,
      createdAt: row.created_at,
      createdByCashierId: row.created_by_cashier_id,
      supersededAt: row.superseded_at,
      supersededByCashierId: row.superseded_by_cashier_id,
      supersedesPriceId: row.supersedes_price_id,
      correctionReason: row.correction_reason,
      supersededByPriceId: row.replaced_by_id ?? null,
      supersededReason: row.replaced_reason ?? null,
    };
  });
}

/**
 * Price resolution and the preview -> apply workflow for start-only prices.
 * Tokens live in memory in main (never persisted, lost on restart, which is
 * fine: a preview is a short-lived UI step).
 */
export class PricingService {
  private readonly repo: PriceRepository;
  private readonly newId: () => string;
  private readonly pending = new Map<string, PendingChange>();

  constructor(private readonly deps: PricingServiceDeps) {
    this.repo = new PriceRepository(deps.db);
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * Latest non-superseded price starting at or before `pricingAt`, else null.
   * Works for inactive items (historical lookups); sale eligibility is a
   * separate check. Internal API for drafts (T8): no session required.
   */
  resolvePrice(
    itemId: string,
    channelId: string,
    pricingAt: Instant,
  ): ResolvedPrice | null {
    if (!isInstant(pricingAt)) {
      throw new DomainError(
        'INVALID_INSTANT',
        'pricingAt must be a canonical instant',
      );
    }
    return this.repo.resolve(itemId, channelId, pricingAt);
  }

  /** Every point of an item (all channels, superseded revisions included). */
  timeline(itemId: string): PriceTimelineDto {
    if (!this.repo.itemExists(itemId)) {
      throw new DomainError('CATALOG_ITEM_NOT_FOUND', 'Item not found');
    }
    const now = this.deps.clock.now();
    return {
      catalogItemId: itemId,
      timezone: this.repo.shopTimezone(),
      now,
      points: toPricePointDtos(this.repo.listForItem(itemId), now),
    };
  }

  preview(
    session: Session | undefined,
    input: PriceChangeData,
  ): PricePreviewDto {
    const actor = requireAdmin(session);
    const price = parseRupiah(input.price);
    if (price < 0n) throw new DomainError('NEGATIVE_MONEY', 'Negative price');
    const now = this.deps.clock.now();
    this.purgeExpired(now);

    if (!this.repo.itemExists(input.catalogItemId)) {
      throw new DomainError('CATALOG_ITEM_NOT_FOUND', 'Item not found');
    }
    const channel = this.repo.channel(input.channelId);
    if (!channel)
      throw new DomainError('CHANNEL_NOT_FOUND', 'Channel not found');
    if (!channel.isActive) {
      throw new DomainError('CHANNEL_INACTIVE', 'Channel is inactive');
    }

    let target: PriceRow | undefined;
    if (input.correctsPriceId !== undefined) {
      if (!input.reason) {
        throw new DomainError(
          'CORRECTION_REASON_REQUIRED',
          'A correction needs a reason',
        );
      }
      target = this.mustCorrectable(input);
    }

    const current = this.repo.resolve(
      input.catalogItemId,
      input.channelId,
      input.effectiveStartAt,
    );
    const successor = this.repo.successor(
      input.catalogItemId,
      input.channelId,
      input.effectiveStartAt,
      target?.id,
    );
    const token = this.newId();
    const expiresAtMs = Date.parse(now) + PRICE_PREVIEW_TTL_MS;
    this.pending.set(token, {
      input,
      price,
      fingerprint: this.repo.fingerprint(input.catalogItemId, input.channelId),
      cashierId: actor.cashierId,
      expiresAtMs,
    });
    return {
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      catalogItemId: input.catalogItemId,
      channelId: input.channelId,
      effectiveStartAt: input.effectiveStartAt,
      price: formatRupiah(price),
      current,
      corrects: target ? ref(target) : null,
      successor: successor ? ref(successor) : null,
      timing: input.effectiveStartAt <= now ? 'PAST' : 'FUTURE',
      conflicts: this.conflicts(input),
    };
  }

  apply(session: Session | undefined, token: string): AppliedPriceChangeDto {
    const actor = requireAdmin(session);
    const now = this.deps.clock.now();
    const pending = this.pending.get(token);
    if (
      !pending ||
      pending.cashierId !== actor.cashierId ||
      Date.parse(now) > pending.expiresAtMs
    ) {
      this.pending.delete(token);
      throw new DomainError('PRICE_PREVIEW_EXPIRED', 'Preview expired');
    }
    // Single use: a stale or failed apply needs a fresh preview.
    this.pending.delete(token);
    const { input, price } = pending;

    return withWriteTransaction(this.deps.db, () => {
      if (
        this.repo.fingerprint(input.catalogItemId, input.channelId) !==
        pending.fingerprint
      ) {
        throw new DomainError(
          'PRICE_PREVIEW_STALE',
          'Prices changed since the preview',
        );
      }
      const target =
        input.correctsPriceId !== undefined
          ? this.mustCorrectable(input)
          : undefined;
      if (this.conflicts(input).length > 0) {
        throw new DomainError(
          'PRICE_START_CONFLICT',
          'A price already starts at that exact time',
        );
      }

      const before = this.repo.resolve(
        input.catalogItemId,
        input.channelId,
        input.effectiveStartAt,
      );
      const id = this.newId();
      if (target) this.repo.supersede(target.id, now, actor.cashierId);
      appendPricePoint(this.repo, {
        id,
        catalogItemId: input.catalogItemId,
        channelId: input.channelId,
        effectiveStartAt: input.effectiveStartAt,
        price,
        createdAt: now,
        createdByCashierId: actor.cashierId,
        supersedesPriceId: target?.id ?? null,
        correctionReason: target ? (input.reason ?? null) : null,
      });

      appendAudit(this.deps.db, this.deps.clock, {
        cashierId: actor.cashierId,
        action: target ? 'PRICE_POINT_CORRECTED' : 'PRICE_POINT_ADDED',
        entityType: 'catalog_item_price',
        entityId: id,
        metadata: {
          catalogItemId: input.catalogItemId,
          channelId: input.channelId,
          effectiveStartAt: input.effectiveStartAt,
          newPrice: formatRupiah(price),
          oldPrice: before ? before.price : null,
          oldPriceId: before ? before.priceId : null,
          correctsPriceId: target?.id ?? null,
          correctedPrice: target ? formatRupiah(target.price) : null,
          correctedStartAt: target?.effective_start_at ?? null,
          reason: target ? (input.reason ?? null) : null,
        },
      });

      const rows = this.repo
        .listForItem(input.catalogItemId)
        .filter((row) => row.channel_id === input.channelId);
      const point = toPricePointDtos(rows, now).find((p) => p.id === id);
      if (!point) throw new DomainError('INTERNAL_ERROR', 'Price not stored');
      return { point, supersededPriceId: target?.id ?? null };
    });
  }

  private conflicts(input: PriceChangeData): PricePreviewDto['conflicts'] {
    const live = this.repo.liveAtStart(
      input.catalogItemId,
      input.channelId,
      input.effectiveStartAt,
    );
    return live && live.id !== input.correctsPriceId
      ? [{ code: 'PRICE_START_CONFLICT', priceId: live.id }]
      : [];
  }

  private mustCorrectable(input: PriceChangeData): PriceRow {
    const target = input.correctsPriceId
      ? this.repo.find(input.correctsPriceId)
      : undefined;
    if (
      !target ||
      target.superseded_at !== null ||
      target.catalog_item_id !== input.catalogItemId ||
      target.channel_id !== input.channelId
    ) {
      throw new DomainError(
        'PRICE_CORRECTION_TARGET_INVALID',
        'The revision to correct must be a current revision of this item and channel',
      );
    }
    return target;
  }

  private purgeExpired(now: Instant): void {
    const nowMs = Date.parse(now);
    for (const [token, pending] of this.pending) {
      if (nowMs > pending.expiresAtMs) this.pending.delete(token);
    }
  }
}
