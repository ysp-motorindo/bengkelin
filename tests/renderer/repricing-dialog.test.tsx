import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { test, expect } from 'vitest';
import { RepricingDialog } from '@/renderer/features/workspace/RepricingDialog';
import { useDraftCommands } from '@/renderer/features/workspace/use-draft-commands';
import { draftView, workspaceBridge, ok } from './helpers/workspace-bridge';
function Harness() {
  const commands = useDraftCommands(draftView().id, {
    initialView: draftView(),
  });
  return (
    <RepricingDialog
      commands={commands}
      timezone="Asia/Jakarta"
      onClose={() => {}}
    />
  );
}
test('pricing time can be changed from Check prices and proposals refresh without applying', async () => {
  const bridge = workspaceBridge();
  bridge.drafts.previewPriceRefresh.mockResolvedValue(
    ok({
      invoiceId: draftView().id,
      version: 1,
      channelId: draftView().channelId,
      pricingAt: draftView().pricingAt,
      proposals: [],
    }),
  );
  Object.assign(window, { bengkelin: bridge });
  render(<Harness />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'Ubah waktu harga' }),
  );
  const time = screen.getByLabelText(/Tanggal dan jam/);
  await user.clear(time);
  await user.type(time, '2026-09-29T10:00');
  await user.click(screen.getByRole('button', { name: 'Terapkan' }));
  await waitFor(() =>
    expect(bridge.drafts.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        op: {
          kind: 'updateHeader',
          changes: { pricingAt: '2026-09-29T03:00:00.000Z' },
        },
      }),
    ),
  );
  await waitFor(() =>
    expect(bridge.drafts.previewPriceRefresh).toHaveBeenCalledTimes(2),
  );
  expect(
    bridge.drafts.apply.mock.calls.some(
      ([command]) => command.op.kind === 'applyPriceRefresh',
    ),
  ).toBe(false);
});
