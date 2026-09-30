import { readFileSync } from 'node:fs';
import path from 'node:path';

export type Lang = 'id' | 'en';

const localesDir = path.resolve(__dirname, '../../../src/renderer/locales');

/** Looks up a UI string from the shipped locale files: tr('en', 'auth.login.title'). */
export function tr(lang: Lang, key: string): string {
  const [namespace, ...rest] = key.split('.');
  const file = path.join(localesDir, lang, `${namespace}.json`);
  let node: unknown = JSON.parse(readFileSync(file, 'utf8'));
  for (const part of rest) {
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'string')
    throw new Error(`Missing locale key ${lang}:${key}`);
  return node;
}
