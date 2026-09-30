import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { resources } from '@/renderer/i18n';

/**
 * No renderer component may render a raw i18n key: every key passed to
 * `t(...)` (or declared as a `...Key` string such as `labelKey`) must
 * resolve to a string in BOTH languages. Static keys are checked exactly;
 * template keys (`shell.nav.${name}`) must at least resolve their static
 * prefix to an object in both languages. Server message keys
 * (`errors.*`, `validation.*`) are checked by the parity test and the
 * errors helper.
 */

const root = path.resolve(__dirname, '../../src/renderer');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === 'locales' ? [] : sourceFiles(full);
    }
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

type Tree = Record<string, unknown>;
const languages = Object.keys(resources);

function lookup(language: string, key: string): unknown {
  let node: unknown = resources[language]!.translation;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Tree)[part];
  }
  return node;
}

const NAMESPACE = /^[a-zA-Z]+\.[A-Za-z0-9_.]+$/;
const staticKeys = new Map<string, string>();
const templatePrefixes = new Map<string, string>();

for (const file of sourceFiles(root)) {
  const source = readFileSync(file, 'utf8');
  const where = path.relative(root, file);
  // t('ns.key') / t("ns.key") / i18n.t('ns.key')
  for (const match of source.matchAll(/\bt\(\s*(['"])([^'"\n]+)\1/g)) {
    staticKeys.set(match[2]!, where);
  }
  // t(`ns.prefix.${x}`) -> prefix must be an object
  for (const match of source.matchAll(/\bt\(\s*`([^`$]+)\$\{/g)) {
    if (match[1]!.includes('.')) templatePrefixes.set(match[1]!, where);
  }
  // Keys stored for later translation: fooKey: 'ns.key', 'ns.key' as const
  for (const match of source.matchAll(
    /[A-Za-z]*[kK]ey\s*[:=]\s*(['"])([a-zA-Z]+\.[A-Za-z0-9_.]+)\1/g,
  )) {
    staticKeys.set(match[2]!, where);
  }
}

describe('renderer i18n keys', () => {
  test('the scan finds the application strings', () => {
    expect(staticKeys.size).toBeGreaterThan(300);
    expect(staticKeys.has('workspace.search.label')).toBe(true);
  });

  test('every static key resolves to a string in id and en', () => {
    const missing: string[] = [];
    for (const [key, file] of staticKeys) {
      if (!NAMESPACE.test(key)) continue;
      for (const language of languages) {
        if (typeof lookup(language, key) !== 'string') {
          missing.push(`${language}:${key} (${file})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('every template key prefix resolves to a group in id and en', () => {
    const missing: string[] = [];
    for (const [prefix, file] of templatePrefixes) {
      // `ns.group.${x}` -> the group exists; `ns.group.item${n}` -> some
      // key of the group starts with `item`.
      const cut = prefix.lastIndexOf('.');
      const group = prefix.slice(0, cut);
      const stem = prefix.slice(cut + 1);
      for (const language of languages) {
        const node = lookup(language, group);
        const found =
          node !== null &&
          typeof node === 'object' &&
          Object.keys(node as Tree).some((key) => key.startsWith(stem));
        if (!found) missing.push(`${language}:${prefix}* (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
