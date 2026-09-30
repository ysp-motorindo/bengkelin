// `npm run release:check [-- --app <packaged app folder>]`
//
// Inspects the PACKAGED app (default: out/Bengkelin-<platform>-<arch> from
// `npm run package`) and fails with a specific message for each problem:
// app metadata, bundled migrations, both locales with key parity, print and
// report templates, the platform better-sqlite3 binary unpacked from the
// asar, no remote runtime references in the renderer, the production CSP,
// the fuses, DevTools off, and test-only hooks gated on app.isPackaged.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { openAsar, type AsarArchive } from './release/asar.mts';
import {
  bundledLocales,
  checkCsp,
  checkDevTools,
  checkFuseWire,
  checkLocales,
  checkMigrations,
  checkNativeBinary,
  checkRemoteReferences,
  checkTemplates,
  checkTestHooks,
  hookUses,
  prebuildTarget,
  REMOTE_URL_ALLOWLIST,
  sha256,
  type Locales,
  type Problems,
} from './release/checks.mts';
import {
  layoutFromArgs,
  missingLayoutParts,
  PRODUCT_NAME,
  type PackageLayout,
} from './release/package-layout.mts';
import { PRODUCTION_FUSE_SETTINGS } from './release/production-fuses.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = '.vite/build/main.cjs';
const PRELOAD = '.vite/build/preload.cjs';
const RENDERER = '.vite/renderer/main_window';

interface Result {
  name: string;
  problems: Problems;
  notes: string[];
}
const results: Result[] = [];

async function check(
  name: string,
  run: () =>
    | Problems
    | { problems: Problems; notes: string[] }
    | Promise<Problems>,
): Promise<void> {
  try {
    const outcome = await run();
    results.push(
      Array.isArray(outcome)
        ? { name, problems: outcome, notes: [] }
        : { name, ...outcome },
    );
  } catch (error) {
    results.push({
      name,
      problems: [`check crashed: ${(error as Error).message}`],
      notes: [],
    });
  }
}

function readSource(file: string): string {
  return readFileSync(path.join(root, file), 'utf8');
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function sourceMigrations(): Map<string, string> {
  const dir = path.join(root, 'src/main/database/migrations');
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => [f, readFileSync(path.join(dir, f), 'utf8')]),
  );
}

function sourceLocales(): Locales {
  const dir = path.join(root, 'src/renderer/locales');
  const locales: Locales = {};
  for (const lang of readdirSync(dir)) {
    for (const file of readdirSync(path.join(dir, lang))) {
      if (!file.endsWith('.json')) continue;
      (locales[lang] ??= {})[file.replace(/\.json$/, '')] = JSON.parse(
        readFileSync(path.join(dir, lang, file), 'utf8'),
      );
    }
  }
  return locales;
}

function text(asar: AsarArchive, file: string): string {
  const content = asar.readText(file);
  if (content === null) throw new Error(`${file} is missing from app.asar`);
  return content;
}

