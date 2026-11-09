import { test, expect } from 'vitest';
import {
  createHarness,
  validSetup,
  value,
  ADMIN_PASSWORD,
} from './helpers/harness';
import { CHANNELS as C } from '@/shared/channels';
test('supplier payable channels expose empty totals', async () => {
  const h = createHarness();
  try {
    value(await h.call(C.settings.completeSetup, validSetup()));
    value(
      await h.call(C.auth.login, {
        username: 'admin',
        password: ADMIN_PASSWORD,
      }),
    );
    const page = value(
      await h.call<{ totalOutstanding: string }>(
        'bengkelin:supplierPayables:list',
        { page: { number: 1, size: 25 } },
      ),
    );
    expect(page.totalOutstanding).toBe('0');
  } finally {
    h.close();
  }
});
