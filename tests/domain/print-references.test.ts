import { describe, expect, test } from 'vitest';
import { partyFacts } from '@/main/features/printing/templates/shared';
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
