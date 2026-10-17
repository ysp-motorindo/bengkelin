import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CHANNELS } from '@/shared/channels';
import type { CashierDto, CashierSession } from '@/shared/contracts';
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
const ADMIN_WINDOW = 1;
const CASHIER_WINDOW = 2;

async function setupAndLoginAdmin(windowId = ADMIN_WINDOW) {
  value(await h.call(C.settings.completeSetup, validSetup()));
  return value(
    await h.call<CashierSession>(
      C.auth.login,
      { username: 'admin', password: ADMIN_PASSWORD },
      windowId,
    ),
  );
}

async function createCashier(
  overrides: Record<string, unknown> = {},
  windowId = ADMIN_WINDOW,
) {
  return value(
    await h.call<CashierDto>(
      C.cashiers.create,
      {
        username: 'siti',
        displayName: 'Siti',
        password: 'siti-password-1',
        role: 'CASHIER',
        ...overrides,
      },
      windowId,
    ),
  );
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

const rows = (sql: string, ...params: unknown[]) =>
  h.db.prepare(sql).all(...params) as Record<string, unknown>[];

describe('first-run setup', () => {
  test('completes atomically: settings, admin, seeds and audit', async () => {
    const before = value(await h.call(C.settings.getPublic));
    expect(before).toMatchObject({ setupCompleted: false, language: 'id' });

    value(await h.call(C.settings.completeSetup, validSetup()));

    const cashiers = rows('SELECT * FROM cashiers');
    expect(cashiers).toHaveLength(1);
    expect(cashiers[0]).toMatchObject({ username: 'Admin', role: 'ADMIN' });
    expect(cashiers[0]!.is_active).toBe(1n);
    const savedHash = String(cashiers[0]!.password_hash);
    expect(savedHash).not.toContain(ADMIN_PASSWORD);
    expect(savedHash).toMatch(/^scrypt\$/);

    expect(
      rows('SELECT code, label FROM channels ORDER BY code').map((r) => r.code),
    ).toEqual(['BENGKEL', 'MARKETPLACE', 'ONLINE']);
    expect(
      rows('SELECT code FROM units ORDER BY code').map((r) => r.code),
    ).toEqual(['BOTTLE', 'BOX', 'PAIR', 'PCS', 'SERVICE', 'SET']);
    expect(rows("SELECT label FROM units WHERE code = 'PCS'")[0]!.label).toBe(
      'Pcs',
    );
    expect(
      rows('SELECT is_active FROM units').every((r) => r.is_active === 1n),
    ).toBe(true);

    const settings = rows('SELECT * FROM settings')[0]!;
    expect(settings.shop_name).toBe('Bengkel Maju Jaya');
    expect(settings.setup_completed_at).toBe('2026-09-30T03:00:00.000Z');
    // Printer step skipped: nothing stored.
    expect(settings.default_thermal_printer_name).toBeNull();
    expect(settings.default_a4_printer_name).toBeNull();
    expect(settings.thermal_paper_width_mm).toBeNull();

    const audit = rows(
      "SELECT * FROM audit_log WHERE action = 'SETUP_COMPLETED'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.cashier_id).toBe(cashiers[0]!.id);
    expect(json(audit[0])).not.toContain(ADMIN_PASSWORD);
  });

  test('stores printer settings only when provided', async () => {
    value(
      await h.call(
        C.settings.completeSetup,
        validSetup({
          printer: { thermalPrinterName: 'POS-58', thermalPaperWidthMm: 58 },
        }),
      ),
    );
    const settings = rows('SELECT * FROM settings')[0]!;
    expect(settings.default_thermal_printer_name).toBe('POS-58');
    expect(settings.thermal_paper_width_mm).toBe(58n);
  });

  test('can only run once', async () => {
    value(await h.call(C.settings.completeSetup, validSetup()));
    const second = failure(
      await h.call(
        C.settings.completeSetup,
        validSetup({
          admin: {
            username: 'other',
            displayName: 'X',
            password: 'another-password',
          },
        }),
      ),
    );
    expect(second.code).toBe('SETUP_ALREADY_COMPLETED');
    expect(second.messageKey).toBe('errors.SETUP_ALREADY_COMPLETED');
    expect(rows('SELECT * FROM cashiers')).toHaveLength(1);
    expect(rows('SELECT * FROM channels')).toHaveLength(3);
  });

  test('an injected failure leaves no admin, no seeds and setup incomplete', async () => {
    h.db.exec(`CREATE TRIGGER inject_failure BEFORE INSERT ON units
      WHEN NEW.code = 'BOX' BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    const result = failure(
      await h.call(C.settings.completeSetup, validSetup()),
    );
    expect(result.code).toBe('INTERNAL_ERROR');
    expect(rows('SELECT * FROM cashiers')).toHaveLength(0);
    expect(rows('SELECT * FROM channels')).toHaveLength(0);
    expect(rows('SELECT * FROM units')).toHaveLength(0);
    expect(rows('SELECT * FROM audit_log')).toHaveLength(0);
    const settings = rows('SELECT * FROM settings')[0]!;
    expect(settings.setup_completed_at).toBeNull();
    expect(settings.shop_name).toBe('');
    expect(value(await h.call(C.settings.getPublic))).toMatchObject({
      setupCompleted: false,
    });
  });

  test('getPublic exposes only startup presentation settings without a session', async () => {
    value(
      await h.call(
        C.settings.completeSetup,
        validSetup({ preferences: { language: 'en', appearance: 'DARK' } }),
      ),
    );
    expect(value(await h.call(C.settings.getPublic))).toEqual({
      setupCompleted: true,
      language: 'en',
      appearance: 'DARK',
      shopName: 'Bengkel Maju Jaya',
      systemNumberLocale: 'id-ID',
    });
  });
});

describe('validation', () => {
  test('malformed input returns VALIDATION_FAILED with field errors, never throws', async () => {
    const bad = failure(
      await h.call(
        C.settings.completeSetup,
        validSetup({
          admin: { username: 'a b', displayName: '', password: 'short' },
        }),
      ),
    );
    expect(bad.code).toBe('VALIDATION_FAILED');
    expect(bad.messageKey).toBe('errors.VALIDATION_FAILED');
    expect(Object.keys(bad.fieldErrors ?? {})).toEqual(
      expect.arrayContaining([
        'admin.username',
        'admin.displayName',
        'admin.password',
      ]),
    );
    expect(bad.fieldErrors?.['admin.password']).toBe(
      'validation.passwordTooShort',
    );
    expect(rows('SELECT * FROM cashiers')).toHaveLength(0);
  });

  test.each([undefined, null, 'x', 42, [], { username: 1 }])(
    'login rejects malformed payload %j',
    async (payload) => {
      const result = failure(await h.call(C.auth.login, payload));
      expect(result.code).toBe('VALIDATION_FAILED');
    },
  );

  test('unknown keys are rejected', async () => {
    const result = failure(
      await h.call(C.auth.login, {
        username: 'a',
        password: 'b',
        role: 'ADMIN',
      }),
    );
    expect(result.code).toBe('VALIDATION_FAILED');
  });

  test('an invalid timezone is a field error', async () => {
    const bad = failure(
      await h.call(
        C.settings.completeSetup,
        validSetup({
          shop: { name: 'X', address: 'Y', timezone: 'Mars/Base' },
        }),
      ),
    );
    expect(bad.fieldErrors).toHaveProperty(['shop.timezone']);
  });
});

describe('login and sessions', () => {
  test('login success creates a window-bound session without password data', async () => {
    const session = await setupAndLoginAdmin();
    expect(session).toEqual({
      numberFormat: 'ID',
      cashierId: expect.any(String),
      username: 'Admin',
      displayName: 'Pak Budi',
      role: 'ADMIN',
      language: 'id',
      appearance: 'SYSTEM',
    });
    expect(JSON.stringify(session)).not.toMatch(/hash|password/i);
    expect(
      value(await h.call(C.auth.currentSession, undefined, ADMIN_WINDOW)),
    ).toEqual(session);
    // Another window has no session.
    expect(
      value(await h.call(C.auth.currentSession, undefined, 99)),
    ).toBeNull();
  });

  test('unknown user, wrong password and disabled cashier all give INVALID_CREDENTIALS', async () => {
    await setupAndLoginAdmin();
    const siti = await createCashier();
    value(
      await h.call(C.cashiers.deactivate, { cashierId: siti.id }, ADMIN_WINDOW),
    );

    const unknown = failure(
      await h.call(
        C.auth.login,
        { username: 'nobody', password: 'whatever-123' },
        5,
      ),
    );
    const wrong = failure(
      await h.call(
        C.auth.login,
        { username: 'admin', password: 'wrong-password' },
        5,
      ),
    );
    const disabledCashierLogin = failure(
      await h.call(
        C.auth.login,
        { username: 'siti', password: 'siti-password-1' },
        5,
      ),
    );
    for (const error of [unknown, wrong, disabledCashierLogin]) {
      expect(error.code).toBe('INVALID_CREDENTIALS');
      expect(error.messageKey).toBe('errors.INVALID_CREDENTIALS');
    }
    expect(value(await h.call(C.auth.currentSession, undefined, 5))).toBeNull();
  });

  test('login is case-insensitive on username', async () => {
    await setupAndLoginAdmin();
    const ok = await h.call(
      C.auth.login,
      { username: 'ADMIN', password: ADMIN_PASSWORD },
      7,
    );
    expect(ok.ok).toBe(true);
  });

  test('login attempts are audited by username only, never the password', async () => {
    await setupAndLoginAdmin();
    await h.call(
      C.auth.login,
      { username: 'ghost', password: 'plaintext-secret-xyz' },
      5,
    );
    await h.call(
      C.auth.login,
      { username: 'admin', password: 'plaintext-secret-abc' },
      5,
    );
    const audit = rows(
      "SELECT action, cashier_id, metadata FROM audit_log WHERE action LIKE 'LOGIN_%' ORDER BY id",
    );
    expect(audit.map((r) => r.action)).toEqual([
      'LOGIN_SUCCEEDED',
      'LOGIN_FAILED',
      'LOGIN_FAILED',
    ]);
    expect(JSON.parse(String(audit[1]!.metadata))).toEqual({
      username: 'ghost',
    });
    expect(json(audit)).not.toContain('plaintext-secret');
  });

  test('protected commands need a session, then the right role', async () => {
    await setupAndLoginAdmin();
    const noSession = failure(await h.call(C.cashiers.list, undefined, 42));
    expect(noSession.code).toBe('UNAUTHENTICATED');

    await createCashier();
    value(
      await h.call(
        C.auth.login,
        { username: 'siti', password: 'siti-password-1' },
        CASHIER_WINDOW,
      ),
    );
    const cashierAdminOperation = failure(
      await h.call(C.cashiers.list, undefined, CASHIER_WINDOW),
    );
    expect(cashierAdminOperation.code).toBe('FORBIDDEN');
    value(
      await h.call(
        C.settings.updatePreferences,
        { language: 'en', appearance: 'DARK' },
        CASHIER_WINDOW,
      ),
    );
    expect(
      rows(
        "SELECT language, appearance FROM cashiers WHERE username='Admin'",
      )[0],
    ).toEqual({ language: 'id', appearance: 'SYSTEM' });
    expect(rows('SELECT language, appearance FROM settings')[0]).toEqual({
      language: 'id',
      appearance: 'SYSTEM',
    });
    for (const [channel, input] of [
      [
        C.cashiers.create,
        {
          username: 'x1x',
          displayName: 'X',
          password: 'password-123',
          role: 'CASHIER',
        },
      ],
      [
        C.settings.updateShop,
        { name: 'N', address: 'A', timezone: 'Asia/Jakarta' },
      ],
      [C.app.openLogFolder, undefined],
    ] as const) {
      expect(failure(await h.call(channel, input, CASHIER_WINDOW)).code).toBe(
        'FORBIDDEN',
      );
      expect(failure(await h.call(channel, input, 77)).code).toBe(
        'UNAUTHENTICATED',
      );
    }
    expect(h.opened).toEqual([]);
  });

  test('logout ends only that window session and is audited', async () => {
    await setupAndLoginAdmin();
    value(
      await h.call(
        C.auth.login,
        { username: 'admin', password: ADMIN_PASSWORD },
        8,
      ),
    );
    value(await h.call(C.auth.logout, undefined, ADMIN_WINDOW));
    expect(
      failure(await h.call(C.cashiers.list, undefined, ADMIN_WINDOW)).code,
    ).toBe('UNAUTHENTICATED');
    expect(
      value(await h.call(C.auth.currentSession, undefined, 8)),
    ).not.toBeNull();
    expect(
      rows("SELECT * FROM audit_log WHERE action = 'LOGOUT'"),
    ).toHaveLength(1);
    // Logout without a session is a harmless no-op.
    value(await h.call(C.auth.logout, undefined, ADMIN_WINDOW));
    expect(
      rows("SELECT * FROM audit_log WHERE action = 'LOGOUT'"),
    ).toHaveLength(1);
  });

  test('deactivation, role change, password reset and window close invalidate sessions', async () => {
    await setupAndLoginAdmin();
    const siti = await createCashier();
    const login = (windowId: number, password = 'siti-password-1') =>
      h.call(C.auth.login, { username: 'siti', password }, windowId);
    const alive = async (windowId: number) =>
      value(await h.call(C.auth.currentSession, undefined, windowId)) !== null;

    // deactivation (two windows for the same cashier)
    value(await login(10));
    value(await login(11));
    value(
      await h.call(C.cashiers.deactivate, { cashierId: siti.id }, ADMIN_WINDOW),
    );
    expect(await alive(10)).toBe(false);
    expect(await alive(11)).toBe(false);
    value(
      await h.call(C.cashiers.reactivate, { cashierId: siti.id }, ADMIN_WINDOW),
    );

    // role change
    value(await login(10));
    value(
      await h.call(
        C.cashiers.changeRole,
        { cashierId: siti.id, role: 'ADMIN' },
        ADMIN_WINDOW,
      ),
    );
    expect(await alive(10)).toBe(false);

    // password reset
    value(await login(10));
    value(
      await h.call(
        C.cashiers.resetPassword,
        { cashierId: siti.id, newPassword: 'brand-new-password' },
        ADMIN_WINDOW,
      ),
    );
    expect(await alive(10)).toBe(false);
    expect(failure(await login(10)).code).toBe('INVALID_CREDENTIALS');
    value(await login(10, 'brand-new-password'));

    // window close
    expect(await alive(10)).toBe(true);
    h.services.sessions.endWindow(10);
    expect(await alive(10)).toBe(false);
    expect(await alive(ADMIN_WINDOW)).toBe(true);
  });
});

describe('cashier management', () => {
  test('list, create, rename and audit', async () => {
    await setupAndLoginAdmin();
    const siti = await createCashier();
    expect(siti).toMatchObject({
      username: 'siti',
      displayName: 'Siti',
      role: 'CASHIER',
      isActive: true,
    });
    expect(JSON.stringify(siti)).not.toMatch(/hash|password/i);

    const renamed = value(
      await h.call<CashierDto>(
        C.cashiers.updateDisplayName,
        { cashierId: siti.id, displayName: 'Siti Aminah' },
        ADMIN_WINDOW,
      ),
    );
    expect(renamed.displayName).toBe('Siti Aminah');

    const list = value(
      await h.call<CashierDto[]>(C.cashiers.list, undefined, ADMIN_WINDOW),
    );
    expect(list.map((c) => c.username)).toEqual(['Admin', 'siti']);
    expect(list.every((c) => typeof c.isActive === 'boolean')).toBe(true);
    expect(() => JSON.stringify(list)).not.toThrow();

    const actions = rows('SELECT action FROM audit_log ORDER BY id').map(
      (r) => r.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'CASHIER_CREATED',
        'CASHIER_DISPLAY_NAME_CHANGED',
      ]),
    );
    const created = rows(
      "SELECT * FROM audit_log WHERE action = 'CASHIER_CREATED'",
    )[0]!;
    expect(json(created)).not.toContain('siti-password-1');
  });

  test('usernames are unique case-insensitively', async () => {
    await setupAndLoginAdmin();
    await createCashier();
    for (const username of ['siti', 'SITI', 'Siti', 'ADMIN']) {
      const error = failure(
        await h.call(
          C.cashiers.create,
          {
            username,
            displayName: 'Dup',
            password: 'password-123',
            role: 'CASHIER',
          },
          ADMIN_WINDOW,
        ),
      );
      expect(error.code).toBe('USERNAME_TAKEN');
    }
    expect(rows('SELECT * FROM cashiers')).toHaveLength(2);
  });

  test('the saved cashier stores a salted hash, never the plaintext password', async () => {
    await setupAndLoginAdmin();
    const plaintextPassword = 'siti-password-1';
    const a = await createCashier();
    const b = await createCashier({ username: 'ani', displayName: 'Ani' });
    const [savedCashier] = rows(
      'SELECT password_hash AS passwordHash FROM cashiers WHERE id = ?',
      a.id,
    );
    const [other] = rows(
      'SELECT password_hash AS passwordHash FROM cashiers WHERE id = ?',
      b.id,
    );
    expect(String(savedCashier!.passwordHash)).not.toContain(plaintextPassword);
    expect(savedCashier!.passwordHash).not.toBe(other!.passwordHash);
  });

  test('the last active ADMIN cannot be deactivated or demoted, even by themselves', async () => {
    const admin = await setupAndLoginAdmin();
    const deactivate = failure(
      await h.call(
        C.cashiers.deactivate,
        { cashierId: admin.cashierId },
        ADMIN_WINDOW,
      ),
    );
    expect(deactivate.code).toBe('LAST_ACTIVE_ADMIN');
    const demote = failure(
      await h.call(
        C.cashiers.changeRole,
        { cashierId: admin.cashierId, role: 'CASHIER' },
        ADMIN_WINDOW,
      ),
    );
    expect(demote.code).toBe('LAST_ACTIVE_ADMIN');
    // Still logged in and unchanged.
    expect(
      value(await h.call(C.auth.currentSession, undefined, ADMIN_WINDOW)),
    ).not.toBeNull();

    // A second admin lifts the restriction; a deactivated admin does not count.
    const second = await createCashier({
      username: 'boss2',
      displayName: 'Boss',
      role: 'ADMIN',
    });
    value(
      await h.call(
        C.cashiers.deactivate,
        { cashierId: admin.cashierId },
        ADMIN_WINDOW,
      ),
    );
    // Now `second` is the last active admin.
    value(
      await h.call(
        C.auth.login,
        { username: 'boss2', password: 'siti-password-1' },
        3,
      ),
    );
    const again = failure(
      await h.call(
        C.cashiers.changeRole,
        { cashierId: second.id, role: 'CASHIER' },
        3,
      ),
    );
    expect(again.code).toBe('LAST_ACTIVE_ADMIN');
    // Reactivating the first admin makes demotion possible again.
    value(
      await h.call(C.cashiers.reactivate, { cashierId: admin.cashierId }, 3),
    );
    value(
      await h.call(
        C.cashiers.changeRole,
        { cashierId: second.id, role: 'CASHIER' },
        3,
      ),
    );
  });

  test('unknown cashier ids give CASHIER_NOT_FOUND', async () => {
    await setupAndLoginAdmin();
    const error = failure(
      await h.call(
        C.cashiers.deactivate,
        { cashierId: '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11' },
        ADMIN_WINDOW,
      ),
    );
    expect(error.code).toBe('CASHIER_NOT_FOUND');
  });

  test('cashiers can never be deleted', async () => {
    const admin = await setupAndLoginAdmin();
    expect(() =>
      h.db.prepare('DELETE FROM cashiers WHERE id = ?').run(admin.cashierId),
    ).toThrow(/cannot be deleted/);
  });

  test('reset password validates length and audits without the password', async () => {
    await setupAndLoginAdmin();
    const siti = await createCashier();
    const short = failure(
      await h.call(
        C.cashiers.resetPassword,
        { cashierId: siti.id, newPassword: 'short' },
        ADMIN_WINDOW,
      ),
    );
    expect(short.code).toBe('VALIDATION_FAILED');
    value(
      await h.call(
        C.cashiers.resetPassword,
        { cashierId: siti.id, newPassword: 'reset-secret-987' },
        ADMIN_WINDOW,
      ),
    );
    const audit = rows(
      "SELECT * FROM audit_log WHERE action = 'CASHIER_PASSWORD_RESET'",
    );
    expect(audit).toHaveLength(1);
    expect(json(audit)).not.toContain('reset-secret-987');
  });
});

describe('settings updates', () => {
  test('preference updates require an authenticated session', async () => {
    const result = failure(
      await h.call(
        C.settings.updatePreferences,
        { language: 'en', appearance: 'DARK' },
        88,
      ),
    );
    expect(result.code).toBe('UNAUTHENTICATED');
  });

  test('updateShop and updatePreferences persist, validate and audit', async () => {
    await setupAndLoginAdmin();
    value(
      await h.call(
        C.settings.updateShop,
        {
          name: 'Bengkel Baru',
          address: 'Jl. Baru 2',
          email: 'a@b.co',
          timezone: 'Asia/Makassar',
          invoiceFooter: 'Terima kasih',
        },
        ADMIN_WINDOW,
      ),
    );
    value(
      await h.call(
        C.settings.updatePreferences,
        { language: 'en', appearance: 'LIGHT' },
        ADMIN_WINDOW,
      ),
    );
    const settings = rows('SELECT * FROM settings')[0]!;
    expect(settings).toMatchObject({
      shop_name: 'Bengkel Baru',
      timezone: 'Asia/Makassar',
      language: 'id',
      appearance: 'SYSTEM',
      invoice_footer: 'Terima kasih',
      phone_number: null,
    });
    expect(
      rows(
        "SELECT language, appearance FROM cashiers WHERE username='Admin'",
      )[0],
    ).toEqual({ language: 'en', appearance: 'LIGHT' });
    expect(
      value(await h.call(C.auth.currentSession, undefined, ADMIN_WINDOW)),
    ).toMatchObject({ language: 'en', appearance: 'LIGHT' });
    expect(value(await h.call(C.settings.getPublic))).toMatchObject({
      language: 'id',
      shopName: 'Bengkel Baru',
    });
    const actions = rows('SELECT action FROM audit_log ORDER BY id').map(
      (r) => r.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['SHOP_SETTINGS_UPDATED', 'PREFERENCES_UPDATED']),
    );
    expect(
      JSON.parse(
        String(
          rows(
            "SELECT metadata FROM audit_log WHERE action='PREFERENCES_UPDATED'",
          )[0]!.metadata,
        ),
      ),
    ).toEqual({
      language: { from: 'id', to: 'en' },
      appearance: { from: 'SYSTEM', to: 'LIGHT' },
    });
    value(
      await h.call(
        C.settings.updatePreferences,
        { language: 'en', appearance: 'DARK' },
        ADMIN_WINDOW,
      ),
    );
    expect(
      JSON.parse(
        String(
          rows(
            "SELECT metadata FROM audit_log WHERE action='PREFERENCES_UPDATED' ORDER BY id DESC LIMIT 1",
          )[0]!.metadata,
        ),
      ),
    ).toEqual({ appearance: { from: 'LIGHT', to: 'DARK' } });

    h.db
      .exec(`CREATE TRIGGER reject_preference_write BEFORE UPDATE OF language ON cashiers
      BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    const failedSave = failure(
      await h.call(
        C.settings.updatePreferences,
        { language: 'id', appearance: 'LIGHT' },
        ADMIN_WINDOW,
      ),
    );
    expect(failedSave.code).toBe('INTERNAL_ERROR');
    expect(
      value(await h.call(C.auth.currentSession, undefined, ADMIN_WINDOW)),
    ).toMatchObject({ language: 'en', appearance: 'DARK' });

    const invalid = failure(
      await h.call(
        C.settings.updatePreferences,
        { language: 'fr', appearance: 'LIGHT' },
        ADMIN_WINDOW,
      ),
    );
    expect(invalid.code).toBe('VALIDATION_FAILED');
    const badZone = failure(
      await h.call(
        C.settings.updateShop,
        { name: 'N', address: 'A', timezone: 'Nope' },
        ADMIN_WINDOW,
      ),
    );
    expect(badZone.fieldErrors).toHaveProperty('timezone');
  });
});

describe('log folder access', () => {
  test('ADMIN opens only the main-process-known log directory', async () => {
    await setupAndLoginAdmin();
    value(await h.call(C.app.openLogFolder, undefined, ADMIN_WINDOW));
    expect(h.opened).toEqual([h.logDir]);
    // The renderer cannot supply a path.
    const withPath = failure(
      await h.call(C.app.openLogFolder, '/etc', ADMIN_WINDOW),
    );
    expect(withPath.code).toBe('VALIDATION_FAILED');
    expect(h.opened).toEqual([h.logDir]);
  });
});
