import { describe, expect, test } from 'vitest';
import {
  partyFacts,
  headerFacts,
} from '@/main/features/printing/templates/shared';
import { PRINT_LABELS } from '@/main/features/printing/templates/labels';
import type { InvoicePrintModel } from '@/shared/contracts';

describe.each(['id', 'en'] as const)(
  'optional print references %s',
  (language) => {
    test.each([
      [null, null],
      ['Sales', null],
      [null, 'Carrier'],
      ['Sales', 'Carrier'],
    ])('independently omits blanks (%s, %s)', (salesName, expeditionName) => {
      const model = {
        salesName,
        expeditionName,
        customer: null,
        vehicle: null,
        odometerKm: null,
      } as unknown as InvoicePrintModel;
      const labels = PRINT_LABELS[language];
      const facts = partyFacts(model, labels);
      expect(facts).toEqual([
        ...(salesName ? [[labels.sales, salesName]] : []),
        ...(expeditionName ? [[labels.expedition, expeditionName]] : []),
      ]);
    });
  },
);

test('every printed header includes frozen location code and label', () => {
  const model = {
    invoiceNumber: 'INV-1',
    invoiceDate: '2026-09-30',
    finalizedAtLocal: '2026-09-30 10:00',
    topDays: 0,
    dueDate: '2026-09-30',
    channel: 'Retail',
    cashier: 'Staff',
    stockLocation: { id: 'A', code: '01', label: 'Original depot' },
  } as InvoicePrintModel;
  expect(headerFacts(model, PRINT_LABELS.en)).toContainEqual([
    'Stock location',
    '01 · Original depot',
  ]);
  expect(headerFacts(model, PRINT_LABELS.id)).toContainEqual([
    'Lokasi stok',
    '01 · Original depot',
  ]);
});
