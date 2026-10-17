import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '@/renderer/app/App';
import { i18n, setLanguage } from '@/renderer/i18n';
import type { BengkelinApi } from '@/shared/bridge';
import type {
  CashierSession,
  PublicSettings,
  SetupInput,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
import { workspaceBridge } from './helpers/workspace-bridge';

const ok = <T,>(value: T): Result<T> => ({ ok: true, value });

const adminSession: CashierSession = {
  cashierId: '5b9e6a3e-4c1e-4a55-9c5b-0a8f3f0b9d11',
  username: 'admin',
  displayName: 'Pak Budi',
  role: 'ADMIN',
  language: 'id',
  appearance: 'SYSTEM',
};

function installBridge(
  settings: PublicSettings,
  overrides: {
    session?: CashierSession | null;
    login?: BengkelinApi['auth']['login'];
    completeSetup?: BengkelinApi['settings']['completeSetup'];
  } = {},
) {
  const workspace = workspaceBridge();
  const bridge = {
    ...workspace,
    auth: {
      login: overrides.login ?? vi.fn(async () => ok(adminSession)),
      logout: vi.fn(async () => ok(undefined)),
      currentSession: vi.fn(async () => ok(overrides.session ?? null)),
    },
    settings: {
      ...workspace.settings,
      getPublic: vi.fn(async () => ok(settings)),
      completeSetup:
        overrides.completeSetup ??
        vi.fn(async () => ok({ ...settings, setupCompleted: true })),
    },
  };
  (window as unknown as { bengkelin: unknown }).bengkelin = bridge;
  return bridge;
}

const base: PublicSettings = {
  setupCompleted: true,
  language: 'id',
  appearance: 'SYSTEM',
  shopName: 'Bengkel Maju',
};

afterEach(() => {
  setLanguage('id');
});

describe('login screen', () => {
  test.each([
    ['id', 'Masuk', 'Nama pengguna'],
    ['en', 'Sign in', 'Username'],
  ] as const)('renders in %s', async (language, title, usernameLabel) => {
    installBridge({ ...base, language });
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: title }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(usernameLabel)).toBeInTheDocument();
    expect(document.documentElement.lang).toBe(language);
  });

  test('shows the translated messageKey on failure and never keeps the password', async () => {
    const login = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'INVALID_CREDENTIALS',
        messageKey: 'errors.INVALID_CREDENTIALS',
      },
    }));
    installBridge({ ...base, language: 'en' }, { login });
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.keyboard('{Enter}'); // keyboard-operable form
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Wrong username or password, or the account is disabled.',
    );
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  test('unknown messageKeys fall back to the generic message', async () => {
    const login = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'NEW_CODE', messageKey: 'errors.NOT_TRANSLATED_YET' },
    }));
    installBridge({ ...base, language: 'en' }, { login });
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Username'), 'a');
    await user.type(screen.getByLabelText('Password'), 'b');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /unexpected error/i,
    );
  });

  test('login shows the shell with name and role; logout returns to login', async () => {
    const bridge = installBridge({ ...base, language: 'en' });
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'correct-horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByTestId('session-name')).toHaveTextContent(
      'Pak Budi',
    );
    expect(screen.getByTestId('session-role')).toHaveTextContent('Admin');
    await user.click(screen.getByTestId('session-name'));
    await user.click(screen.getByRole('button', { name: /Sign out|Keluar/ }));
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(bridge.auth.logout).toHaveBeenCalledOnce();
  });

  test('an existing session restores the shell after reload', async () => {
    installBridge({ ...base, language: 'id' }, { session: adminSession });
    render(<App />);
    expect(await screen.findByTestId('session-role')).toHaveTextContent(
      'Admin',
    );
    await userEvent.click(screen.getByTestId('session-name'));
    expect(screen.getByRole('button', { name: 'Keluar' })).toBeInTheDocument();
  });
});

describe('carried fixes', () => {
  test('a rejected login call never leaves the form stuck busy', async () => {
    const login = vi.fn(async () => {
      throw new Error('ipc down');
    });
    installBridge({ ...base, language: 'en' }, { login });
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'whatever');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /unexpected error/i,
    );
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  test('UNAUTHENTICATED from any call returns to the login screen', async () => {
    const bridge = installBridge(
      { ...base, language: 'en' },
      { session: adminSession },
    );
    bridge.drafts.list = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'UNAUTHENTICATED', messageKey: 'errors.UNAUTHENTICATED' },
    }));
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
  });

  test('SETUP_ALREADY_COMPLETED sends the wizard to the login screen', async () => {
    const completeSetup = vi.fn(async (_input: SetupInput) => ({
      ok: false as const,
      error: {
        code: 'SETUP_ALREADY_COMPLETED',
        messageKey: 'errors.SETUP_ALREADY_COMPLETED',
      },
    }));
    const bridge = installBridge(
      { ...base, setupCompleted: false },
      { completeSetup },
    );
    render(<App />);
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText('Nama bengkel'),
      'Bengkel Maju',
    );
    await user.type(screen.getByLabelText('Alamat'), 'Jl. Merdeka 1');
    await user.click(screen.getByRole('button', { name: /Lanjut/ }));
    await user.type(await screen.findByLabelText('Nama pengguna'), 'admin');
    await user.type(screen.getByLabelText('Nama tampilan'), 'Pak Budi');
    await user.type(screen.getByLabelText('Kata sandi'), 'correct-horse');
    await user.type(
      screen.getByLabelText('Ulangi kata sandi'),
      'correct-horse',
    );
    await user.click(screen.getByRole('button', { name: /Lanjut/ }));
    bridge.settings.getPublic = vi.fn(async () => ok(base));
    await user.click(await screen.findByRole('button', { name: /Lanjut/ }));
    await user.click(await screen.findByRole('button', { name: 'Lewati' }));
    await user.click(await screen.findByRole('button', { name: 'Mulai' }));
    expect(
      await screen.findByRole('heading', { name: 'Masuk' }),
    ).toBeInTheDocument();
  });
});

