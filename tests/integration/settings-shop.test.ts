import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CHANNELS } from '@/shared/channels';
import type { ShopSettingsDto } from '@/shared/contracts';
import {
  ADMIN_PASSWORD,
  createHarness,
  failure,
  validSetup,
  value,
  type Harness,
} from './helpers/harness';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

const C = CHANNELS;

describe('settings.getShop (workspace shop context)', () => {
  test('requires a session', async () => {
    value(await h.call(C.settings.completeSetup, validSetup()));
    expect(failure(await h.call(C.settings.getShop)).code).toBe(
      'UNAUTHENTICATED',
    );
  });

  test('returns the shop identity and timezone to any signed-in cashier', async () => {
    value(await h.call(C.settings.completeSetup, validSetup()));
    value(
      await h.call(C.auth.login, {
        username: 'admin',
        password: ADMIN_PASSWORD,
      }),
    );
    const shop = value(await h.call<ShopSettingsDto>(C.settings.getShop));
    expect(shop.timezone).toBe(validSetup().shop.timezone);
    expect(shop.name).toBe(validSetup().shop.name);
    expect(Object.keys(shop).sort()).toEqual(
      [
        'address',
        'email',
        'invoiceFooter',
        'name',
        'phoneNumber',
        'timezone',
      ].sort(),
    );
  });
});
