import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CHANNELS } from '@/shared/channels';
import type {
  AppliedPriceChangeDto,
  CatalogItemDto,
  PricePreviewDto,
  PriceTimelineDto,
  ReferenceDto,
  SearchCatalogResult,
} from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';
import { resolveLocalDateTime, toInstant } from '@/shared/time';
import {
  ADMIN_PASSWORD,
  createHarness,
  failure,
  validSetup,
  value,
  type Harness,
} from './helpers/harness';

const C = CHANNELS;
const ADMIN = 1;
const CASHIER = 2;
const T0 = Date.UTC(2026, 8, 30, 3, 0, 0);
const ZONE = 'Asia/Jakarta';

/** Asia/Jakarta wall-clock time -> canonical Instant. */
function local(dateTime: string): Instant {
  const resolved = resolveLocalDateTime(dateTime, ZONE);
  if (resolved.kind !== 'ok') throw new Error(`not resolvable: ${dateTime}`);
  return resolved.instant;
}

let h: Harness;
let nowMs = T0;
let bengkel: string;
let shopee: string;
let pcs: string;

beforeEach(async () => {
  nowMs = T0;
  h = createHarness({ clock: { now: () => toInstant(nowMs) } });
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(
      C.auth.login,
      { username: 'admin', password: ADMIN_PASSWORD },
      ADMIN,
    ),
  );
  value(
    await h.call(C.cashiers.create, {
      username: 'siti',
      displayName: 'Siti',
      password: 'siti-password-1',
      role: 'CASHIER',
    }),
  );
  value(
    await h.call(
      C.auth.login,
      { username: 'siti', password: 'siti-password-1' },
      CASHIER,
    ),
  );
  const channels = value(
    await h.call<ReferenceDto[]>(C.references.list, { entity: 'channel' }),
  );
  bengkel = channels.find((c) => c.code === 'BENGKEL')!.id;
  shopee = channels.find((c) => c.code === 'ONLINE')!.id;
  const units = value(
    await h.call<ReferenceDto[]>(C.references.list, { entity: 'unit' }),
  );
  pcs = units.find((u) => u.code === 'PCS')!.id;
});
afterEach(() => h.close());

const rows = (sql: string, ...params: unknown[]) =>
  h.db.prepare(sql).all(...params) as Record<string, unknown>[];

async function newItem(
  overrides: Record<string, unknown> = {},
  windowId = ADMIN,
) {
  return value(
    await h.call<CatalogItemDto>(
      C.catalog.save,
      { type: 'STOCK_ITEM', title: 'Oli MPX2', unitId: pcs, ...overrides },
      windowId,
    ),
  );
}

interface PriceArgs {
  itemId: string;
  channelId?: string;
  start: Instant;
  price: string;
  correctsPriceId?: string;
  reason?: string;
}