describe('theme', () => {
  test('dark appearance sets the html class; light clears it', async () => {
    installBridge({ ...base, appearance: 'DARK' });
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { name: 'Masuk' });
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));
    unmount();
    installBridge({ ...base, appearance: 'LIGHT' });
    render(<App />);
    await screen.findByRole('heading', { name: 'Masuk' });
    await waitFor(() =>
      expect(document.documentElement).not.toHaveClass('dark'),
    );
  });
});

describe('setup wizard', () => {
  async function fillShopAndAdmin(user: ReturnType<typeof userEvent.setup>) {
    await user.type(
      await screen.findByLabelText('Nama bengkel'),
      'Bengkel Maju',
    );
    await user.type(screen.getByLabelText('Alamat'), 'Jl. Merdeka 1');
    await user.click(screen.getByRole('button', { name: /Lanjut/ }));
    await user.type(await screen.findByLabelText('Nama pengguna'), 'admin');
    await user.type(screen.getByLabelText('Nama tampilan'), 'Pak Budi');
    await user.type(screen.getByLabelText('Kata sandi'), 'correct-horse');
    await user.type(
      screen.getByLabelText('Ulangi kata sandi'),
      'correct-horse',
    );
    await user.click(screen.getByRole('button', { name: /Lanjut/ }));
  }

  test('validates each step with translated messages and blocks advancing', async () => {
    installBridge({ ...base, setupCompleted: false });
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Lanjut/ }));
    expect((await screen.findAllByText('Wajib diisi.')).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByLabelText('Nama bengkel')).toHaveAttribute(
      'aria-invalid',
      'true',
    );

    await user.type(screen.getByLabelText('Nama bengkel'), 'X');
    await user.type(screen.getByLabelText('Alamat'), 'Y');
    await user.click(screen.getByRole('button', { name: /Lanjut/ }));
    await user.type(await screen.findByLabelText('Nama pengguna'), 'admin');
    await user.type(screen.getByLabelText('Nama tampilan'), 'Budi');
    await user.type(screen.getByLabelText('Kata sandi'), 'short');
    await user.type(screen.getByLabelText('Ulangi kata sandi'), 'short');
    await user.click(screen.getByRole('button', { name: /Lanjut/ }));
    expect(
      await screen.findByText('Kata sandi minimal 8 karakter.'),
    ).toBeInTheDocument();
  });

  test('language and appearance apply live; skipped printer sends no printer', async () => {
    const completeSetup = vi.fn(async (_input: SetupInput) =>
      ok({ ...base, language: 'en' as const, appearance: 'DARK' as const }),
    );
    installBridge({ ...base, setupCompleted: false }, { completeSetup });
    render(<App />);
    const user = userEvent.setup();
    await fillShopAndAdmin(user);

    await user.selectOptions(await screen.findByLabelText('Bahasa'), 'en');
    expect(await screen.findByLabelText('Appearance')).toBeInTheDocument(); // now English
    await user.selectOptions(screen.getByLabelText('Appearance'), 'DARK');
    expect(document.documentElement).toHaveClass('dark');
    await user.click(screen.getByRole('button', { name: /Next/ }));

    // Printer step: skip.
    expect(
      await screen.findByRole('heading', { name: /Printer \(optional\)/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip' }));

    await user.click(await screen.findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(completeSetup).toHaveBeenCalledOnce());
    const sent = completeSetup.mock.calls[0]![0];
    expect(sent).not.toHaveProperty('printer');
    expect(sent.preferences).toEqual({ language: 'en', appearance: 'DARK' });
    expect(sent.admin.username).toBe('admin');
    // Completed setup lands on the login screen in the chosen language.
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
  });
});

describe('locale parity', () => {
  test('id and en define exactly the same keys', () => {
    const keys = (lang: string) => {
      const out: string[] = [];
      const walk = (node: unknown, prefix: string) => {
        if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) walk(v, `${prefix}${k}.`);
        } else out.push(prefix);
      };
      walk(i18n.getResourceBundle(lang, 'translation'), '');
      return out.sort();
    };
    expect(keys('id')).toEqual(keys('en'));
    expect(keys('id').length).toBeGreaterThan(50);
  });
});
