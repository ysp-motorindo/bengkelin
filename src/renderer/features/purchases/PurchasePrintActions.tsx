import { useMemo } from 'react';
import { PrintActions } from '@/renderer/features/printing/PrintActions';
import type { PrintClient } from '@/renderer/features/printing/print-client';
import type { PurchasePrintInput } from '@/shared/contracts';
const A4_ONLY = ['A4'] as const;
export function PurchasePrintActions({
  purchaseId,
  documentId,
  documentType,
  active,
  autoPrint = false,
}: {
  purchaseId: string;
  documentId: string;
  documentType: PurchasePrintInput['documentType'];
  active: boolean;
  autoPrint?: boolean;
}) {
  const client = useMemo<PrintClient>(
    () => ({
      getOptions: async () => {
        const r = await window.bengkelin.printing.getOptions();
        return documentType === 'BILL' || !r.ok
          ? r
          : {
              ok: true,
              value: {
                ...r.value,
                defaultInvoiceFormat: 'A4',
                autoPrintAfterFinalize: false,
              },
            };
      },
      preview: ({ format }) =>
        window.bengkelin.purchasePrinting.preview({
          purchaseId,
          documentId,
          documentType,
          format,
        }),
      print: ({ format }) =>
        window.bengkelin.purchasePrinting.print({
          purchaseId,
          documentId,
          documentType,
          format,
        }),
      exportPdf: () =>
        window.bengkelin.purchasePrinting.exportPdf({
          purchaseId,
          documentId,
          documentType,
          format: 'A4',
        }),
    }),
    [purchaseId, documentId, documentType],
  );
  return (
    <PrintActions
      invoiceId={documentId}
      client={client}
      registerTarget={active && documentType === 'BILL'}
      autoPrint={autoPrint && active}
      {...(documentType === 'BILL'
        ? {}
        : { formats: A4_ONLY, size: 'sm' as const })}
    />
  );
}
