import { describe, expect, test } from 'vitest';
import { isTrustedAppUrl } from '@/main/platform/trust';

const prod = { indexFileUrl: 'file:///opt/app/renderer/index.html' };
const dev = { devServerUrl: 'http://localhost:5173' };

describe('isTrustedAppUrl', () => {
  test('accepts only the bundled index file in production', () => {
    expect(isTrustedAppUrl('file:///opt/app/renderer/index.html', prod)).toBe(
      true,
    );
    expect(
      isTrustedAppUrl('file:///opt/app/renderer/index.html#/x?y=1', prod),
    ).toBe(true);
    expect(isTrustedAppUrl('file:///opt/app/renderer/other.html', prod)).toBe(
      false,
    );
    expect(isTrustedAppUrl('file:///etc/passwd', prod)).toBe(false);
  });

  test('rejects remote, data, blank and malformed URLs', () => {
    for (const url of [
      'https://example.com/',
      'http://localhost:5173/',
      'data:text/html,hi',
      'about:blank',
      'javascript:alert(1)',
      '',
      'not a url',
    ]) {
      expect(isTrustedAppUrl(url, prod)).toBe(false);
    }
  });

  test('accepts only the dev-server origin in development', () => {
    expect(isTrustedAppUrl('http://localhost:5173/', dev)).toBe(true);
    expect(isTrustedAppUrl('http://localhost:5173/index.html', dev)).toBe(true);
    expect(isTrustedAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isTrustedAppUrl('http://localhost:5173.evil.com/', dev)).toBe(false);
    expect(isTrustedAppUrl('https://localhost:5173/', dev)).toBe(false);
  });
});