async function run(layout: PackageLayout): Promise<void> {
  console.log(`Release check: ${layout.appDir}`);
  const missing = missingLayoutParts(layout);
  if (missing.length) {
    results.push({ name: 'package layout', problems: missing, notes: [] });
    return;
  }
  results.push({ name: 'package layout', problems: [], notes: [] });
  const asar = openAsar(layout.asarPath);
  const files = asar.files();
  const mainJs = text(asar, MAIN);
  const preloadJs = text(asar, PRELOAD);
  const rendererFiles = files
    .filter((f) => f.startsWith(`${RENDERER}/`))
    .map((f) => ({ path: f, text: text(asar, f) }));
  const rendererJs = rendererFiles
    .filter((f) => f.path.endsWith('.js'))
    .map((f) => f.text)
    .join('\n');

  await check('app metadata', () => {
    const problems: Problems = [];
    const pkg = JSON.parse(text(asar, 'package.json')) as Record<
      string,
      unknown
    >;
    const repo = JSON.parse(readSource('package.json')) as Record<
      string,
      unknown
    >;
    if (pkg.productName !== PRODUCT_NAME) {
      problems.push(
        `productName is ${JSON.stringify(pkg.productName)}, expected "${PRODUCT_NAME}"`,
      );
    }
    if (pkg.main !== MAIN) problems.push(`main is ${String(pkg.main)}`);
    if (pkg.version !== repo.version) {
      problems.push(
        `version ${String(pkg.version)} != ${String(repo.version)}`,
      );
    }
    if (
      typeof pkg.description !== 'string' ||
      /My Electron application/i.test(pkg.description)
    ) {
      problems.push('description is still the Forge template placeholder');
    }
    return problems;
  });

  await check('migrations bundled (contiguous from 001)', () => {
    const source = sourceMigrations();
    const problems = checkMigrations(mainJs, source);
    return {
      problems,
      notes: [
        `${source.size} migrations: ${[...source.keys()][0]} .. ${[...source.keys()].at(-1)}`,
      ],
    };
  });

  await check('locales id + en with key parity', () => {
    const bundled = bundledLocales(rendererJs);
    const problems = checkLocales(bundled, sourceLocales());
    const count = (lang: string) => Object.keys(bundled[lang] ?? {}).length;
    return {
      problems,
      notes: [`namespaces: id ${count('id')}, en ${count('en')}`],
    };
  });

  await check('print and report templates bundled', () =>
    checkTemplates(mainJs, readSource),
  );

  await check('native better-sqlite3 binding unpacked', () => {
    const problems: Problems = [];
    const target = prebuildTarget(layout.platform, layout.arch);
    const relative = `node_modules/better-sqlite3/prebuilds/${target}.node`;
    const file = path.join(layout.unpackedDir, relative);
    const entry = asar.entry(relative);
    if (!existsSync(file)) {
      problems.push(`${relative} is not in app.asar.unpacked`);
    } else {
      const bytes = readFileSync(file);
      problems.push(...checkNativeBinary(bytes, layout.platform, layout.arch));
      if (!entry?.unpacked) {
        problems.push(`${relative} is not marked unpacked in the asar header`);
      } else if (entry.integrity && entry.integrity.hash !== sha256(bytes)) {
        problems.push(`${relative} does not match its asar integrity hash`);
      }
    }
    for (const f of files.filter((f) => f.endsWith('.node'))) {
      if (!asar.entry(f)?.unpacked) {
        problems.push(`${f} is packed inside app.asar (cannot be loaded)`);
      }
    }
    for (const need of [
      'node_modules/better-sqlite3/package.json',
      'node_modules/better-sqlite3/lib/index.js',
    ]) {
      if (!files.includes(need)) problems.push(`${need} missing from app.asar`);
    }
    if (!/require\(["'`]better-sqlite3["'`]\)/.test(mainJs)) {
      problems.push('main bundle does not require("better-sqlite3")');
    }
    return { problems, notes: [relative] };
  });

  await check('no remote runtime references in the renderer', () => {
    const report = checkRemoteReferences(rendererFiles);
    const notes = [...report.allowed].map(
      ([url, n]) =>
        `allowlisted ${n}x ${url} (${REMOTE_URL_ALLOWLIST.find((e) => e.url === url)?.reason})`,
    );
    notes.push(...report.inComments.map((c) => `in a CSS comment: ${c}`));
    return { problems: report.problems, notes };
  });

  await check('production CSP meta', () =>
    checkCsp(text(asar, `${RENDERER}/index.html`)),
  );

  await check('fuses', async () => {
    const wire = (await getCurrentFuseWire(layout.executable)) as Record<
      string,
      unknown
    >;
    return checkFuseWire(
      wire,
      PRODUCTION_FUSE_SETTINGS,
      FuseV1Options as unknown as Record<number, string>,
    );
  });

  await check('DevTools disabled in production', () =>
    checkDevTools(mainJs, [
      { path: 'preload.cjs', text: preloadJs },
      { path: 'renderer', text: rendererJs },
    ]),
  );

  await check('test-only hooks gated on app.isPackaged', () => {
    const sources = walk(path.join(root, 'src'))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .map((f) => ({
        path: path.relative(root, f),
        text: readFileSync(f, 'utf8'),
      }));
    const uses = hookUses(sources);
    const problems = checkTestHooks(uses, mainJs, [
      { path: 'preload.cjs', text: preloadJs },
      { path: 'renderer', text: rendererJs },
    ]);
    const hooks = [...new Set(uses.map((u) => u.hook))].sort();
    return { problems, notes: [`${hooks.length} hooks: ${hooks.join(', ')}`] };
  });
}

const layout = layoutFromArgs(process.argv.slice(2), root);
await run(layout);

let failed = 0;
for (const result of results) {
  const ok = result.problems.length === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${result.name}`);
  for (const problem of result.problems) console.log(`      ✘ ${problem}`);
  for (const note of result.notes) console.log(`      · ${note}`);
}
console.log(
  failed === 0
    ? `\nrelease:check passed (${results.length} checks) for ${layout.appDir}`
    : `\nrelease:check FAILED: ${failed} of ${results.length} checks`,
);
process.exit(failed === 0 ? 0 : 1);
