import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
test('reference CSV reconciles all 46 detail rows to 11 customers and 243750942', () => {
  expect(() =>
    execFileSync(
      'python3',
      ['scripts/customer-piutang-reference.py', '--check'],
      { stdio: 'pipe' },
    ),
  ).not.toThrow();
});
