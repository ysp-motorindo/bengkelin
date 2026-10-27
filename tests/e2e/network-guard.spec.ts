import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './helpers/launch';
import { NetworkGuard } from './helpers/network-guard';

let launched: LaunchedApp | undefined;
let guard: NetworkGuard;

test.beforeEach(async () => {
  guard = new NetworkGuard(
    await mkdtemp(path.join(tmpdir(), 'bengkelin-e2e-resolver-')),
  );
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(guard.dir, { recursive: true, force: true });
});

test('resolver rules block external DNS without resolving the replacement hostname', async () => {
  launched = await launchApp(guard.launchOptions());
  const result = await launched.app.evaluate(async ({ net }) => {
    let externalError: string | undefined;
    try {
      await net.resolveHost('offline-probe.invalid');
    } catch (error) {
      externalError = (error as Error).message;
    }
    const local = await net.resolveHost('localhost');
    return { externalError, local };
  });
  expect(result.externalError).toBe('net::ERR_NAME_NOT_RESOLVED');
  expect(result.local.endpoints.length).toBeGreaterThan(0);

  await launched.close();
  launched = undefined;
  expect(guard.netLogFiles()).toHaveLength(1);
  expect(guard.netLogEventCounts()[0]).toBeGreaterThan(0);
  expect(guard.nonLocalActivity()).toEqual([]);
});

test('blocked external HTTP requests remain visible to the network guard', async () => {
  launched = await launchApp(guard.launchOptions());
  const error = await launched.app.evaluate(async ({ net }) => {
    try {
      await net.fetch('http://offline-probe.invalid/');
    } catch (error) {
      return (error as Error).message;
    }
  });
  expect(error).toBe('net::ERR_NAME_NOT_RESOLVED');

  await launched.close();
  launched = undefined;
  expect(guard.netLogFiles()).toHaveLength(1);
  expect(guard.netLogEventCounts()[0]).toBeGreaterThan(0);
  expect(guard.nonLocalActivity()).toContain(
    'chromium url http://offline-probe.invalid/',
  );
});