async function preview(args: PriceArgs, windowId = ADMIN) {
  return h.call<PricePreviewDto>(
    C.catalog.previewPriceChange,
    {
      catalogItemId: args.itemId,
      channelId: args.channelId ?? bengkel,
      effectiveStartAt: args.start,
      price: args.price,
      ...(args.correctsPriceId
        ? { correctsPriceId: args.correctsPriceId }
        : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    },
    windowId,
  );
}

async function addPrice(args: PriceArgs) {
  const p = value(await preview(args));
  return value(
    await h.call<AppliedPriceChangeDto>(C.catalog.applyPriceChange, {
      token: p.token,
    }),
  );
}

const resolve = (itemId: string, at: Instant, channelId = bengkel) =>
  h.services.catalog.resolvePrice(itemId, channelId, at);

async function timeline(itemId: string, windowId = ADMIN) {
  return value(
    await h.call<PriceTimelineDto>(
      C.catalog.listPrices,
      { catalogItemId: itemId },
      windowId,
    ),
  );
}

describe('start-only price resolution', () => {
  test('65000 until 14:00:00 local, 70000 from exactly 14:00:00 and months later, null before the first start', async () => {
    const item = await newItem();
    await addPrice({
      itemId: item.id,
      start: local('2026-01-01T00:00:00'),
      price: '65000',
    });
    await addPrice({
      itemId: item.id,
      start: local('2026-03-10T14:00:00'),
      price: '70000',
    });

    const priceBeforeFirstStart = resolve(
      item.id,
      local('2025-12-31T23:59:59'),
    );
    const priceAt135959 = resolve(item.id, local('2026-03-10T13:59:59'));
    const priceAt140000 = resolve(item.id, local('2026-03-10T14:00:00'));
    const priceMonthsAfterLastStart = resolve(
      item.id,
      local('2026-09-10T09:00:00'),
    );

    expect(priceBeforeFirstStart).toBeNull();
    expect(priceAt135959?.price).toBe('65000');
    expect(priceAt140000?.price).toBe('70000');
    expect(priceMonthsAfterLastStart?.price).toBe('70000');
    expect(priceAt140000?.effectiveStartAt).toBe(local('2026-03-10T14:00:00'));
    // The first start itself is effective, with no end anywhere.
    expect(resolve(item.id, local('2026-01-01T00:00:00'))?.price).toBe('65000');
    // Far future: still the last price. It never expires.
    expect(resolve(item.id, toInstant(Date.UTC(2099, 0, 1)))?.price).toBe(
      '70000',
    );
  });

  test('a missing price for a channel resolves to null; channels are independent', async () => {
    const item = await newItem();
    await addPrice({
      itemId: item.id,
      start: local('2026-01-01T00:00:00'),
      price: '65000',
    });
    expect(resolve(item.id, local('2026-06-01T00:00:00'), shopee)).toBeNull();
    await addPrice({
      itemId: item.id,
      channelId: shopee,
      start: local('2026-02-01T00:00:00'),
      price: '80000',
    });
    expect(resolve(item.id, local('2026-06-01T00:00:00'), shopee)?.price).toBe(
      '80000',
    );
    expect(resolve(item.id, local('2026-06-01T00:00:00'))?.price).toBe('65000');
  });

  test('multiple starts on the same day resolve to the latest one that has started', async () => {
    const item = await newItem();
    await addPrice({
      itemId: item.id,
      start: local('2026-05-01T08:00:00'),
      price: '10000',
    });
    await addPrice({
      itemId: item.id,
      start: local('2026-05-01T12:00:00'),
      price: '12000',
    });
    await addPrice({
      itemId: item.id,
      start: local('2026-05-01T18:30:00'),
      price: '9000',
    });
    expect(resolve(item.id, local('2026-05-01T07:59:59'))).toBeNull();
    expect(resolve(item.id, local('2026-05-01T11:59:59'))?.price).toBe('10000');
    expect(resolve(item.id, local('2026-05-01T12:00:00'))?.price).toBe('12000');
    expect(resolve(item.id, local('2026-05-01T18:29:59'))?.price).toBe('12000');
    expect(resolve(item.id, local('2026-05-01T23:59:59'))?.price).toBe('9000');
  });

  test('a future start does not change current resolution and is marked scheduled', async () => {
    const item = await newItem();
    await addPrice({
      itemId: item.id,
      start: local('2026-01-01T00:00:00'),
      price: '65000',
    });
    const now = toInstant(nowMs);
    const future = toInstant(nowMs + 30 * 24 * 3600 * 1000);
    const p = value(
      await preview({ itemId: item.id, start: future, price: '99000' }),
    );
    expect(p.timing).toBe('FUTURE');
    await addPrice({ itemId: item.id, start: future, price: '99000' });
    expect(resolve(item.id, now)?.price).toBe('65000');
    expect(resolve(item.id, future)?.price).toBe('99000');
    const states = (await timeline(item.id)).points.map((x) => [
      x.price,
      x.state,
    ]);
    expect(states).toEqual([
      ['65000', 'CURRENT'],
      ['99000', 'SCHEDULED'],
    ]);
  });

  test('resolvePrice requires a canonical instant and works for inactive items', async () => {
    const item = await newItem();
    await addPrice({
      itemId: item.id,
      start: local('2026-01-01T00:00:00'),
      price: '5000',
    });
    expect(() =>
      h.services.catalog.resolvePrice(item.id, bengkel, '2026-01-01 00:00:00'),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INSTANT' }));
    await newItem({ id: item.id, isActive: false });
    expect(resolve(item.id, toInstant(nowMs))?.price).toBe('5000');
  });

  test('the resolution query is served by an index', async () => {
    const plan = rows(
      `EXPLAIN QUERY PLAN SELECT id FROM catalog_item_prices
       WHERE catalog_item_id = ? AND channel_id = ? AND effective_start_at <= ?
         AND superseded_at IS NULL ORDER BY effective_start_at DESC LIMIT 1`,
      'a',
      'b',
      'c',
    )
      .map((r) => String(r.detail))
      .join(' ');
    expect(plan).toMatch(/USING (COVERING )?INDEX catalog_item_prices_/);
    expect(plan).not.toMatch(/USE TEMP B-TREE/);
  });
});

describe('preview and apply', () => {
  test('preview shows the effective price at the start, the successor and past/future, and stores nothing', async () => {
    const item = await newItem();
    await addPrice({
      itemId: item.id,
      start: local('2026-01-01T00:00:00'),
      price: '65000',
    });
    await addPrice({
      itemId: item.id,
      start: local('2026-06-01T00:00:00'),
      price: '80000',
    });
    const before = rows('SELECT * FROM catalog_item_prices');
    const p = value(
      await preview({
        itemId: item.id,
        start: local('2026-03-01T09:00:00'),
        price: '70000',
      }),
    );
    expect(p.current).toMatchObject({ price: '65000' });
    expect(p.successor).toMatchObject({
      price: '80000',
      effectiveStartAt: local('2026-06-01T00:00:00'),
    });
    expect(p.timing).toBe('PAST');
    expect(p.conflicts).toEqual([]);
    expect(p.corrects).toBeNull();
    expect(rows('SELECT * FROM catalog_item_prices')).toEqual(before);
  });

  test('identical start: preview reports PRICE_START_CONFLICT and apply is refused', async () => {
    const item = await newItem();
    const start = local('2026-03-10T14:00:00');
    await addPrice({ itemId: item.id, start, price: '70000' });
    const p = value(await preview({ itemId: item.id, start, price: '71000' }));
    expect(p.conflicts).toMatchObject([{ code: 'PRICE_START_CONFLICT' }]);
    expect(
      failure(await h.call(C.catalog.applyPriceChange, { token: p.token }))
        .code,
    ).toBe('PRICE_START_CONFLICT');
    expect(rows('SELECT id FROM catalog_item_prices')).toHaveLength(1);
    expect(resolve(item.id, start)?.price).toBe('70000');
  });

  test('a historical correction keeps the old revision, supersedes it and changes resolution', async () => {
    const item = await newItem();
    const start = local('2026-03-10T14:00:00');
    const wrong = (await addPrice({ itemId: item.id, start, price: '7000' }))
      .point;
    nowMs += 3600_000;
    const fixed = await addPrice({
      itemId: item.id,
      start,
      price: '70000',
      correctsPriceId: wrong.id,
      reason: 'Typo: missing a zero',
    });
    expect(fixed.supersededPriceId).toBe(wrong.id);
    expect(fixed.point).toMatchObject({
      supersedesPriceId: wrong.id,
      correctionReason: 'Typo: missing a zero',
      state: 'CURRENT',
    });
    expect(resolve(item.id, local('2026-04-01T00:00:00'))?.price).toBe('70000');

    const old = rows(
      'SELECT * FROM catalog_item_prices WHERE id = ?',
      wrong.id,
    )[0]!;
    expect(old.price).toBe(7000n);
    expect(old.effective_start_at).toBe(start);
    expect(old.superseded_at).toBe(toInstant(nowMs));
    const points = (await timeline(item.id)).points;
    const oldDto = points.find((x) => x.id === wrong.id)!;
    expect(oldDto).toMatchObject({
      state: 'SUPERSEDED',
      price: '7000',
      supersededByPriceId: fixed.point.id,
      supersededReason: 'Typo: missing a zero',
    });
  });

  test('a correction may move the start; the new start is still subject to uniqueness', async () => {
    const item = await newItem();
    const a = (
      await addPrice({
        itemId: item.id,
        start: local('2026-03-10T14:00:00'),
        price: '70000',
      })
    ).point;
    await addPrice({
      itemId: item.id,
      start: local('2026-03-11T00:00:00'),
      price: '75000',
    });
    const moved = await addPrice({
      itemId: item.id,
      start: local('2026-03-10T15:00:00'),
      price: '70000',
      correctsPriceId: a.id,
      reason: 'Started an hour later',
    });
    expect(resolve(item.id, local('2026-03-10T14:30:00'))).toBeNull();
    expect(resolve(item.id, local('2026-03-10T15:00:00'))?.priceId).toBe(
      moved.point.id,
    );
    // Moving onto another live point's start is a conflict.
    const clash = value(
      await preview({
        itemId: item.id,
        start: local('2026-03-11T00:00:00'),
        price: '1',
        correctsPriceId: moved.point.id,
        reason: 'x',
      }),
    );
    expect(clash.conflicts).toHaveLength(1);
    // The successor of a correction never includes the revision being replaced.
    const p = value(
      await preview({
        itemId: item.id,
        start: local('2026-03-09T00:00:00'),
        price: '1',
        correctsPriceId: moved.point.id,
        reason: 'x',
      }),
    );
    expect(p.successor?.effectiveStartAt).toBe(local('2026-03-11T00:00:00'));
  });

  test('correction validation: reason required, target must be live and match item/channel', async () => {
    const item = await newItem();
    const other = await newItem({ title: 'Kampas rem' });
    const start = local('2026-03-10T14:00:00');
    const a = (await addPrice({ itemId: item.id, start, price: '1000' })).point;
    const otherPoint = (
      await addPrice({ itemId: other.id, start, price: '1000' })
    ).point;
    const noReason = await preview({
      itemId: item.id,
      start,
      price: '2000',
      correctsPriceId: a.id,
    });
    expect(failure(noReason).code).toBe('CORRECTION_REASON_REQUIRED');
    for (const bad of [otherPoint.id, crypto.randomUUID()]) {
      const r = await preview({
        itemId: item.id,
        start,
        price: '2000',
        correctsPriceId: bad,
        reason: 'r',
      });
      expect(failure(r).code).toBe('PRICE_CORRECTION_TARGET_INVALID');
    }
    const wrongChannel = await preview({
      itemId: item.id,
      channelId: shopee,
      start,
      price: '2000',
      correctsPriceId: a.id,
      reason: 'r',
    });
    expect(failure(wrongChannel).code).toBe('PRICE_CORRECTION_TARGET_INVALID');
    await addPrice({
      itemId: item.id,
      start,
      price: '2000',
      correctsPriceId: a.id,
      reason: 'r',
    });
    const again = await preview({
      itemId: item.id,
      start,
      price: '3000',
      correctsPriceId: a.id,
      reason: 'r',
    });
    expect(failure(again).code).toBe('PRICE_CORRECTION_TARGET_INVALID');
  });

  test('temporary price = promo point plus a later restoring point', async () => {
    const item = await newItem();
    await addPrice({
      itemId: item.id,
      start: local('2026-01-01T00:00:00'),
      price: '65000',
    });
    await addPrice({
      itemId: item.id,
      start: local('2026-08-17T00:00:00'),
      price: '50000',
    });
    await addPrice({
      itemId: item.id,
      start: local('2026-08-18T00:00:00'),
      price: '65000',
    });
    expect(resolve(item.id, local('2026-08-17T12:00:00'))?.price).toBe('50000');
    expect(resolve(item.id, local('2026-08-18T00:00:00'))?.price).toBe('65000');
  });

  test('stale token: any change to the item/channel points after preview returns PRICE_PREVIEW_STALE', async () => {
    const item = await newItem();
    await addPrice({
      itemId: item.id,
      start: local('2026-01-01T00:00:00'),
      price: '65000',
    });
    const p = value(
      await preview({
        itemId: item.id,
        start: local('2026-05-01T00:00:00'),
        price: '70000',
      }),
    );
    await addPrice({
      itemId: item.id,
      start: local('2026-04-01T00:00:00'),
      price: '68000',
    });
    expect(
      failure(await h.call(C.catalog.applyPriceChange, { token: p.token }))
        .code,
    ).toBe('PRICE_PREVIEW_STALE');
    expect(rows('SELECT id FROM catalog_item_prices')).toHaveLength(2);
    // Another channel does not make it stale.
    const q = value(
      await preview({
        itemId: item.id,
        start: local('2026-05-01T00:00:00'),
        price: '70000',
      }),
    );
    await addPrice({
      itemId: item.id,
      channelId: shopee,
      start: local('2026-04-01T00:00:00'),
      price: '1',
    });
    value(await h.call(C.catalog.applyPriceChange, { token: q.token }));
  });

  test('unknown, expired and reused tokens return PRICE_PREVIEW_EXPIRED', async () => {
    const item = await newItem();
    expect(
      failure(
        await h.call(C.catalog.applyPriceChange, {
          token: crypto.randomUUID(),
        }),
      ).code,
    ).toBe('PRICE_PREVIEW_EXPIRED');
    const p = value(
      await preview({
        itemId: item.id,
        start: local('2026-05-01T00:00:00'),
        price: '1000',
      }),
    );
    nowMs += 10 * 60 * 1000 + 1;
    expect(
      failure(await h.call(C.catalog.applyPriceChange, { token: p.token }))
        .code,
    ).toBe('PRICE_PREVIEW_EXPIRED');
    const q = value(
      await preview({
        itemId: item.id,
        start: local('2026-05-01T00:00:00'),
        price: '1000',
      }),
    );
    value(await h.call(C.catalog.applyPriceChange, { token: q.token }));
    expect(
      failure(await h.call(C.catalog.applyPriceChange, { token: q.token }))
        .code,
    ).toBe('PRICE_PREVIEW_EXPIRED');
    expect(rows('SELECT id FROM catalog_item_prices')).toHaveLength(1);
  });

  test('price input: Rupiah string >= 0, no Number, no end field', async () => {
    const item = await newItem();
    const base = {
      catalogItemId: item.id,
      channelId: bengkel,
      effectiveStartAt: local('2026-05-01T00:00:00'),
    };
    for (const price of ['-1', '1.5', '01', '1e3', ' 5', '', 'abc']) {
      expect(
        failure(await h.call(C.catalog.previewPriceChange, { ...base, price }))
          .code,
      ).toBe('VALIDATION_FAILED');
    }
    expect(
      failure(
        await h.call(C.catalog.previewPriceChange, {
          ...base,
          price: '1',
          effectiveEndAt: local('2026-06-01T00:00:00'),
        }),
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      failure(
        await h.call(C.catalog.previewPriceChange, {
          ...base,
          price: '1',
          effectiveStartAt: '2026-05-01',
        }),
      ).code,
    ).toBe('VALIDATION_FAILED');
    // Free items and large values are fine and exact.
    const big = '9007199254740993';
    const p = await addPrice({
      itemId: item.id,
      start: base.effectiveStartAt,
      price: big,
    });
    expect(p.point.price).toBe(big);
    await addPrice({
      itemId: item.id,
      start: local('2026-05-02T00:00:00'),
      price: '0',
    });
    expect(resolve(item.id, local('2026-05-03T00:00:00'))?.price).toBe('0');
  });

  test('ADMIN only: CASHIER cannot preview or apply, and nothing is written', async () => {
    const item = await newItem();
    const p = value(
      await preview({
        itemId: item.id,
        start: local('2026-05-01T00:00:00'),
        price: '1000',
      }),
    );
    expect(
      failure(
        await preview(
          {
            itemId: item.id,
            start: local('2026-05-01T00:00:00'),
            price: '1000',
          },
          CASHIER,
        ),
      ).code,
    ).toBe('FORBIDDEN');
    expect(
      failure(
        await h.call(C.catalog.applyPriceChange, { token: p.token }, CASHIER),
      ).code,
    ).toBe('FORBIDDEN');
    expect(rows('SELECT id FROM catalog_item_prices')).toHaveLength(0);
    // The token is still good for the admin who previewed it.
    value(await h.call(C.catalog.applyPriceChange, { token: p.token }));
    // No session, no redemption.
    const unauthenticated = failure(
      await h.call(C.catalog.applyPriceChange, { token: p.token }, 99),
    );
    expect(unauthenticated.code).toBe('UNAUTHENTICATED');
  });

  test('inactive or unknown channel and unknown item are rejected', async () => {
    const item = await newItem();
    value(
      await h.call(C.references.deactivate, { entity: 'channel', id: shopee }),
    );
    const start = local('2026-05-01T00:00:00');
    expect(
      failure(
        await preview({
          itemId: item.id,
          channelId: shopee,
          start,
          price: '1',
        }),
      ).code,
    ).toBe('CHANNEL_INACTIVE');
    expect(
      failure(
        await preview({
          itemId: item.id,
          channelId: crypto.randomUUID(),
          start,
          price: '1',
        }),
      ).code,
    ).toBe('CHANNEL_NOT_FOUND');
    expect(
      failure(await preview({ itemId: crypto.randomUUID(), start, price: '1' }))
        .code,
    ).toBe('CATALOG_ITEM_NOT_FOUND');
  });

  test('audit rows carry old and new price, start and correction data', async () => {
    const item = await newItem();
    const start = local('2026-03-10T14:00:00');
    const first = (await addPrice({ itemId: item.id, start, price: '7000' }))
      .point;
    const second = (
      await addPrice({
        itemId: item.id,
        start: local('2026-04-10T14:00:00'),
        price: '8000',
      })
    ).point;
    const fixed = (
      await addPrice({
        itemId: item.id,
        start,
        price: '70000',
        correctsPriceId: first.id,
        reason: 'typo',
      })
    ).point;
    const audits = rows(
      "SELECT * FROM audit_log WHERE entity_type = 'catalog_item_price' ORDER BY id",
    );
    expect(audits.map((a) => a.action)).toEqual([
      'PRICE_POINT_ADDED',
      'PRICE_POINT_ADDED',
      'PRICE_POINT_CORRECTED',
    ]);
    const meta = audits.map(
      (a) => JSON.parse(String(a.metadata)) as Record<string, unknown>,
    );
    expect(meta[0]).toMatchObject({
      newPrice: '7000',
      oldPrice: null,
      effectiveStartAt: start,
    });
    expect(meta[1]).toMatchObject({
      newPrice: '8000',
      oldPrice: '7000',
      oldPriceId: first.id,
    });
    expect(meta[2]).toMatchObject({
      newPrice: '70000',
      oldPrice: '7000',
      correctsPriceId: first.id,
      correctedPrice: '7000',
      correctedStartAt: start,
      reason: 'typo',
      effectiveStartAt: start,
    });
    expect(audits[2]!.entity_id).toBe(fixed.id);
    expect(audits[1]!.entity_id).toBe(second.id);
    expect(audits[2]!.cashier_id).toBeTruthy();
  });

  test('no price-change path updates an existing point price or start', async () => {
    const item = await newItem();
    const start = local('2026-03-10T14:00:00');
    const a = (await addPrice({ itemId: item.id, start, price: '7000' })).point;
    await addPrice({
      itemId: item.id,
      start: local('2026-04-01T00:00:00'),
      price: '8000',
    });
    await addPrice({
      itemId: item.id,
      start,
      price: '7500',
      correctsPriceId: a.id,
      reason: 'r',
    });
    // Every original point is still there with its price and start intact.
    const original = rows(
      'SELECT price, effective_start_at FROM catalog_item_prices WHERE id = ?',
      a.id,
    )[0]!;
    expect(original).toMatchObject({ price: 7000n, effective_start_at: start });
    // And the source never issues such an UPDATE.
    const dir = path.resolve(__dirname, '../../src/main/features/catalog');
    for (const file of [
      'price-repository.ts',
      'pricing.ts',
      'service.ts',
      'repository.ts',
    ]) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      for (const update of text.matchAll(
        /UPDATE\s+catalog_item_prices\s+SET([^`'"]*)/gi,
      )) {
        expect(update[1]).toMatch(/superseded_at/);
        expect(update[1]).not.toMatch(/\bprice\s*=|effective_start_at\s*=/);
      }
    }
  });
});

describe('price table shape and triggers', () => {
  test('the price table has no end-timestamp column of any kind', () => {
    const columns = rows('PRAGMA table_info(catalog_item_prices)').map((c) =>
      String(c.name),
    );
    expect(columns).toContain('effective_start_at');
    expect(columns.filter((name) => /end/i.test(name))).toEqual([]);
  });

  test('immutability triggers reject UPDATE of price/start/etc. and any DELETE', async () => {
    const item = await newItem();
    const a = (
      await addPrice({
        itemId: item.id,
        start: local('2026-03-10T14:00:00'),
        price: '7000',
      })
    ).point;
    const update = (set: string, ...params: unknown[]) =>
      h.db
        .prepare(`UPDATE catalog_item_prices SET ${set} WHERE id = ?`)
        .run(...params, a.id);
    expect(() => update('price = ?', 1n)).toThrow(/append-only/);
    expect(() =>
      update('effective_start_at = ?', local('2026-03-11T00:00:00')),
    ).toThrow(/append-only/);
    expect(() => update('channel_id = ?', shopee)).toThrow(/append-only/);
    expect(() => update('catalog_item_id = ?', item.id)).not.toThrow();
    expect(() => update('created_at = ?', toInstant(0))).toThrow(/append-only/);
    expect(() => update('correction_reason = ?', 'x')).toThrow(/append-only/);
    expect(() =>
      h.db.prepare('DELETE FROM catalog_item_prices WHERE id = ?').run(a.id),
    ).toThrow(/append-only/);
    const admin = rows('SELECT id FROM cashiers LIMIT 1')[0]!.id;
    // superseded_* can move NULL -> value once, and only as a pair.
    expect(() => update('superseded_at = ?', toInstant(nowMs))).toThrow(
      /CHECK/,
    );
    expect(() =>
      update(
        'superseded_at = ?, superseded_by_cashier_id = ?',
        toInstant(nowMs),
        admin,
      ),
    ).not.toThrow();
    expect(() =>
      update(
        'superseded_at = ?, superseded_by_cashier_id = ?',
        toInstant(nowMs + 1),
        admin,
      ),
    ).toThrow(/append-only/);
    expect(() =>
      update('superseded_at = NULL, superseded_by_cashier_id = NULL'),
    ).toThrow(/append-only/);
  });

  test('non-canonical instants, non-IDR currency, negative price are rejected by the schema', async () => {
    const item = await newItem();
    const admin = rows('SELECT id FROM cashiers LIMIT 1')[0]!.id;
    const insert = (start: string, currency: string, price: bigint) =>
      h.db
        .prepare(
          `INSERT INTO catalog_item_prices (id, catalog_item_id, channel_id, effective_start_at, currency, price, created_at, created_by_cashier_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          item.id,
          bengkel,
          start,
          currency,
          price,
          toInstant(nowMs),
          admin,
        );
    expect(() => insert('2026-03-10 14:00:00', 'IDR', 1n)).toThrow(/CHECK/);
    expect(() => insert('2026-03-10T14:00:00Z', 'IDR', 1n)).toThrow(/CHECK/);
    expect(() => insert(local('2026-03-10T14:00:00'), 'USD', 1n)).toThrow(
      /CHECK/,
    );
    expect(() => insert(local('2026-03-10T14:00:00'), 'IDR', -1n)).toThrow(
      /CHECK/,
    );
    expect(() => insert(local('2026-03-10T14:00:00'), 'IDR', 1n)).not.toThrow();
    // The partial unique index guards direct inserts too.
    expect(() => insert(local('2026-03-10T14:00:00'), 'IDR', 2n)).toThrow(
      /UNIQUE/,
    );
  });
});

describe('catalog items', () => {
  test('ADMIN creates items with defaults; CASHIER is forbidden; audited', async () => {
    const stock = await newItem({
      sku: 'MPX2-08',
      weight: 800,
      description: 'Oli',
    });
    expect(stock).toMatchObject({
      type: 'STOCK_ITEM',
      trackInventory: true,
      isActive: true,
      sku: 'MPX2-08',
      weight: 800,
      unitCode: 'PCS',
      barcodes: [],
    });
    const service = await newItem({ type: 'SERVICE', title: 'Ganti oli' });
    expect(service.trackInventory).toBe(false);
    const untracked = await newItem({ title: 'Baut', trackInventory: false });
    expect(untracked.trackInventory).toBe(false);
    expect(
      failure(
        await h.call(
          C.catalog.save,
          { type: 'STOCK_ITEM', title: 'x', unitId: pcs },
          CASHIER,
        ),
      ).code,
    ).toBe('FORBIDDEN');
    expect(
      failure(
        await h.call(C.catalog.save, {
          type: 'SERVICE',
          title: 'x',
          unitId: pcs,
          trackInventory: true,
        }),
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      rows(
        "SELECT action FROM audit_log WHERE action LIKE 'CATALOG_ITEM_%'",
      ).map((r) => r.action),
    ).toEqual([
      'CATALOG_ITEM_CREATED',
      'CATALOG_ITEM_CREATED',
      'CATALOG_ITEM_CREATED',
    ]);
  });

  test('changing a stock item to a service forces trackInventory off; the schema also refuses tracked services', async () => {
    const item = await newItem();
    const service = await newItem({ id: item.id, type: 'SERVICE' });
    expect(service.trackInventory).toBe(false);
    expect(() =>
      h.db
        .prepare('UPDATE catalog_items SET track_inventory = 1 WHERE id = ?')
        .run(item.id),
    ).toThrow(/CHECK/);
  });

  test('the unit must exist and be active', async () => {
    expect(
      failure(
        await h.call(C.catalog.save, {
          type: 'STOCK_ITEM',
          title: 'x',
          unitId: crypto.randomUUID(),
        }),
      ).code,
    ).toBe('UNIT_NOT_FOUND');
    value(await h.call(C.references.deactivate, { entity: 'unit', id: pcs }));
    expect(
      failure(
        await h.call(C.catalog.save, {
          type: 'STOCK_ITEM',
          title: 'x',
          unitId: pcs,
        }),
      ).code,
    ).toBe('UNIT_INACTIVE');
  });

  test('duplicate SKU (case-insensitive) is rejected; the item keeps its own SKU on edit', async () => {
    const a = await newItem({ sku: 'ABC-1' });
    expect(
      failure(
        await h.call(C.catalog.save, {
          type: 'STOCK_ITEM',
          title: 'Other',
          unitId: pcs,
          sku: 'abc-1',
        }),
      ).code,
    ).toBe('DUPLICATE_SKU');
    await newItem({ id: a.id, sku: 'ABC-1', title: 'Renamed' });
    await newItem({ title: 'No sku 1' });
    await newItem({ title: 'No sku 2' });
    expect(rows('SELECT id FROM catalog_items')).toHaveLength(3);
  });

  test('the tracking-change hook runs when an existing item changes trackInventory', async () => {
    const item = await newItem();
    const seen: unknown[] = [];
    h.services.catalog.setTrackingChangeGuard((change) => {
      seen.push(change);
      throw Object.assign(new Error('blocked'), { code: 'X' });
    });
    await newItem({ id: item.id, title: 'Renamed' });
    expect(seen).toHaveLength(0);
    const blocked = await h.call(C.catalog.save, {
      id: item.id,
      type: 'STOCK_ITEM',
      title: 'Oli',
      unitId: pcs,
      trackInventory: false,
    });
    expect(blocked.ok).toBe(false);
    expect(seen).toEqual([{ itemId: item.id, from: true, to: false }]);
    expect(
      rows('SELECT track_inventory FROM catalog_items')[0]!.track_inventory,
    ).toBe(1n);
  });

  test('items cannot be deleted', async () => {
    const item = await newItem();
    expect(() =>
      h.db.prepare('DELETE FROM catalog_items WHERE id = ?').run(item.id),
    ).toThrow(/cannot be deleted/);
  });
});

describe('barcodes', () => {
  const save = (catalogItemId: string, barcodes: unknown[], windowId = ADMIN) =>
    h.call<CatalogItemDto>(
      C.catalog.saveBarcodes,
      { catalogItemId, barcodes },
      windowId,
    );

  test('barcodes are trimmed, kept textual (leading zeros) and multiple per item', async () => {
    const item = await newItem();
    const saved = value(
      await save(item.id, [
        { barcode: '  0012345678905 ', isActive: true },
        { barcode: 'ABC-001', isActive: true },
      ]),
    );
    expect(saved.barcodes.map((b) => b.barcode)).toEqual([
      '0012345678905',
      'ABC-001',
    ]);
    expect(
      typeof rows('SELECT barcode FROM catalog_item_barcodes')[0]!.barcode,
    ).toBe('string');
  });

  test('a barcode of another item is rejected naming the owner; nothing is partially saved', async () => {
    const a = await newItem({ title: 'Oli MPX2' });
    const b = await newItem({ title: 'Kampas rem' });
    value(await save(a.id, [{ barcode: '111', isActive: true }]));
    const result = await save(b.id, [
      { barcode: '222', isActive: true },
      { barcode: '111', isActive: true },
    ]);
    const error = failure(result);
    expect(error.code).toBe('DUPLICATE_BARCODE');
    expect(error.params).toEqual({ barcode: '111', owner: 'Oli MPX2' });
    expect(rows('SELECT barcode FROM catalog_item_barcodes')).toHaveLength(1);
    // An inactive barcode still belongs to its item.
    value(await save(a.id, [{ barcode: '111', isActive: false }]));
    expect(
      failure(await save(b.id, [{ barcode: '111', isActive: true }])).code,
    ).toBe('DUPLICATE_BARCODE');
  });

  test('deactivate and reactivate, never delete; duplicates in one request and CASHIER are refused', async () => {
    const item = await newItem();
    value(await save(item.id, [{ barcode: '111', isActive: true }]));
    const off = value(
      await save(item.id, [{ barcode: '111', isActive: false }]),
    );
    expect(off.barcodes).toMatchObject([{ barcode: '111', isActive: false }]);
    const on = value(await save(item.id, [{ barcode: '111', isActive: true }]));
    expect(on.barcodes).toHaveLength(1);
    expect(on.barcodes[0]!.isActive).toBe(true);
    expect(
      failure(
        await save(item.id, [
          { barcode: '9', isActive: true },
          { barcode: '9', isActive: false },
        ]),
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      failure(await save(item.id, [{ barcode: '  ', isActive: true }])).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      failure(await save(item.id, [{ barcode: '5', isActive: true }], CASHIER))
        .code,
    ).toBe('FORBIDDEN');
    expect(() =>
      h.db.prepare('DELETE FROM catalog_item_barcodes').run(),
    ).toThrow(/cannot be deleted/);
    expect(
      rows(
        "SELECT action FROM audit_log WHERE action = 'CATALOG_BARCODES_UPDATED'",
      ),
    ).toHaveLength(3);
  });

  test('lookup: any session gets the item; unknown, inactive barcode and inactive item are typed errors', async () => {
    const item = await newItem({ title: 'Oli MPX2' });
    value(
      await h.call(C.catalog.saveBarcodes, {
        catalogItemId: item.id,
        barcodes: [
          { barcode: '0099', isActive: true },
          { barcode: '0100', isActive: false },
        ],
      }),
    );
    const found = value(
      await h.call<CatalogItemDto>(
        C.catalog.lookupBarcode,
        { code: ' 0099\n' },
        CASHIER,
      ),
    );
    expect(found.id).toBe(item.id);
    const lookup = async (code: string) =>
      failure(await h.call(C.catalog.lookupBarcode, { code }, CASHIER)).code;
    expect(await lookup('99')).toBe('UNKNOWN_BARCODE');
    expect(await lookup('')).toBe('UNKNOWN_BARCODE');
    expect(await lookup('0100')).toBe('BARCODE_INACTIVE');
    await newItem({ id: item.id, title: 'Oli MPX2', isActive: false });
    expect(await lookup('0099')).toBe('CATALOG_ITEM_INACTIVE');
    // Unknown barcodes never create items.
    expect(rows('SELECT id FROM catalog_items')).toHaveLength(1);
    expect(
      failure(await h.call(C.catalog.lookupBarcode, { code: '0099' }, 99)).code,
    ).toBe('UNAUTHENTICATED');
  });
});

describe('search', () => {
  test('matches title substring, SKU and barcode; hides inactive by default; escapes wildcards; capped', async () => {
    const oli = await newItem({ title: 'Oli MPX2 0.8L', sku: 'OLI-MPX2' });
    const busi = await newItem({ title: 'Busi NGK', sku: 'BUSI-1' });
    const off = await newItem({ title: 'Oli lama', isActive: false });
    value(
      await h.call(C.catalog.saveBarcodes, {
        catalogItemId: busi.id,
        barcodes: [{ barcode: '8991234000', isActive: true }],
      }),
    );
    const search = async (
      query: string,
      extra: Record<string, unknown> = {},
      w = CASHIER,
    ) =>
      value(
        await h.call<SearchCatalogResult>(
          C.catalog.search,
          { query, ...extra },
          w,
        ),
      ).results.map((r) => r.id);
    expect(await search('mpx')).toEqual([oli.id]);
    expect(await search('busi-1')).toEqual([busi.id]);
    expect(await search('899123')).toEqual([busi.id]);
    expect(await search('oli')).toEqual([oli.id]);
    expect(await search('oli', { includeInactive: true })).toEqual([
      off.id,
      oli.id,
    ]);
    expect(await search('%')).toEqual([]);
    expect(await search('0.8L')).toEqual([oli.id]);
    expect(await search('')).toEqual([busi.id, oli.id]);
    for (let i = 0; i < 60; i += 1) await newItem({ title: `Filler ${i}` });
    expect((await search('Filler', {}, ADMIN)).length).toBe(25);
    expect((await search('Filler', { limit: 50 })).length).toBe(50);
    expect(
      failure(await h.call(C.catalog.search, { query: 'x', limit: 51 })).code,
    ).toBe('VALIDATION_FAILED');
  });
});

describe('timeline reads', () => {
  test('CASHIER may view prices; superseded history and states are reported', async () => {
    const item = await newItem();
    await addPrice({
      itemId: item.id,
      start: local('2026-01-01T00:00:00'),
      price: '1000',
    });
    await addPrice({
      itemId: item.id,
      start: local('2026-02-01T00:00:00'),
      price: '2000',
    });
    const view = await timeline(item.id, CASHIER);
    expect(view.timezone).toBe(ZONE);
    expect(view.points.map((p) => [p.price, p.state])).toEqual([
      ['1000', 'PREVIOUS'],
      ['2000', 'CURRENT'],
    ]);
    expect(
      failure(
        await h.call(C.catalog.listPrices, {
          catalogItemId: crypto.randomUUID(),
        }),
      ).code,
    ).toBe('CATALOG_ITEM_NOT_FOUND');
  });
});
