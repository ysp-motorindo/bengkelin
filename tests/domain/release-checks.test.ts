import { describe, expect, test } from 'vitest';
import {
  bundledLocales,
  checkCsp,
  checkDevTools,
  checkFuseWire,
  checkLocales,
  checkMigrations,
  checkNativeBinary,
  checkRemoteReferences,
  checkTestHooks,
  hookUses,
} from '../../scripts/release/checks.mts';

/**
 * The pure checks behind `npm run release:check` (T18): each must fail with
 * a specific message on a broken package, not only pass on a good one.
 */

describe('migrations', () => {
  const source = new Map([
    ['001_a.sql', 'CREATE TABLE alpha (id TEXT);'],
    [
      '002_b.sql',
      'CREATE TRIGGER beta_guard BEFORE DELETE ON alpha BEGIN END;',
    ],
  ]);
  const bundle = (...keys: string[]) =>
    `const m={${keys.map((k) => `"./migrations/${k}":\`...\``).join(',')}};alpha;beta_guard`;

  test('all present and contiguous: no problems', () => {
    expect(checkMigrations(bundle('001_a.sql', '002_b.sql'), source)).toEqual(
      [],
    );
  });

  test('a missing or non-contiguous migration is reported', () => {
    const problems = checkMigrations(bundle('001_a.sql', '003_c.sql'), source);
    expect(problems).toContain(
      'bundled migrations are not contiguous from 001: found 003_c.sql at position 2',
    );
    expect(problems).toContain(
      'migration 002_b.sql is missing from the main bundle',
    );
  });

  test('SQL not inlined is reported', () => {
    const js = `"./migrations/001_a.sql":1,"./migrations/002_b.sql":1,alpha`;
    expect(checkMigrations(js, source)).toEqual([
      '002_b.sql: "beta_guard" is not in the main bundle',
    ]);
  });
});

describe('locales', () => {
  const js = [
    'var x={"../locales/en/auth.json":{login:{title:`Sign in`,user:"User"}},',
    '"../locales/id/auth.json":{login:{title:`Masuk`,user:"Pengguna"}},',
    '"../locales/en/errors.json":JSON.parse(\'{"A":"a, b {x}"}\'),',
    '"../locales/id/errors.json":{A:`a`}};',
  ].join('');

  test('object literals and JSON.parse modules are read', () => {
    const locales = bundledLocales(js);
    expect(locales.en!.errors).toEqual({ A: 'a, b {x}' });
    expect(locales.id!.auth).toEqual({
      login: { title: 'Masuk', user: 'Pengguna' },
    });
  });

  test('key parity and source equality are enforced', () => {
    const bundled = bundledLocales(js);
    const source = structuredClone({ en: bundled.en!, id: bundled.id! });
    expect(checkLocales(bundled, source)).toEqual([]);
    delete (bundled.id!.auth!.login as Record<string, unknown>).user;
    expect(checkLocales(bundled, source)).toEqual([
      'auth: keys only in en: login.user',
      'id/auth.json in the bundle differs from source',
    ]);
    delete bundled.en;
    expect(checkLocales(bundled, source)).toEqual([
      'locale "en" is not in the bundle',
    ]);
  });
});

describe('remote references', () => {
  test('allowlisted namespaces pass; an unknown URL fails with context', () => {
    const report = checkRemoteReferences([
      {
        path: 'a.js',
        text: 'createElementNS("http://www.w3.org/2000/svg","svg");fetch("https://cdn.example.com/x.js")',
      },
      {
        path: 'a.css',
        text: '/*! tailwindcss | https://tailwindcss.com */ .x{background:url(https://fonts.example/f.woff)}',
      },
    ]);
    expect(report.allowed.get('http://www.w3.org/2000/svg')).toBe(1);
    expect(report.inComments).toEqual(['a.css: https://tailwindcss.com']);
    expect(report.problems).toHaveLength(2);
    expect(report.problems[0]).toMatch(
      /^a\.js: remote reference https:\/\/cdn\.example\.com\/x\.js/,
    );
    expect(report.problems[1]).toMatch(
      /^a\.css: remote reference https:\/\/fonts\.example/,
    );
  });

  test('protocol-relative references in HTML are refused', () => {
    const report = checkRemoteReferences([
      {
        path: 'index.html',
        text: '<script src="//cdn.example/x.js"></script>',
      },
    ]);
    expect(report.problems).toEqual(['index.html: protocol-relative src/href']);
  });
});

describe('CSP', () => {
  const policy = (p: string) =>
    `<head><meta http-equiv="Content-Security-Policy" content="${p}"><script src="./a.js"></script></head>`;
  const production =
    'default-src &#39;self&#39;; script-src &#39;self&#39;; style-src &#39;self&#39;; style-src-attr &#39;unsafe-inline&#39;; img-src &#39;self&#39; data:; object-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;; frame-src &#39;none&#39;';

  test('the production policy passes', () => {
    expect(checkCsp(policy(production))).toEqual([]);
  });

  test('missing meta, remote sources and unsafe scripts fail', () => {
    expect(checkCsp('<head></head>')).toEqual([
      'index.html has no Content-Security-Policy meta',
    ]);
    const problems = checkCsp(
      policy(
        production.replace(
          'script-src &#39;self&#39;',
          'script-src &#39;self&#39; https://cdn.example &#39;unsafe-eval&#39;',
        ),
      ),
    );
    expect(problems).toContain(
      "CSP script-src must be 'self', found 'self' https://cdn.example 'unsafe-eval'",
    );
    expect(problems).toContain(
      'CSP script-src allows a remote source: https://cdn.example',
    );
    expect(problems).toContain("CSP script-src allows 'unsafe-eval'");
  });
});

describe('fuses', () => {
  const names = { 0: 'RunAsNode', 1: 'EnableCookieEncryption' };
  test('matching wire passes; a flipped or undecided fuse fails', () => {
    expect(
      checkFuseWire(
        { 0: 48, 1: 49, version: '1' },
        { 0: false, 1: true },
        names,
      ),
    ).toEqual([]);
    expect(
      checkFuseWire({ 0: 49, 1: 49, 2: 48 }, { 0: false, 1: true }, names),
    ).toEqual([
      'RunAsNode: expected DISABLED, binary has ENABLED',
      'fuse 2 (unknown) exists in the binary but is not decided in production-fuses.mts',
    ]);
  });
});

describe('DevTools', () => {
  test('a constant-false devTools passes; true or openDevTools fails', () => {
    expect(
      checkDevTools('var eA=!1;new B({devTools:eA});new B({devTools:!1})', []),
    ).toEqual([]);
    expect(checkDevTools('new B({devTools:!0})', [])).toEqual([
      'devTools:!0 is not false',
    ]);
    expect(
      checkDevTools(
        'var d=!1;new B({devTools:d});w.webContents.openDevTools()',
        [],
      ),
    ).toEqual(['main.cjs contains openDevTools']);
  });
});

describe('test-only hooks', () => {
  const gated = `export function hook(app, env) {
  if (app.isPackaged) return null;
  return env.BENGKELIN_TEST_X;
}
`;
  const ungated = `// BENGKELIN_TEST_Y is mentioned in a comment only
