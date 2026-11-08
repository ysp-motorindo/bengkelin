import { expect, test } from 'vitest';
import { DraftCommandQueue } from '@/renderer/features/workspace/draft-command-queue';
import type { Result } from '@/shared/primitives';
test('a purchase finalized elsewhere closes its draft queue and reports a closed result', async () => {
  const notices: string[] = [];
  const initial = { id: 'purchase', version: 1 };
  const queue = new DraftCommandQueue(
    initial,
    {
      apply: async () =>
        ({
          ok: false,
          error: {
            code: 'PURCHASE_NOT_DRAFT',
            messageKey: 'errors.PURCHASE_NOT_DRAFT',
          },
        }) as Result<typeof initial>,
      get: async () => ({ ok: true, value: initial }) as Result<typeof initial>,
      newRequestId: () => crypto.randomUUID(),
    },
    { view: () => {}, state: () => {}, notice: (n) => notices.push(n.kind) },
  );
  await queue.send({ kind: 'discard' });
  expect(notices).toContain('closed');
});
