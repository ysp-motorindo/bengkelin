import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { CatalogScreen } from '@/renderer/features/catalog/CatalogScreen';
import { InventoryScreen } from '@/renderer/features/inventory/InventoryScreen';
import i18n from 'i18next';

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe.each(['catalog', 'inventory'] as const)('%s list feedback', (kind) => {
  const emptyKey = `${kind}.search.empty`;
  const item = {
    id: '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11',
    catalogItemId: '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11',
    title: 'Oli MPX2',
    type: 'STOCK_ITEM',
    sku: 'OLI',
    unitLabel: 'PCS',
    isActive: true,
    quantity: 30,
    isNegative: false,
  };
  const result = (populated: boolean) => ({
    ok: true,
    value:
      kind === 'catalog'
        ? { results: populated ? [item] : [] }
        : { items: populated ? [item] : [] },
  });

  function open(request: ReturnType<typeof vi.fn>) {
    (window as unknown as { bengkelin: unknown }).bengkelin = {
      catalog: { search: request },
      inventory: { listStock: request },
    };
    render(
      kind === 'catalog' ? (
        <CatalogScreen role="CASHIER" />
      ) : (
        <InventoryScreen role="CASHIER" />
      ),
    );
  }

  test('shows loading instead of empty until the first successful response', async () => {
    const pending = deferred();
    open(vi.fn(() => pending.promise));
    expect(screen.getByText(i18n.t('common.loading'))).toHaveAttribute(
      'role',
      'status',
    );
    expect(screen.queryByText(i18n.t(emptyKey))).not.toBeInTheDocument();
    await act(async () => pending.resolve(result(false)));
    expect(screen.getByText(i18n.t(emptyKey))).toBeInTheDocument();
    expect(
      screen.queryByText(i18n.t('common.loading')),
    ).not.toBeInTheDocument();
  });

  test('a failed first load shows an error and permits retry without claiming no results', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('IPC unavailable'))
      .mockResolvedValueOnce(result(false));
    open(request);
    await screen.findByRole('alert');
    expect(screen.queryByText(i18n.t(emptyKey))).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: i18n.t(`${kind}.search.submit`) }),
    );
    expect(await screen.findByText(i18n.t(emptyKey))).toBeInTheDocument();
  });

  test('keeps previous results and filters during refresh and after failure', async () => {
    const pending = deferred();
    const request = vi
      .fn()
      .mockResolvedValueOnce(result(true))
      .mockImplementationOnce(() => pending.promise);
    open(request);
    await screen.findByText(item.title);
    const query = screen.getByLabelText(i18n.t(`${kind}.search.label`));
    await userEvent.type(query, 'MPX');
    const submit = screen.getByRole('button', {
      name: i18n.t(`${kind}.search.submit`),
    });
    await userEvent.click(submit);
    expect(screen.getByText(item.title)).toBeInTheDocument();
    expect(screen.getByText(i18n.t('common.loading'))).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await act(async () => pending.reject(new Error('IPC unavailable')));
    await screen.findByRole('alert');
    expect(query).toHaveValue('MPX');
    expect(screen.getByText(item.title)).toBeInTheDocument();
    expect(submit).toBeEnabled();
  });
});
