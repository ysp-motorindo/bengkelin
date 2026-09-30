// Pure release checks over the contents of a packaged Bengkelin app.
// `scripts/release-check.mts` reads the package and calls these; each check
// returns a list of problems (empty = passed) so failures are specific.
import { createHash } from 'node:crypto';
import vm from 'node:vm';

export type Problems = string[];

// ---------------------------------------------------------------------------
// Migrations (bundled into main.cjs with import.meta.glob ?raw, T3)
// ---------------------------------------------------------------------------

const MIGRATION_KEY = /\.\/migrations\/(\d{3})_([a-z0-9_]+)\.sql/g;

export function bundledMigrationFiles(mainJs: string): string[] {
  const found = new Set<string>();
  for (const match of mainJs.matchAll(MIGRATION_KEY)) {
    found.add(`${match[1]}_${match[2]}.sql`);
  }
  return [...found].sort();
}

/** Names of the tables, indexes and triggers a migration creates. */
export function createdObjects(sql: string): string[] {
  const names = new Set<string>();
  const pattern =
    /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const match of sql.matchAll(pattern)) names.add(match[1]!);
  return [...names];
}

export function checkMigrations(
  mainJs: string,
  source: ReadonlyMap<string, string>,
): Problems {
  const problems: Problems = [];
  const bundled = bundledMigrationFiles(mainJs);
  const expected = [...source.keys()].sort();
  if (bundled.length === 0) {
    return ['no migrations found in the main bundle (.vite/build/main.cjs)'];
  }
  bundled.forEach((file, index) => {
    const version = Number(file.slice(0, 3));
    if (version !== index + 1) {
      problems.push(
        `bundled migrations are not contiguous from 001: found ${file} at position ${index + 1}`,
      );
    }
  });
  for (const file of expected) {
    if (!bundled.includes(file)) {
      problems.push(`migration ${file} is missing from the main bundle`);
    }
  }
  for (const file of bundled) {
    if (!source.has(file)) {
      problems.push(
        `bundle has migration ${file} that is not in src/main/database/migrations`,
      );
    }
  }
  // The SQL itself is inlined, not just the file name.
  for (const [file, sql] of source) {
    for (const name of createdObjects(sql)) {
      if (!new RegExp(`\\b${name}\\b`).test(mainJs)) {
        problems.push(`${file}: "${name}" is not in the main bundle`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Locales (bundled into the renderer with import.meta.glob, T4)
// ---------------------------------------------------------------------------

export type LocaleTree = Record<string, unknown>;
/** lang -> namespace -> translations. */
export type Locales = Record<string, Record<string, LocaleTree>>;

const LOCALE_KEY =
  /["'`]\.\.\/locales\/([a-z]+)\/([A-Za-z0-9-]+)\.json["'`]\s*:/g;

/**
 * The JS expression starting at `start` (an object literal or a
 * `JSON.parse("...")` call), ending before the `,` or `}` that follows it
 * at depth zero. String and template literals are skipped.
 */
export function expressionAt(text: string, start: number): string {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\') i += 1;
        else if (ch === '`' && text[i] === '$' && text[i + 1] === '{') {
          throw new Error(
            `template expression inside a locale literal at ${i}`,
          );
        }
        i += 1;
      }
    } else if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0) break;
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    } else if (ch === ',' && depth === 0) {
      break;
    }
    i += 1;
  }
  return text.slice(start, i);
}

/** Every `../locales/<lang>/<ns>.json` module inlined in the renderer JS. */
export function bundledLocales(rendererJs: string): Locales {
  const locales: Locales = {};
  for (const match of rendererJs.matchAll(LOCALE_KEY)) {
    const [, lang, ns] = match;
    const start = match.index + match[0].length;
    const expression = expressionAt(rendererJs, start).trim();
    // Our own build output (an object literal or JSON.parse of a string),
    // evaluated in an empty context with a time limit.
    const value = vm.runInNewContext(`(${expression})`, Object.create(null), {
      timeout: 1000,
    }) as unknown;
    if (!value || typeof value !== 'object') {
      throw new Error(`locale ${lang}/${ns} is not an object`);
    }
    (locales[lang!] ??= {})[ns!] = value as LocaleTree;
  }
  return locales;
}

export function flattenKeys(tree: unknown, prefix = ''): string[] {
  if (tree === null || typeof tree !== 'object') return [prefix];
  return Object.entries(tree as Record<string, unknown>)
    .flatMap(([key, value]) =>
      flattenKeys(value, prefix ? `${prefix}.${key}` : key),
    )
    .sort();
}

function difference(a: string[], b: string[]): string[] {
  const other = new Set(b);
  return a.filter((x) => !other.has(x));
}

function sample(items: string[]): string {
  return items.length > 5
    ? `${items.slice(0, 5).join(', ')} (+${items.length - 5} more)`
    : items.join(', ');
}

export function checkLocales(
  bundled: Locales,
  source: Locales,
  languages: readonly string[] = ['id', 'en'],
): Problems {
  const problems: Problems = [];
  for (const lang of languages) {
    if (!bundled[lang]) problems.push(`locale "${lang}" is not in the bundle`);
    if (!source[lang]) problems.push(`locale "${lang}" is not in the source`);
  }
  if (problems.length) return problems;
  const [first, ...others] = languages;
  // Key parity between the bundled languages, per namespace.
  for (const lang of others) {
    const a = Object.keys(bundled[first!]!).sort();
    const b = Object.keys(bundled[lang]!).sort();
    for (const ns of difference(a, b)) {
      problems.push(`namespace ${ns} is bundled for ${first} but not ${lang}`);
    }
    for (const ns of difference(b, a)) {
      problems.push(`namespace ${ns} is bundled for ${lang} but not ${first}`);
    }
    for (const ns of a.filter((n) => b.includes(n))) {
      const ka = flattenKeys(bundled[first!]![ns]);
      const kb = flattenKeys(bundled[lang]![ns]);
      const onlyA = difference(ka, kb);
      const onlyB = difference(kb, ka);
      if (onlyA.length) {
        problems.push(`${ns}: keys only in ${first}: ${sample(onlyA)}`);
      }
      if (onlyB.length) {
        problems.push(`${ns}: keys only in ${lang}: ${sample(onlyB)}`);
      }
    }
  }
  // The bundle carries exactly the source translations.
  for (const lang of languages) {
    for (const [ns, tree] of Object.entries(source[lang]!)) {
      const packed = bundled[lang]![ns];
      if (!packed) {
        problems.push(`${lang}/${ns}.json is missing from the renderer bundle`);
        continue;
      }
      if (JSON.stringify(packed) !== JSON.stringify(tree)) {
        problems.push(`${lang}/${ns}.json in the bundle differs from source`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Print and report templates (main bundle, T12/T13)
// ---------------------------------------------------------------------------

/** A string each template's CSS/markup contains (source file for context). */
export const TEMPLATE_MARKERS = [
  {
    template: 'A4 invoice',
    source: 'src/main/features/printing/templates/a4.ts',
    marker: '.layout-a4 .doc-number',
  },
  {
    template: '58 mm thermal receipt',
    source: 'src/main/features/printing/templates/thermal-58.ts',
    marker: '.sheet.layout-58',
  },
  {
    template: '80 mm thermal receipt',
    source: 'src/main/features/printing/templates/thermal-80.ts',
    marker: '.sheet.layout-80',
  },
  {
    template: 'thermal page rules',
    source: 'src/main/features/printing/templates/thermal-common.ts',
    marker: 'export function thermalCss',
    bundleMarker: '@page',
  },
  {
    template: 'daily report (A4)',
    source: 'src/main/features/reports/template.ts',
    marker: '.layout-a4 .doc-date',
  },
  {
    template: 'daily report basis line',
    source: 'src/main/features/reports/template.ts',
    marker: '.layout-a4 .basis',
  },
] as const;

export function checkTemplates(
  mainJs: string,
  readSource: (file: string) => string,
): Problems {
  const problems: Problems = [];
  for (const entry of TEMPLATE_MARKERS) {
    if (!readSource(entry.source).includes(entry.marker)) {
      problems.push(
        `${entry.template}: marker "${entry.marker}" no longer in ${entry.source}; update TEMPLATE_MARKERS`,
      );
      continue;
    }
    const inBundle =
      'bundleMarker' in entry ? entry.bundleMarker : entry.marker;
    if (!mainJs.includes(inBundle)) {
      problems.push(
        `${entry.template}: "${inBundle}" is not in the main bundle`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Remote runtime references in the renderer bundle (spec A.5: no CDN)
// ---------------------------------------------------------------------------

/**
 * `http(s)://` strings the renderer bundle may contain because they are
 * never requested. Each entry says why. A new URL in the bundle fails the
 * check until it is either removed or reviewed and listed here.
 */
export const REMOTE_URL_ALLOWLIST: readonly {
  url: string;
  match: 'exact' | 'prefix';
  reason: string;
}[] = [
  {
    url: 'http://www.w3.org/2000/svg',
    match: 'exact',
    reason: 'XML namespace identifier (React DOM createElementNS)',
  },
  {
    url: 'http://www.w3.org/1999/xlink',
    match: 'exact',
    reason: 'XML namespace identifier (React DOM SVG attributes)',
  },
  {
    url: 'http://www.w3.org/1999/xhtml',
    match: 'exact',
    reason: 'XML namespace identifier (React DOM)',
  },
  {
    url: 'http://www.w3.org/1998/Math/MathML',
    match: 'exact',
    reason: 'XML namespace identifier (React DOM)',
  },
  {
    url: 'http://www.w3.org/XML/1998/namespace',
    match: 'exact',
    reason: 'XML namespace identifier (React DOM xml:* attributes)',
  },
  {
    url: 'http://json-schema.org/',
    match: 'prefix',
    reason: 'JSON Schema "$schema" identifier strings in zod (never fetched)',
  },
  {
    url: 'https://json-schema.org/',
    match: 'prefix',
    reason: 'JSON Schema "$schema" identifier strings in zod (never fetched)',
  },
  {
    url: 'http://[${',
    match: 'prefix',
    reason:
      'zod IPv6 validator builds "http://[<address>]" to parse with new URL() (never requested)',
  },
  {
    url: 'https://react.dev/errors/',
    match: 'prefix',
    reason: 'documentation link inside React production error messages',
  },
  {
    url: 'https://react.i18next.com/',
    match: 'prefix',
    reason: 'documentation link inside a react-i18next warning message',
  },
];

const URL_TOKEN = /\bhttps?:\/\/[^\s"'`<>()\\,;]*/gi;

function stripCssComments(css: string): { code: string; comments: string } {
  let comments = '';
  const code = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => {
    comments += comment;
    return '';
  });
  return { code, comments };
}

export interface RemoteReferenceReport {
  problems: Problems;
  /** Allowlisted occurrences per allowlist entry (for the log). */
  allowed: Map<string, number>;
  /** URLs only inside CSS comments (never loaded). */
  inComments: string[];
}

export function checkRemoteReferences(
  files: readonly { path: string; text: string }[],
): RemoteReferenceReport {
  const problems: Problems = [];
  const allowed = new Map<string, number>();
  const inComments: string[] = [];
  for (const file of files) {
    let code = file.text;
    if (file.path.endsWith('.css')) {
      const stripped = stripCssComments(file.text);
      code = stripped.code;
      inComments.push(
        ...[...stripped.comments.matchAll(URL_TOKEN)].map(
          (m) => `${file.path}: ${m[0]}`,
        ),
      );
      if (/url\(\s*['"]?\/\//i.test(code)) {
        problems.push(`${file.path}: protocol-relative url(//...)`);
      }
    }
    if (file.path.endsWith('.html')) {
      if (/\b(?:src|href)\s*=\s*["']?\/\//i.test(code)) {
        problems.push(`${file.path}: protocol-relative src/href`);
      }
    }
    for (const match of code.matchAll(URL_TOKEN)) {
      const url = match[0];
      const entry = REMOTE_URL_ALLOWLIST.find((e) =>
        e.match === 'exact' ? url === e.url : url.startsWith(e.url),
      );
      if (entry && !file.path.endsWith('.html')) {
        allowed.set(entry.url, (allowed.get(entry.url) ?? 0) + 1);
      } else {
        const at = match.index;
        const context = code
          .slice(Math.max(0, at - 40), at + url.length + 20)
          .replace(/\s+/g, ' ');
        problems.push(`${file.path}: remote reference ${url} … ${context}`);
      }
    }
  }
  return { problems, allowed, inComments };
}

// ---------------------------------------------------------------------------
// Production CSP (index.html meta, T1)
// ---------------------------------------------------------------------------

function decodeEntities(text: string): string {
  return text
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function parseCspMeta(html: string): Map<string, string[]> | null {
  const meta =
    /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=["']([^"']*)["']/i.exec(
      html,
    );
  if (!meta) return null;
  const directives = new Map<string, string[]>();
  for (const part of decodeEntities(meta[1]!).split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), values);
  }
  return directives;
}

export function checkCsp(html: string): Problems {
  const problems: Problems = [];
  const csp = parseCspMeta(html);
  if (!csp) return ['index.html has no Content-Security-Policy meta'];
  const metaAt = html.search(/<meta\s+http-equiv=["']Content-Security-Policy/i);
  const scriptAt = html.search(/<script\b/i);
  if (scriptAt >= 0 && metaAt > scriptAt) {
    problems.push('the CSP meta comes after a <script>');
  }
  const exactly = (name: string, value: string) => {
    const values = csp.get(name);
    if (!values || values.join(' ') !== value) {
      problems.push(
        `CSP ${name} must be ${value}, found ${values ? values.join(' ') : '(missing)'}`,
      );
    }
  };
  exactly('default-src', "'self'");
  exactly('script-src', "'self'");
  exactly('object-src', "'none'");
  exactly('base-uri', "'none'");
  exactly('frame-src', "'none'");
  exactly('form-action', "'none'");
  for (const [name, values] of csp) {
    for (const value of values) {
      const lower = value.toLowerCase();
      if (
        lower === '*' ||
        lower.includes('://') ||
        /^(https?|wss?|ftp):$/.test(lower) ||
        lower.includes('*.')
      ) {
        problems.push(`CSP ${name} allows a remote source: ${value}`);
      }
      if (lower === "'unsafe-eval'" || lower === "'unsafe-inline'") {
        // Inline style attributes only (React style props); never scripts.
        if (name !== 'style-src-attr') {
          problems.push(`CSP ${name} allows ${value}`);
        }
      }
      if (lower === 'data:' && name !== 'img-src') {
        problems.push(`CSP ${name} allows data: (only img-src may)`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Fuses (read from the packaged binary with @electron/fuses)
// ---------------------------------------------------------------------------

export const FUSE_ENABLE = 49; // FuseState.ENABLE ('1')
export const FUSE_DISABLE = 48; // FuseState.DISABLE ('0')

export function checkFuseWire(
  wire: Record<string, unknown>,
  expected: Record<number, boolean>,
  names: Record<number, string>,
): Problems {
  const problems: Problems = [];
  for (const [index, want] of Object.entries(expected)) {
    const name = names[Number(index)] ?? `fuse ${index}`;
    const state = wire[index];
    const wanted = want ? FUSE_ENABLE : FUSE_DISABLE;
    if (state === undefined) {
      problems.push(`${name}: not present in the binary's fuse wire`);
    } else if (state !== wanted) {
      problems.push(
        `${name}: expected ${want ? 'ENABLED' : 'DISABLED'}, binary has ${describeFuse(state)}`,
      );
    }
  }
  for (const index of Object.keys(wire)) {
    if (index === 'version') continue;
    if (!(index in expected)) {
      problems.push(
        `fuse ${index} (${names[Number(index)] ?? 'unknown'}) exists in the binary but is not decided in production-fuses.mts`,
      );
    }
  }
  return problems;
}

function describeFuse(state: unknown): string {
  if (state === FUSE_ENABLE) return 'ENABLED';
  if (state === FUSE_DISABLE) return 'DISABLED';
  if (state === 114) return 'REMOVED';
  if (state === 144) return 'INHERIT';
  return String(state);
}

// ---------------------------------------------------------------------------
// DevTools off in production (window.ts `devTools: isDevelopment`)
// ---------------------------------------------------------------------------

export function checkDevTools(
  mainJs: string,
  otherBundles: readonly { path: string; text: string }[],
): Problems {
  const problems: Problems = [];
  const settings = [...mainJs.matchAll(/\bdevTools:([^,}]+)/g)].map((m) =>
    m[1]!.trim(),
  );
  if (settings.length === 0) {
    problems.push('no devTools webPreference found in the main bundle');
  }
  for (const value of settings) {
    if (value === '!1' || value === 'false') continue;
    if (/^[A-Za-z_$][\w$]*$/.test(value)) {
      // A constant folded by the production build: `isDevelopment = !1`.
      const assignments = [
        ...mainJs.matchAll(
          new RegExp(
            `(?<![\\w$.])${value.replace(/\$/g, '\\$')}=([^,;]+)`,
            'g',
          ),
        ),
      ].map((m) => m[1]!.trim());
      if (
        assignments.length > 0 &&
        assignments.every((a) => a === '!1' || a === 'false')
      ) {
        continue;
      }
      problems.push(
        `devTools:${value} is not constant false (assignments: ${assignments.join(' | ') || 'none'})`,
      );
      continue;
    }
    problems.push(`devTools:${value} is not false`);
  }
  for (const { path, text } of [
    { path: 'main.cjs', text: mainJs },
    ...otherBundles,
  ]) {
    for (const call of ['openDevTools', 'toggleDevTools', 'toggledevtools']) {
      if (text.includes(call)) {
        problems.push(`${path} contains ${call}`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Test-only environment hooks (R3 and T12/T14–T17 hooks)
// ---------------------------------------------------------------------------

const HOOK = /\bBENGKELIN_[A-Z0-9_]+\b/g;

function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

/**
 * Top-level functions of a source file: from a column-0 `function`/
 * `export function` line to the next column-0 `}`.
 */
function topLevelFunctions(lines: string[]): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^(export\s+)?(async\s+)?function\b/.test(lines[i]!)) {
      let end = i;
      while (end < lines.length && !lines[end]!.startsWith('}')) end += 1;
      spans.push({ start: i, end });
      i = end;
    }
  }
  return spans;
}

export interface HookUse {
  hook: string;
  file: string;
  line: number;
  gated: boolean;
}

/** Every hook read in the source, and whether its function checks isPackaged. */
export function hookUses(
  sources: readonly { path: string; text: string }[],
): HookUse[] {
  const uses: HookUse[] = [];
  for (const source of sources) {
    const lines = stripTsComments(source.text).split('\n');
    const spans = topLevelFunctions(lines);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(HOOK)) {
        const span = spans.find((s) => index >= s.start && index <= s.end);
        const body = span
          ? lines.slice(span.start, span.end + 1).join('\n')
          : line;
        uses.push({
          hook: match[0],
          file: source.path,
          line: index + 1,
          gated: /\bisPackaged\b/.test(body),
        });
      }
    });
  }
  return uses;
}

export function checkTestHooks(
  uses: readonly HookUse[],
  mainJs: string,
  otherBundles: readonly { path: string; text: string }[],
): Problems {
  const problems: Problems = [];
  if (uses.length === 0) {
    problems.push('no BENGKELIN_* hooks found in src (expected the R3 hooks)');
  }
  for (const use of uses) {
    if (!use.gated) {
      problems.push(
        `${use.file}:${use.line} reads ${use.hook} in a function that never checks app.isPackaged`,
      );
    }
  }
  for (const hook of new Set(uses.map((u) => u.hook))) {
    if (!mainJs.includes(hook)) {
      problems.push(`${hook} is read in src but not in the main bundle`);
    }
  }
  for (const bundle of otherBundles) {
    for (const match of new Set(bundle.text.match(HOOK) ?? [])) {
      problems.push(`${bundle.path} references ${match} (hooks are main-only)`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Native SQLite binding (better-sqlite3 prebuild, unpacked from the asar)
// ---------------------------------------------------------------------------

export function prebuildTarget(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}

/** Problems with the binary's format for the target platform/arch. */
export function checkNativeBinary(
  bytes: Buffer,
  platform: string,
  arch: string,
): Problems {
  if (platform === 'linux') {
    if (bytes.readUInt32BE(0) !== 0x7f454c46) return ['not an ELF binary'];
    const machine = bytes.readUInt16LE(18);
    const want = arch === 'x64' ? 0x3e : arch === 'arm64' ? 0xb7 : -1;
    return machine === want
      ? []
      : [`ELF machine 0x${machine.toString(16)} is not ${arch}`];
  }
  if (platform === 'win32') {
    if (bytes.toString('latin1', 0, 2) !== 'MZ') return ['not a PE binary'];
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.toString('latin1', pe, pe + 4) !== 'PE\0\0') {
      return ['missing PE signature'];
    }
    const machine = bytes.readUInt16LE(pe + 4);
    const want = arch === 'x64' ? 0x8664 : arch === 'arm64' ? 0xaa64 : -1;
    return machine === want
      ? []
      : [`PE machine 0x${machine.toString(16)} is not ${arch}`];
  }
  if (platform === 'darwin') {
    const magic = bytes.readUInt32LE(0);
    if (bytes.readUInt32BE(0) === 0xcafebabe) return []; // universal
    if (magic !== 0xfeedfacf) return ['not a 64-bit Mach-O binary'];
    const cpu = bytes.readUInt32LE(4);
    const want =
      arch === 'x64' ? 0x01000007 : arch === 'arm64' ? 0x0100000c : -1;
    return cpu === want
      ? []
      : [`Mach-O cputype 0x${cpu.toString(16)} is not ${arch}`];
  }
  return [`unsupported platform ${platform}`];
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
