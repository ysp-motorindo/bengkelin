import type { DraftOperationData } from '@/shared/contracts';
import type { OperationContext } from './context';
import {
  setCheckoutAllocations,
  setInvoiceDiscounts,
  updateHeader,
} from './header-operations';
import {
  addCatalogLine,
  addCustomLine,
  removeLine,
  setLineDiscounts,
  updateLine,
} from './line-operations';
import { applyPriceRefresh } from './price-refresh';

/** Every operation except `discard`, which DraftService handles itself. */
export type EditOperation = Exclude<
  DraftOperationData,
  { kind: 'discard' | 'reserveInvoiceNumber' }
>;

/** Applies one edit to the draft's rows. Totals are recomputed afterwards. */
export function runOperation(ctx: OperationContext, op: EditOperation): void {
  switch (op.kind) {
    case 'updateHeader':
      return updateHeader(ctx, op);
    case 'addCatalogLine':
      return addCatalogLine(ctx, op);
    case 'addCustomLine':
      return addCustomLine(ctx, op);
    case 'updateLine':
      return updateLine(ctx, op);
    case 'removeLine':
      return removeLine(ctx, op);
    case 'setLineDiscounts':
      return setLineDiscounts(ctx, op);
    case 'setInvoiceDiscounts':
      return setInvoiceDiscounts(ctx, op);
    case 'setCheckoutAllocations':
      return setCheckoutAllocations(ctx, op);
    case 'applyPriceRefresh':
      return applyPriceRefresh(ctx, op);
    default: {
      const unknownOp: never = op;
      throw new Error(`Unhandled draft operation ${String(unknownOp)}`);
    }
  }
}