export function other(env) {
  return env.BENGKELIN_TEST_Y;
}
`;

  test('a hook read without an isPackaged check is reported', () => {
    const uses = hookUses([
      { path: 'a.ts', text: gated },
      { path: 'b.ts', text: ungated },
    ]);
    expect(uses.map((u) => [u.hook, u.gated])).toEqual([
      ['BENGKELIN_TEST_X', true],
      ['BENGKELIN_TEST_Y', false],
    ]);
    expect(
      checkTestHooks(uses, 'BENGKELIN_TEST_X BENGKELIN_TEST_Y', [
        { path: 'preload.cjs', text: 'BENGKELIN_TEST_X' },
      ]),
    ).toEqual([
      'b.ts:3 reads BENGKELIN_TEST_Y in a function that never checks app.isPackaged',
      'preload.cjs references BENGKELIN_TEST_X (hooks are main-only)',
    ]);
  });
});

describe('native binary format', () => {
  test('ELF machine must match the target arch', () => {
    const elf = Buffer.alloc(64);
    elf.writeUInt32BE(0x7f454c46, 0);
    elf.writeUInt16LE(0x3e, 18);
    expect(checkNativeBinary(elf, 'linux', 'x64')).toEqual([]);
    expect(checkNativeBinary(elf, 'linux', 'arm64')).toEqual([
      'ELF machine 0x3e is not arm64',
    ]);
    expect(checkNativeBinary(Buffer.from('MZ...'), 'linux', 'x64')).toEqual([
      'not an ELF binary',
    ]);
  });
});
