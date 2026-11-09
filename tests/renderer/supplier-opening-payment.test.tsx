import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { SupplierOpeningPaymentDialog } from '@/renderer/features/purchases/SupplierOpeningPaymentDialog';
import type { BengkelinApi } from '@/shared/bridge';
import type {
  RecordSupplierOpeningPaymentInput,
  SupplierOpeningDetail,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';

const opening: SupplierOpeningDetail = {
  supplierId: '11111111-1111-4111-8111-111111111111',
  externalId: 'SU-1',
  supplierName: 'Alpha',
  asOfDate: '2026-10-31',
  originalAmount: '100000',
  paidAmount: '0',
  outstandingAmount: '100000',
  paymentStatus: 'UNPAID',
  payments: [],
};
const paidDetail: SupplierOpeningDetail = {
  ...opening,
  paidAmount: '30000',
  outstandingAmount: '70000',
  paymentStatus: 'PARTIALLY_PAID',
  payments: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      method: 'BANK_TRANSFER',
      amount: '30000',
      createdAt: '2026-11-09T03:00:00.000Z',
      reference: 'PAY-1',
      note: 'Test payment',
      cashierName: 'Admin',
    },
  ],
};

test.each(['rejection', 'INTERNAL_ERROR'] as const)(
  '%s keeps the reviewed payment locked and retries the same request',
  async (failure) => {
    let resolve!: (value: Result<SupplierOpeningDetail>) => void;
    let reject!: (error: Error) => void;
    const first = new Promise<Result<SupplierOpeningDetail>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const recordPayment = vi
      .fn<
        (
          input: RecordSupplierOpeningPaymentInput,
        ) => Promise<Result<SupplierOpeningDetail>>
      >()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ok: true, value: paidDetail });
    window.bengkelin = {
      supplierPayables: { recordPayment },
    } as unknown as BengkelinApi;
    const onClose = vi.fn();
    const onRecorded = vi.fn();
    const user = userEvent.setup();
    render(
      <SupplierOpeningPaymentDialog
        opening={opening}
        onClose={onClose}
        onRecorded={onRecorded}
      />,
    );
    const amount = screen.getByLabelText('Jumlah (Rp)');
    const method = screen.getByLabelText('Metode');
    const reference = screen.getByLabelText('Referensi (opsional)');
    const note = screen.getByLabelText('Catatan (opsional)');
    await user.clear(amount);
    await user.type(amount, '30000');
    await user.selectOptions(method, 'BANK_TRANSFER');
    await user.type(reference, 'PAY-1');
    await user.type(note, 'Test payment');
    await user.click(screen.getByRole('button', { name: 'Tinjau' }));
    expect(recordPayment).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Konfirmasi' }));
    expect(recordPayment).toHaveBeenCalledTimes(1);
    const firstPayload = structuredClone(recordPayment.mock.calls[0]![0]);
    expect(firstPayload).toEqual({
      requestId: expect.any(String),
      supplierId: opening.supplierId,
      method: 'BANK_TRANSFER',
      amount: '30000',
      reference: 'PAY-1',
      note: 'Test payment',
    });
    expect(firstPayload.requestId).not.toBe('');

    async function expectLocked() {
      for (const control of [amount, method, reference, note])
        expect(control).toBeDisabled();
      const cancel = screen.getAllByRole('button', {
        name: 'Batal',
      });
      expect(cancel.at(-1)).toBeDisabled();
      await user.click(cancel[0]!);
      await user.keyboard('{Escape}');
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeVisible();
    }
    await expectLocked();
    expect(screen.getByRole('button', { name: 'Menyimpan…' })).toBeDisabled();
    await act(async () => {
      if (failure === 'rejection') reject(Error('lost response'));
      else
        resolve({
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            messageKey: 'errors.INTERNAL_ERROR',
          },
        });
    });
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Hasil pembayaran belum dapat dipastikan',
    );
    await expectLocked();
    expect(amount).toHaveValue('30.000');
    expect(method).toHaveValue('BANK_TRANSFER');
    expect(reference).toHaveValue('PAY-1');
    expect(note).toHaveValue('Test payment');
    expect(onRecorded).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Konfirmasi' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect(recordPayment).toHaveBeenCalledTimes(2);
    expect(recordPayment.mock.calls[1]![0]).toEqual(firstPayload);
    expect(onRecorded).toHaveBeenCalledWith(paidDetail);
  },
);
