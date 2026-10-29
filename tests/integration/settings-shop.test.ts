import { openDatabase } from '@/main/database/connection';
import { bundledMigrations, migrateDatabase } from '@/main/database/migrate';
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
        'complaintPhoneNumber',
        'socialMediaUrl',
        'email',
        'invoiceFooter',
        'name',
        'phoneNumber',
        'timezone',
      ].sort(),
    );
  });
});

describe('cashier number formats', () => {
  test('onboarding choice persists across restart and remains personal to each cashier', async () => {
    value(
      await h.call(
        C.settings.completeSetup,
        validSetup({
          preferences: {
            language: 'id',
            appearance: 'SYSTEM',
            numberFormat: 'US',
          },
        }),
      ),
    );
    const login = () =>
      h.call<{ numberFormat: string }>(C.auth.login, {
        username: 'admin',
        password: ADMIN_PASSWORD,
      });
    expect(value(await login()).numberFormat).toBe('US');
    value(
      await h.call(C.cashiers.create, {
        username: 'cashier',
        displayName: 'Kasir',
        password: 'cashier-password',
        role: 'CASHIER',
      }),
    );
    expect(
      value(
        await h.call<{ numberFormat: string }>(
          C.auth.login,
          { username: 'cashier', password: 'cashier-password' },
          2,
        ),
      ).numberFormat,
    ).toBe('ID');
    value(
      await h.call(
        C.settings.updatePreferences,
        { language: 'id', appearance: 'SYSTEM', numberFormat: 'SYSTEM' },
        2,
      ),
    );
    expect(
      value(await h.call<{ numberFormat: string }>(C.auth.currentSession))
        .numberFormat,
    ).toBe('US');
    h.reopen();
    expect(value(await login()).numberFormat).toBe('US');
    expect(
      value(
        await h.call<{ numberFormat: string }>(
          C.auth.login,
          { username: 'cashier', password: 'cashier-password' },
          2,
        ),
      ).numberFormat,
    ).toBe('SYSTEM');
    expect(
      failure(
        await h.call(C.settings.updatePreferences, {
          language: 'id',
          appearance: 'SYSTEM',
          numberFormat: 'CUSTOM',
        }),
      ).code,
    ).toBe('VALIDATION_FAILED');
  });
});

test('upgrading cashier preferences backfills Indonesian without changing the account', () => {
  const db = openDatabase(':memory:');
  try {
    migrateDatabase(
      db,
      bundledMigrations.filter((migration) => migration.version < 14),
    );
    db.prepare(`INSERT INTO cashiers (id, username, display_name, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'legacy',
      'legacy',
      'Legacy',
      'hash',
      'CASHIER',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    const before = db.prepare('SELECT * FROM cashiers').get() as Record<
      string,
      unknown
    >;
    migrateDatabase(db);
    const after = db.prepare('SELECT * FROM cashiers').get() as Record<
      string,
      unknown
    >;
    expect(after).toEqual({ ...before, number_format: 'ID' });
  } finally {
    db.close();
  }
});

test('system locale is supplied by main independently of cashier language', async () => {
  const regional = createHarness({ systemNumberLocale: 'fr-FR' });
  try {
    expect(
      value(
        await regional.call<{ systemNumberLocale: string }>(
          C.settings.getPublic,
        ),
      ).systemNumberLocale,
    ).toBe('fr-FR');
  } finally {
    regional.close();
  }
});

describe('invoice contact settings', () => {
  test('persists current contacts, clears independently, and survives reopen', async () => {
    value(await h.call(C.settings.completeSetup, validSetup()));
    value(
      await h.call(C.auth.login, {
        username: 'admin',
        password: ADMIN_PASSWORD,
      }),
    );
    const get = async () =>
      value(await h.call<ShopSettingsDto>(C.settings.getShop));
    expect(await get()).toMatchObject({
      complaintPhoneNumber: null,
      socialMediaUrl: null,
    });
    value(
      await h.call(C.settings.updateShop, {
        ...(await get()),
        complaintPhoneNumber: ' 0878-1640-9387 ',
        socialMediaUrl: ' https://s.id/mitramotorbersama?s=qr ',
      }),
    );
    expect(await get()).toMatchObject({
      complaintPhoneNumber: '0878-1640-9387',
      socialMediaUrl: 'https://s.id/mitramotorbersama?s=qr',
    });
    h.reopen();
    value(
      await h.call(C.auth.login, {
        username: 'admin',
        password: ADMIN_PASSWORD,
      }),
    );
    expect(await get()).toMatchObject({
      socialMediaUrl: 'https://s.id/mitramotorbersama?s=qr',
    });
    value(
      await h.call(C.settings.updateShop, {
        ...(await get()),
        complaintPhoneNumber: ' ',
        socialMediaUrl: 'https://example.com/baru',
      }),
    );
    expect(await get()).toMatchObject({
      complaintPhoneNumber: null,
      socialMediaUrl: 'https://example.com/baru',
    });
    value(
      await h.call(C.settings.updateShop, {
        ...(await get()),
        socialMediaUrl: '',
      }),
    );
    expect(await get()).toMatchObject({
      complaintPhoneNumber: null,
      socialMediaUrl: null,
    });
  });
  test.each([
    '/relative',
    'javascript:alert(1)',
    'data:text/plain,a',
    'ftp://example.com',
    'https://',
    'https://example.com/' + 'x'.repeat(500),
  ])(
    'rejects invalid social URL %s without partial writes',
    async (socialMediaUrl) => {
      value(await h.call(C.settings.completeSetup, validSetup()));
      value(
        await h.call(C.auth.login, {
          username: 'admin',
          password: ADMIN_PASSWORD,
        }),
      );
      const before = value(await h.call<ShopSettingsDto>(C.settings.getShop));
      expect(
        failure(
          await h.call(C.settings.updateShop, {
            ...before,
            complaintPhoneNumber: '123',
            socialMediaUrl,
          }),
        ).code,
      ).toBe('VALIDATION_FAILED');
      expect(value(await h.call(C.settings.getShop))).toEqual(before);
    },
  );
});

test('accepts Unicode HTTP(S) links and rejects overlong complaint numbers', async () => {
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(C.auth.login, { username: 'admin', password: ADMIN_PASSWORD }),
  );
  const before = value(await h.call<ShopSettingsDto>(C.settings.getShop));
  const socialMediaUrl = 'https://example.com/日本?q=keluhan&x=1';
  value(await h.call(C.settings.updateShop, { ...before, socialMediaUrl }));
  expect(
    value(await h.call<ShopSettingsDto>(C.settings.getShop)).socialMediaUrl,
  ).toBe(socialMediaUrl);
  expect(
    failure(
      await h.call(C.settings.updateShop, {
        ...before,
        complaintPhoneNumber: '1'.repeat(41),
      }),
    ).code,
  ).toBe('VALIDATION_FAILED');
});
