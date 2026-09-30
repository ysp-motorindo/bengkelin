// Chromium net-log analysis for the packaged smoke test. The same rules as
// the e2e NetworkGuard (tests/e2e/helpers/network-guard.ts): every URL
// request and host lookup that is not local is reported.

const LOCAL_URL =
  /^(file|data|blob|devtools|chrome|chrome-extension|chrome-error|about|wss?:\/\/(localhost|127\.|\[::1\])|https?:\/\/(localhost|127\.|\[::1\]))/i;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

export interface NetLogSummary {
  events: number;
  nonLocal: string[];
}

/** Parses a complete net-log (throws when truncated) and lists non-local activity. */
export function analyzeNetLog(text: string): NetLogSummary {
  const log = JSON.parse(text) as { events?: unknown[] };
  const nonLocal: string[] = [];
  for (const match of text.matchAll(/"url":"([^"]*)"/g)) {
    const url = match[1]!;
    if (!LOCAL_URL.test(url)) nonLocal.push(`url ${url}`);
  }
  for (const match of text.matchAll(/"host":"([^"]*)"/g)) {
    const host = match[1]!.replace(/:\d+$/, '').replace(/^.*\/\//, '');
    if (host !== '' && !LOCAL_HOST.test(host))
      nonLocal.push(`host ${match[1]}`);
  }
  return { events: log.events?.length ?? 0, nonLocal };
}
