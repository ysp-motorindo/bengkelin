import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { CashierWorkspace } from '@/renderer/features/workspace/CashierWorkspace';
import { cashChange } from '@/renderer/features/workspace/checkout/tender';
import { getWorkspaceActions } from '@/renderer/features/workspace/workspace-actions';
import { formatIdr, parseRupiahInput } from '@/renderer/lib/money';
import type { DraftCommand } from '@/shared/contracts';
import { workspaceBridge } from './helpers/workspace-bridge';

function install() {
  const bridge = workspaceBridge();
  (window as unknown as { bengkelin: unknown }).bengkelin = bridge;
  return bridge;
}

const ops = (bridge: ReturnType<typeof workspaceBridge>) =>
  bridge.drafts.apply.mock.calls.map(
    (call) => (call[0] as DraftCommand).op.kind,
  );

describe('cashier workspace', () => {
  test('starts a draft in the shop timezone and focuses "Cari barang"', async () => {
    const bridge = install();
    render(<CashierWorkspace />);
    const search = await screen.findByRole('combobox', { name: 'Cari barang' });
    await waitFor(() => expect(search).toHaveFocus());
    expect(bridge.drafts.create).toHaveBeenCalledOnce();
    const input = bridge.drafts.create.mock.calls[0]![0];
    expect(input.invoiceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(input.pricingAt).toMatch(/Z$/);
    expect(screen.getByTestId('header-customer')).toHaveTextContent('Umum');
  });

  test('scanner Enter in "Cari barang" adds by barcode and clears the field', async () => {
    const bridge = install();
    render(<CashierWorkspace />);
    const user = userEvent.setup();
    const search = await screen.findByRole('combobox', { name: 'Cari barang' });
    await user.click(search);
    await user.keyboard('8991234567890{Enter}');
    await waitFor(() => expect(bridge.drafts.apply).toHaveBeenCalledOnce());
    const command = bridge.drafts.apply.mock.calls[0]![0] as DraftCommand;
    expect(command.op).toEqual({
      kind: 'addCatalogLine',
      barcode: '8991234567890',
    });
    expect(command.expectedVersion).toBe(1);
    expect(search).toHaveValue('');
  });

  test('digits + Enter typed into other fields are never treated as a scan', async () => {
    const bridge = install();
    render(<CashierWorkspace />);
    const user = userEvent.setup();
    await screen.findByRole('combobox', { name: 'Cari barang' });
    await user.click(screen.getByLabelText('Catatan'));
    await user.keyboard('8991234567890{Enter}');
    await user.click(screen.getByLabelText('Odometer (km)'));
    await user.keyboard('12345{Enter}');
    expect(getWorkspaceActions()).not.toBeNull();
    await getWorkspaceActions()!.saveDraft();
    expect(ops(bridge)).not.toContain('addCatalogLine');
    expect(ops(bridge)).toContain('updateHeader');
  });
});

describe('money helpers', () => {
  test('formats and parses Rupiah strings without Number', () => {
    expect(formatIdr('130000')).toBe('Rp 130.000');
    expect(formatIdr('0')).toBe('Rp 0');
    expect(formatIdr('-5000')).toBe('-Rp 5.000');
    expect(formatIdr('9223372036854775807')).toBe(
      'Rp 9.223.372.036.854.775.807',
    );
    expect(parseRupiahInput('65000')).toBe('65000');
    expect(parseRupiahInput('65.000')).toBe('65000');
    expect(parseRupiahInput('Rp 1.250.000')).toBe('1250000');
    expect(parseRupiahInput('007')).toBe('7');
    expect(parseRupiahInput('6.5')).toBeNull();
    expect(parseRupiahInput('-1')).toBeNull();
    expect(parseRupiahInput('1e5')).toBeNull();
    expect(parseRupiahInput('')).toBeNull();
  });

  test('cash change is UI arithmetic against planned cash, else the total', () => {
    const cash = {
      sequence: 1,
      method: 'CASH' as const,
      amount: '90000',
      reference: null,
      note: null,
    };
    expect(cashChange('100000', '90000', [cash])).toBe('10000');
    expect(cashChange('50000', '90000', [])).toBe('-40000');
    expect(
      cashChange('50000', '90000', [
        { ...cash, method: 'QRIS', amount: '40000' },
        { ...cash, sequence: 2, amount: '50000' },
      ]),
    ).toBe('0');
  });
});
