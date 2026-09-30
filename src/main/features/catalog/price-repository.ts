import { createHash } from 'node:crypto';
import type { AppDatabase } from '@/main/database/connection';
import { bool, textOrNull } from '@/main/database/rows';
import type { ResolvedPrice } from '@/shared/contracts';
import { formatRupiah, type Instant } from '@/shared/primitives';

export interface PriceRow {
  id: string;
  catalog_item_id: string;
  channel_id: string;
  effective_start_at: string;
  price: bigint;
  created_at: string;
  created_by_cashier_id: string;
  superseded_at: string | null;
  superseded_by_cashier_id: string | null;
  supersedes_price_id: string | null;
  correction_reason: string | null;
  /** Joined: the correction that replaced this point. */
  replaced_by_id?: string | null;
  replaced_reason?: string | null;
}

export interface NewPricePoint {
  id: string;
  catalogItemId: string;
  channelId: string;
  effectiveStartAt: Instant;
  price: bigint;
  createdAt: Instant;
  createdByCashierId: string;
  supersedesPriceId: string | null;
  correctionReason: string | null;
}

const COLUMNS = `id, catalog_item_id, channel_id, effective_start_at, price, created_at,
  created_by_cashier_id, superseded_at, superseded_by_cashier_id, supersedes_price_id,
  correction_reason`;

/**
 * Start-only price points. The ONLY write paths are `insertPoint` (append) and
 * `supersede` (one-time audit marker, set by an explicit correction). Nothing
 * here ever UPDATEs a point's price or start (the triggers forbid it too).
 */
export class PriceRepository {
  constructor(private readonly db: AppDatabase) {}

  /**
   * The price in force at `pricingAt`: the latest non-superseded point that
   * started at or before it. Start-only, so the last point never expires.
   * `pricingAt` must be a canonical Instant (text order == time order).
   */
  resolve(
    itemId: string,
    channelId: string,
    pricingAt: Instant,
  ): ResolvedPrice | null {
    const row = this.db
      .prepare(
        `SELECT id, effective_start_at, price FROM catalog_item_prices
         WHERE catalog_item_id = ?
           AND channel_id = ?
           AND effective_start_at <= ?
           AND superseded_at IS NULL
         ORDER BY effective_start_at DESC
         LIMIT 1`,
      )
      .get(itemId, channelId, pricingAt) as
      | { id: string; effective_start_at: string; price: bigint }
      | undefined;
    if (!row) return null;
    return {
      priceId: row.id,
      price: formatRupiah(row.price),
      effectiveStartAt: row.effective_start_at,
    };
  }

  find(id: string): PriceRow | undefined {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM catalog_item_prices WHERE id = ?`)
      .get(id) as PriceRow | undefined;
  }

  /** The non-superseded point occupying exactly this start, if any. */
  liveAtStart(
    itemId: string,
    channelId: string,
    start: Instant,
  ): PriceRow | undefined {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM catalog_item_prices
         WHERE catalog_item_id = ? AND channel_id = ? AND effective_start_at = ?
           AND superseded_at IS NULL`,
      )
      .get(itemId, channelId, start) as PriceRow | undefined;
  }

  /** The next non-superseded point strictly after `after` (display only). */
  successor(
    itemId: string,
    channelId: string,
    after: Instant,
    excludingId?: string,
  ): PriceRow | undefined {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM catalog_item_prices
         WHERE catalog_item_id = ? AND channel_id = ? AND effective_start_at > ?
           AND superseded_at IS NULL AND id <> ?
         ORDER BY effective_start_at ASC
         LIMIT 1`,
      )
      .get(itemId, channelId, after, excludingId ?? '') as PriceRow | undefined;
  }

  /** Every point (superseded revisions included) of an item, all channels. */
  listForItem(itemId: string): PriceRow[] {
    return this.db
      .prepare(
        `SELECT p.id, p.catalog_item_id, p.channel_id, p.effective_start_at, p.price,
                p.created_at, p.created_by_cashier_id, p.superseded_at,
                p.superseded_by_cashier_id, p.supersedes_price_id, p.correction_reason,
                r.id AS replaced_by_id, r.correction_reason AS replaced_reason
         FROM catalog_item_prices p
         LEFT JOIN catalog_item_prices r ON r.supersedes_price_id = p.id
         WHERE p.catalog_item_id = ?
         ORDER BY p.channel_id, p.effective_start_at, p.created_at, p.id`,
      )
      .all(itemId) as PriceRow[];
  }

  /**
   * Hash of every point of one item/channel (id, start, price, superseded
   * marker). A preview token is bound to it; any append or supersession in
   * between changes it.
   */
  fingerprint(itemId: string, channelId: string): string {
    const rows = this.db
      .prepare(
        `SELECT id, effective_start_at, price, superseded_at FROM catalog_item_prices
         WHERE catalog_item_id = ? AND channel_id = ? ORDER BY id`,
      )
      .all(itemId, channelId) as {
      id: string;
      effective_start_at: string;
      price: bigint;
      superseded_at: string | null;
    }[];
    const hash = createHash('sha256');
    for (const row of rows) {
      hash.update(
        `${row.id}|${row.effective_start_at}|${row.price.toString()}|${row.superseded_at ?? ''}\n`,
      );
    }
    return hash.digest('hex');
  }

  insertPoint(point: NewPricePoint): void {
    this.db
      .prepare(
        `INSERT INTO catalog_item_prices
           (id, catalog_item_id, channel_id, effective_start_at, currency, price,
            created_at, created_by_cashier_id, supersedes_price_id, correction_reason)
         VALUES (?, ?, ?, ?, 'IDR', ?, ?, ?, ?, ?)`,
      )
      .run(
        point.id,
        point.catalogItemId,
        point.channelId,
        point.effectiveStartAt,
        point.price,
        point.createdAt,
        point.createdByCashierId,
        point.supersedesPriceId,
        point.correctionReason,
      );
  }

  /** Marks a revision as replaced by an explicit correction (one-time, audit metadata). */
  supersede(id: string, at: Instant, byCashierId: string): void {
    this.db
      .prepare(
        `UPDATE catalog_item_prices SET superseded_at = ?, superseded_by_cashier_id = ?
         WHERE id = ? AND superseded_at IS NULL`,
      )
      .run(at, byCashierId, id);
  }

  channel(id: string): { isActive: boolean } | undefined {
    const row = this.db
      .prepare('SELECT is_active FROM channels WHERE id = ?')
      .get(id) as { is_active: bigint } | undefined;
    return row && { isActive: bool(row.is_active) };
  }

  itemExists(id: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM catalog_items WHERE id = ?').get(id) !==
      undefined
    );
  }

  shopTimezone(): string {
    const row = this.db
      .prepare('SELECT timezone FROM settings WHERE id = 1')
      .get() as { timezone: string | null } | undefined;
    return textOrNull(row?.timezone) ?? 'Asia/Jakarta';
  }
}
