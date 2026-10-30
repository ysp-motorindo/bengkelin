import type { DraftLineDto } from '@/shared/contracts';
const LINE_ID = '6e9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11';
export function customLine(): DraftLineDto {
  return {
    priceEntryConfirmed: true,
    id: LINE_ID,
    position: 1,
    source: 'CUSTOM',
    catalogItemId: null,
    adHocItemReferenceId: null,
    itemType: 'SERVICE',
    title: 'Servis CVT',
    unitId: null,
    unitLabel: null,
    mechanicId: null,
    mechanicName: null,
    quantity: 1,
    listedUnitPrice: null,
    unitPrice: '50000',
    subtotal: '50000',
    discountAmount: '0',
    amount: '50000',
    discounts: [],
    pricing: {} as DraftLineDto['pricing'],
    priceChanges: [],
    createdAt: '2026-09-30T03:00:00.000Z',
    updatedAt: '2026-09-30T03:00:00.000Z',
  };
}
