import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { PurchasePrintActions } from '@/renderer/features/purchases/PurchasePrintActions';
test('receipt printing offers A4 and sends the receipt identity to the purchase API', async () => {
  const print = vi.fn(async () => ({
    ok: true,
    value: { outcome: 'PRINTED', format: 'A4', isReprint: false },
  }));
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    app: { setMenuContext: async () => ({ ok: true }) },
    printing: {
      getOptions: async () => ({
        ok: true,
        value: {
          defaultInvoiceFormat: 'THERMAL',
          thermalFormat: 'THERMAL_58',
          autoPrintAfterFinalize: false,
        },
      }),
    },
    purchasePrinting: { print },
  };
  render(
    <PurchasePrintActions
      purchaseId="p"
      documentId="r"
      documentType="RECEIPT"
      active={true}
    />,
  );
  expect(
    screen.queryByRole('button', { name: 'Cetak Termal' }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Cetak A4' }));
  await waitFor(() =>
    expect(print).toHaveBeenCalledWith({
      purchaseId: 'p',
      documentId: 'r',
      documentType: 'RECEIPT',
      format: 'A4',
    }),
  );
});

test('native Print targets the receipt currently shown in a preview', async () => {
  const { runPrintTarget } =
    await import('@/renderer/features/printing/print-target');
  const { act } = await import('@testing-library/react');
  const print = vi.fn(async () => ({
    ok: true,
    value: { outcome: 'PRINTED', format: 'A4', isReprint: false },
  }));
  (window as unknown as { bengkelin: unknown }).bengkelin = {
    app: { setMenuContext: async () => ({ ok: true }) },
    printing: {
      getOptions: async () => ({
        ok: true,
        value: {
          defaultInvoiceFormat: 'A4',
          thermalFormat: 'THERMAL_58',
          autoPrintAfterFinalize: false,
        },
      }),
    },
    purchasePrinting: {
      print,
      preview: async () => ({
        ok: true,
        value: {
          html: '<!doctype html><html><body>Receipt</body></html>',
          format: 'A4',
          pageInfo: {
            format: 'A4',
            widthMm: 210,
            heightMm: 297,
            printableWidthMm: 190,
            paginated: true,
          },
        },
      }),
    },
  };
  render(
    <PurchasePrintActions
      purchaseId="p"
      documentId="r"
      documentType="RECEIPT"
      active={true}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Pratinjau' }));
  await screen.findByRole('dialog');
  await act(async () => {
    await runPrintTarget();
  });
  await waitFor(() =>
    expect(print).toHaveBeenCalledWith({
      purchaseId: 'p',
      documentId: 'r',
      documentType: 'RECEIPT',
      format: 'A4',
    }),
  );
});
