import { vi } from 'vitest';
import type {
  CreateDraftInput,
  DraftCommand,
  DraftView,
  ReferenceDto,
  SearchCatalogResult,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const DRAFT_ID = '7d8f5a3e-1c2b-4a55-9c5b-0a8f3f0b9d11';
const CHANNEL: ReferenceDto = {
  entity: 'channel',
  id: '1b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11',
  label: 'Bengkel',
  code: 'BENGKEL',
  phoneNumber: null,
  brandId: null,
  isActive: true,
};

export function draftView(extra: Partial<DraftView> = {}): DraftView {
  return {
    id: DRAFT_ID,
    status: 'DRAFT',
    version: 1,
    channelId: CHANNEL.id,
    channelLabel: CHANNEL.label,
    invoiceDate: '2026-09-30',
    pricingAt: '2026-09-30T03:00:00.000Z',
    topDays: 0,
    dueDate: '2026-09-30',
    customer: null,
    vehicle: null,
    ownerMismatch: false,
    odometerKm: null,
    note: null,
    lines: [],
    invoiceDiscounts: [],
    checkoutAllocations: [],
    totals: {
      subtotal: '0',
      itemDiscountAmount: '0',
      invoiceDiscountAmount: '0',
      discountAmount: '0',
      amount: '0',
      allocatedAmount: '0',
      unallocatedAmount: '0',
    },
    allocationsExceedAmount: false,
    createdBy: { id: 'a', displayName: 'Siti' },
    lastEditedBy: { id: 'a', displayName: 'Siti' },
    createdAt: '2026-09-30T03:00:00.000Z',
    updatedAt: '2026-09-30T03:00:00.000Z',
    discardedAt: null,
    ...extra,
  };
}

/**
 * The bridge methods the cashier workspace calls on mount, with a draft
 * that bumps its version on every apply. Merge into a test's own bridge.
 */
export function workspaceBridge() {
  let current = draftView();
  const apply = vi.fn(async (command: DraftCommand) => {
    current = { ...current, version: current.version + 1 };
    void command;
    return ok(current);
  });
  return {
    settings: {
      getShop: vi.fn(async () =>
        ok({
          name: 'Bengkel',
          address: 'Jl. A',
          phoneNumber: null,
          email: null,
          invoiceFooter: null,
          timezone: 'Asia/Jakarta',
        }),
      ),
    },
    references: {
      listActive: vi.fn(async ({ entity }: { entity: string }) =>
        ok(entity === 'channel' ? [CHANNEL] : []),
      ),
    },
    catalog: {
      search: vi.fn(async () => ok<SearchCatalogResult>({ results: [] })),
      lookupBarcode: vi.fn(),
    },
    drafts: {
      list: vi.fn(async () => ok([])),
      create: vi.fn(async (_input: CreateDraftInput) => ok(current)),
      get: vi.fn(async () => ok(current)),
      apply,
      previewPriceRefresh: vi.fn(),
    },
    adHocReferences: { search: vi.fn(async () => ok({ results: [] })) },
  };
}
