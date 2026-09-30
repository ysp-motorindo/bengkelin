import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * TEST-ONLY network observation for e2e launches, covering the whole life
 * of every launched process (from before the first window):
 *  - Chromium traffic (renderers, the hidden print window, any session,
 *    main-process `net`): `--log-net-log=<file>` records every URL request
 *    and host resolution; `--host-resolver-rules` makes every non-local
 *    name unresolvable, so nothing can actually leave the machine;
 *  - main-process Node traffic (http, https, fetch, net, tls): the
 *    `fixtures/net-guard.cjs` hook, preloaded with `-r` (the way Playwright
 *    loads its own loader; Playwright deletes NODE_OPTIONS), records and
 *    refuses every non-local socket connect.
 * One guard accumulates across restarts: each launch gets its own net-log
 * file in `dir`, and `nonLocalActivity()` reads them all.
 */
const guardHook = path.resolve(__dirname, '../fixtures/net-guard.cjs');

const LOCAL_URL =
  /^(file|data|blob|devtools|chrome|chrome-extension|chrome-error|about|wss?:\/\/(localhost|127\.|\[::1\])|https?:\/\/(localhost|127\.|\[::1\]))/i;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

export class NetworkGuard {
  private launches = 0;

  constructor(readonly dir: string) {}

  /** Switches and environment for one launch (pass to launchApp). */
  launchOptions(): { args: string[]; env: Record<string, string> } {
    this.launches += 1;
    return {
      args: [
        '-r',
        guardHook,
        `--log-net-log=${path.join(this.dir, `netlog-${this.launches}.json`)}`,
        '--net-log-capture-mode=Everything',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
      ],
      env: {
        BENGKELIN_TEST_NET_GUARD_LOG: path.join(this.dir, 'node-sockets.log'),
      },
    };
  }

  /** Net-log files written so far (one per closed launch). */
  netLogFiles(): string[] {
    return readdirSync(this.dir)
      .filter((name) => /^netlog-\d+\.json$/.test(name))
      .map((name) => path.join(this.dir, name));
  }

  /**
   * Every non-local request or host lookup seen by Chromium, and every
   * non-local socket connect attempted by main-process Node. Read after the
   * app has closed (the net-log is flushed on exit).
   */
  nonLocalActivity(): string[] {
    const found: string[] = [];
    for (const file of this.netLogFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/"url":"([^"]*)"/g)) {
        const url = match[1]!;
        if (!LOCAL_URL.test(url)) found.push(`chromium url ${url}`);
      }
      for (const match of text.matchAll(/"host":"([^"]*)"/g)) {
        const host = match[1]!.replace(/:\d+$/, '').replace(/^.*\/\//, '');
        if (host !== '' && !LOCAL_HOST.test(host)) {
          found.push(`chromium host ${match[1]}`);
        }
      }
    }
    const nodeLog = path.join(this.dir, 'node-sockets.log');
    if (existsSync(nodeLog)) {
      for (const line of readFileSync(nodeLog, 'utf8').split('\n')) {
        if (line.trim()) found.push(`main node socket ${line.trim()}`);
      }
    }
    return found;
  }

  /**
   * Events in each net-log, parsed as complete JSON: proves every log was
   * written and flushed on exit (a truncated log could hide requests).
   */
  netLogEventCounts(): number[] {
    return this.netLogFiles().map((file) => {
      const log = JSON.parse(readFileSync(file, 'utf8')) as {
        events?: unknown[];
      };
      return log.events?.length ?? 0;
    });
  }
}
