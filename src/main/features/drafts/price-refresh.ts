import { bool } from '@/main/database/rows';
import type { PriceRefreshProposalDto } from '@/shared/contracts';
import { DomainError, formatRupiah, parseRupiah } from '@/shared/primitives';
import {
  recordPriceChange,
  requireLine,
  type DraftOp as Op,
  type OperationContext,
} from './context';
import type { DraftRepository, InvoiceRow } from './repository';
import type { ResolvePrice } from './view';

/**
 * Read-only: for every live catalog line, what the draft's CURRENT channel
 * and pricingAt resolve to, when that would change the line (another price
 * point, another price, or a manual override that a refresh would reset).
 * Lines with no configured price now are not proposed.
 */
export function priceRefreshProposals(
  repo: DraftRepository,
  resolvePrice: ResolvePrice,
  invoice: InvoiceRow,
): PriceRefreshProposalDto[] {
  const proposals: PriceRefreshProposalDto[] = [];
  for (const line of repo.liveLines(invoice.id)) {
    if (line.catalog_item_id === null) continue;
    const resolved = resolvePrice(
      line.catalog_item_id,
      invoice.channel_id,
      invoice.pricing_at,
    );
    if (!resolved) continue;
    const manual = bool(line.manual_price_override);
    if (
      resolved.priceId === line.resolved_price_id &&
      parseRupiah(resolved.price) === line.unit_price &&
      !manual
    ) {
      continue;
    }
    proposals.push({
      lineId: line.id,
      title: line.title_snapshot,
      currentUnitPrice: formatRupiah(line.unit_price),
      proposedUnitPrice: resolved.price,
      resolvedPriceId: resolved.priceId,
      currentResolvedPriceId: line.resolved_price_id,
      manualPriceOverride: manual,
    });
  }
  return proposals;
}

/**
 * Applies the proposals the cashier selected. Each is re-resolved here, in
 * the write transaction; if any no longer matches the preview the whole
 * command fails with DRAFT_PRICE_REFRESH_STALE and nothing changes. Every
 * applied line records a PRICE_REFRESH change and loses its manual flag.
 */
export function applyPriceRefresh(
  ctx: OperationContext,
  op: Op<'applyPriceRefresh'>,
): void {
  const { invoice } = ctx;
  const applied: { lineId: string; previousPrice: string; newPrice: string }[] =
    [];
  for (const entry of op.lines) {
    const line = requireLine(ctx, entry.lineId);
    const resolved =
      line.catalog_item_id === null
        ? null
        : ctx.catalog.resolvePrice(
            line.catalog_item_id,
            invoice.channel_id,
            invoice.pricing_at,
          );
    if (
      !resolved ||
      resolved.priceId !== entry.resolvedPriceId ||
      resolved.price !== entry.proposedUnitPrice
    ) {
      throw new DomainError(
        'DRAFT_PRICE_REFRESH_STALE',
        'Prices changed since the preview',
      );
    }
    const price = parseRupiah(resolved.price);
    ctx.repo.setPrice(
      line.id,
      line.quantity,
      {
        unitPrice: price,
        listedUnitPrice: price,
        resolvedPriceId: resolved.priceId,
        priceResolvedAt: invoice.pricing_at,
        manualPriceOverride: false,
      },
      ctx.now,
    );
    recordPriceChange(ctx, {
      lineId: line.id,
      kind: 'PRICE_REFRESH',
      previousPrice: line.unit_price,
      newPrice: price,
      reason: null,
    });
    applied.push({
      lineId: line.id,
      previousPrice: line.unit_price.toString(),
      newPrice: resolved.price,
    });
  }
  ctx.audit('DRAFT_PRICES_REFRESHED', {
    channelId: invoice.channel_id,
    pricingAt: invoice.pricing_at,
    lines: applied,
  });
}
