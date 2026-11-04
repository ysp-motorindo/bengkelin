import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { CustomLineEntry } from '@/renderer/features/workspace/CustomLineEntry';
import type {
  DraftLineDto,
  DraftOperation,
  DraftView,
  ReferenceDto,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
import { draftView, ok } from './helpers/workspace-bridge';

const MECHANIC: ReferenceDto = {
  entity: 'mechanic',
  id: '5d9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11',
  label: 'Budi',
  code: null,
  phoneNumber: null,
  brandId: null,
  address: null,
  city: null,
  isActive: true,
  isDefault: false,
};
const LINE_ID = '6e9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11';

function customLine(): DraftLineDto {
  return {
    itemCode: null,
    currentStock: null,
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

describe('custom line dialog retry (T9)', () => {
  test('when the mechanic assignment fails, a retry only re-assigns the mechanic on the created line', async () => {
    (window as unknown as { bengkelin: unknown }).bengkelin = {
      adHocReferences: { search: vi.fn(async () => ok({ results: [] })) },
    };
    let assignAttempts = 0;
    const send = vi.fn(
      async (op: DraftOperation): Promise<Result<DraftView>> => {
        if (op.kind === 'addCustomLine') {
          return ok(draftView({ version: 2, lines: [customLine()] }));
        }
        assignAttempts += 1;
        if (assignAttempts === 1) {
          return {
            ok: false,
            error: {
              code: 'INTERNAL_ERROR',
              messageKey: 'errors.INTERNAL_ERROR',
            },
          };
        }
        return ok(draftView({ version: 3, lines: [customLine()] }));
      },
    );
    const onClose = vi.fn();
    render(
      <CustomLineEntry
        existingLineIds={[]}
        units={[]}
        mechanics={[MECHANIC]}
        send={send}
        onClose={onClose}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Nama item'), 'Servis CVT');
    await user.type(screen.getByLabelText('Harga'), '50000');
    await user.selectOptions(screen.getByLabelText('Mekanik'), MECHANIC.id);
    await user.click(screen.getByRole('button', { name: 'Tambahkan' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Tambahkan' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const kinds = send.mock.calls.map((call) => call[0].kind);
    expect(kinds).toEqual(['addCustomLine', 'updateLine', 'updateLine']);
    expect(send.mock.calls[2]![0]).toEqual({
      kind: 'updateLine',
      lineId: LINE_ID,
      mechanicId: MECHANIC.id,
    });
  });
});

test('owns one dialog with footer actions that submit the custom form', async () => {
  Object.assign(window, {
    bengkelin: {
      adHocReferences: { search: vi.fn(async () => ok({ results: [] })) },
    },
  });
  const send = vi.fn(async () => ok(draftView()));
  const onClose = vi.fn();
  render(
    <CustomLineEntry
      existingLineIds={[]}
      units={[]}
      mechanics={[]}
      send={send}
      onClose={onClose}
    />,
  );
  const dialog = screen.getByRole('dialog');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(within(dialog).getAllByRole('heading')).toHaveLength(1);
  const add = within(dialog).getByRole('button', { name: 'Tambahkan' });
  const cancel = within(dialog).getByRole('button', { name: 'Batal' });
  expect(add.closest('.dialog-scroll-area')).toBeNull();
  expect(cancel.closest('.dialog-scroll-area')).toBeNull();
  expect((add as HTMLButtonElement).form).toBe(dialog.querySelector('form'));
  const user = userEvent.setup();
  await user.click(add);
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Nama item')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await user.type(screen.getByLabelText('Nama item'), 'Service');
  await user.type(screen.getByLabelText('Harga'), '20000');
  await user.click(add);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

test('blocks user dismissal during a pending save but closes on success', async () => {
  Object.assign(window, {
    bengkelin: {
      adHocReferences: { search: vi.fn(async () => ok({ results: [] })) },
    },
  });
  let finish!: (result: Result<DraftView>) => void;
  const send = vi.fn(
    () =>
      new Promise<Result<DraftView>>((resolve) => {
        finish = resolve;
      }),
  );
  const onClose = vi.fn();
  render(
    <CustomLineEntry
      existingLineIds={[]}
      units={[]}
      mechanics={[]}
      send={send}
      onClose={onClose}
    />,
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Nama item'), 'Service');
  await user.type(screen.getByLabelText('Harga'), '20000');
  await user.click(screen.getByRole('button', { name: 'Tambahkan' }));
  expect(screen.getByRole('button', { name: 'Batal' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Tutup' }));
  await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => finish(ok(draftView())));
  expect(onClose).toHaveBeenCalledOnce();
});
