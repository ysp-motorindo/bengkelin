import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
});
