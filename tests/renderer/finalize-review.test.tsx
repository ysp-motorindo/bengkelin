import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { CheckoutReviewDialog } from '@/renderer/features/workspace/checkout/CheckoutReviewDialog';
import type { FinalizeClient } from '@/renderer/features/workspace/checkout/finalize-client';
import type {
  FinalizeInput,
  FinalizePreviewDto,
  InvoiceView,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
import { DRAFT_ID, draftView, ok } from './helpers/workspace-bridge';

const ITEM_ID = '2b1c7a3e-1c2b-4a55-9c5b-0a8f3f0b9d22';

function preview(extra: Partial<FinalizePreviewDto> = {}): FinalizePreviewDto {
  return {
    invoiceId: DRAFT_ID,
    draftVersion: 3,
    totals: {
      subtotal: '145000',
      itemDiscountAmount: '0',
      invoiceDiscountAmount: '0',
      discountAmount: '0',
      amount: '145000',
      checkoutPaymentAmount: '100000',
      outstandingAmount: '45000',
    },
    checkoutPayments: [
      { method: 'CASH', amount: '60000', reference: null, note: null },
      { method: 'QRIS', amount: '40000', reference: null, note: null },
    ],
    paymentStatusAfterCheckout: 'PARTIALLY_PAID',
    errors: [],
    warnings: [],
    ...extra,
  };
}

const negative = (observedStock: number) => ({
  code: 'NEGATIVE_STOCK' as const,
  params: {
    catalogItemId: ITEM_ID,
    title: 'Kampas Rem',
    observedStock,
    demand: 3,
    resultingStock: observedStock - 3,
  },
});

const invoice = {
  id: DRAFT_ID,
  invoiceNumber: 'INV-20260930-0001',
  status: 'FINALIZED',
  totals: { amount: '145000' },
  paymentStatus: 'PARTIALLY_PAID',
} as unknown as InvoiceView;

function client(
  previews: FinalizePreviewDto[],
  finalizeResults: (Result<InvoiceView> | Error)[],
) {
  const previewFinalize = vi.fn(async () => ok(previews.shift()!));
  const finalize = vi.fn(async (_input: FinalizeInput) => {
    const next = finalizeResults.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  return { previewFinalize, finalize } satisfies FinalizeClient;
}

function renderReview(finalizer: FinalizeClient) {
  const onNewTransaction = vi.fn();
  const onClose = vi.fn();
  render(
    <CheckoutReviewDialog
      view={draftView({ version: 3 })}
      finalizer={finalizer}
      onClose={onClose}
      onNewTransaction={onNewTransaction}
    />,
  );
  return { onNewTransaction, onClose };
}

describe('checkout review and finalization', () => {
  test('shows the derived status, finalizes with the preview acknowledgement and offers New Transaction', async () => {
    const finalizer = client([preview()], [ok(invoice)]);
    const { onNewTransaction } = renderReview(finalizer);
    const user = userEvent.setup();
    expect(
      await screen.findByTestId('review-payment-status'),
    ).toHaveTextContent('Dibayar sebagian');
    await user.click(screen.getByRole('button', { name: 'Finalisasi' }));
    expect(finalizer.finalize).toHaveBeenCalledWith({
      requestId: expect.any(String),
      invoiceId: DRAFT_ID,
      expectedVersion: 3,
      acknowledgedWarnings: [],
    });
    const done = await screen.findByRole('dialog', { name: 'Faktur final' });
    expect(screen.getByTestId('finalized-invoice-number')).toHaveTextContent(
      'INV-20260930-0001',
    );
    expect(
      screen.getByRole('button', { name: 'Cetak Thermal' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cetak A4' })).toBeDisabled();
    const next = screen.getByRole('button', { name: 'Transaksi Baru' });
    await waitFor(() => expect(next).toHaveFocus());
    await user.click(next);
    expect(onNewTransaction).toHaveBeenCalledOnce();
    expect(done).toBeInTheDocument();
  });

  test('negative stock needs an explicit acknowledgement; changed warnings re-preview and re-ask', async () => {
    const finalizer = client(
      [
        preview({ warnings: [negative(1)] }),
        preview({ warnings: [negative(2)] }),
      ],
      [
        {
          ok: false,
          error: {
            code: 'FINALIZE_WARNINGS_CHANGED',
            messageKey: 'errors.FINALIZE_WARNINGS_CHANGED',
          },
        },
        ok(invoice),
      ],
    );
    renderReview(finalizer);
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Finalisasi' });
    expect(screen.getByTestId('negative-stock-warning')).toHaveTextContent(
      'Kampas Rem: stok 1, dijual 3, stok setelah penjualan -2',
    );
    expect(button).toBeDisabled();
    const ack = screen.getByLabelText('Saya mengerti stok akan menjadi minus');
    await user.click(ack);
    await user.click(button);
    expect(finalizer.finalize.mock.calls[0]![0].acknowledgedWarnings).toEqual([
      negative(1),
    ]);
    // Re-previewed: the new balance is shown and must be acknowledged again.
    expect(await screen.findByTestId('review-notice')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('negative-stock-warning')).toHaveTextContent(
        'stok 2',
      ),
    );
    expect(finalizer.previewFinalize).toHaveBeenCalledTimes(2);
    expect(
      screen.getByLabelText('Saya mengerti stok akan menjadi minus'),
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Finalisasi' })).toBeDisabled();
    await user.click(
      screen.getByLabelText('Saya mengerti stok akan menjadi minus'),
    );
    await user.click(screen.getByRole('button', { name: 'Finalisasi' }));
    const second = finalizer.finalize.mock.calls[1]![0];
    expect(second.acknowledgedWarnings).toEqual([negative(2)]);
    // A different acknowledgement is a different request.
    expect(second.requestId).not.toBe(
      finalizer.finalize.mock.calls[0]![0].requestId,
    );
    expect(
      await screen.findByTestId('finalized-invoice-number'),
    ).toBeInTheDocument();
  });

  test('blocking errors are shown and disable Finalize', async () => {
    const blocked = client(
      [
        preview({
          errors: [
            {
              code: 'INVOICE_DATE_IN_FUTURE',
              params: { invoiceDate: '2026-10-01', today: '2026-09-30' },
            },
          ],
          paymentStatusAfterCheckout: null,
        }),
      ],
      [],
    );
    renderReview(blocked);
    expect(await screen.findByTestId('finalize-errors')).toHaveTextContent(
      '2026-10-01',
    );
    expect(screen.getByRole('button', { name: 'Finalisasi' })).toBeDisabled();
    expect(screen.queryByTestId('review-payment-status')).toBeNull();
  });

  test('a transport failure keeps the review open and the retry reuses the requestId', async () => {
    const finalizer = client([preview()], [new Error('ipc down'), ok(invoice)]);
    renderReview(finalizer);
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Finalisasi' });
    await user.click(button);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Finalisasi' }));
    await screen.findByTestId('finalized-invoice-number');
    const [first, retry] = finalizer.finalize.mock.calls.map((c) => c[0]);
    expect(retry!.requestId).toBe(first!.requestId);
  });
});
