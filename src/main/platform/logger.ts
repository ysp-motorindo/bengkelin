import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '@/shared/time';

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export const noopLogger: Logger = { info() {}, warn() {}, error() {} };

// Keys whose values are never written: credentials and customer PII (spec 48).
// Matching is by substring, case-insensitive, so `passwordHash`, `newPassword`,
// `customerName`, `licensePlate`, `phoneNumber` etc. are all covered. This also
// covers `username` and `displayName`; technical logs identify nothing personal.
const REDACTED_KEY =
  /pass|hash|secret|token|salt|credential|name|phone|plate|address|email/i;
const REDACTED = '[redacted]';
const MAX_DEPTH = 4;
const MAX_STRING = 500;
const MAX_ENTRIES = 30;
const MAX_LINE_BYTES = 8 * 1024;

/** Deep, bounded, JSON-safe copy of `value` with sensitive keys removed. */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING
        ? `${value.slice(0, MAX_STRING)}...[truncated]`
        : value;
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return `[${typeof value}]`;
  }
  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return {
      errorType: value.name,
      ...(typeof code === 'string' ? { code } : {}),
      message: sanitizeForLog(value.message, depth + 1),
      stack: sanitizeForLog(value.stack, depth + 1),
    };
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ENTRIES)
      .map((item) => sanitizeForLog(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as object).slice(
    0,
    MAX_ENTRIES,
  )) {
    out[key] = REDACTED_KEY.test(key)
      ? REDACTED
      : sanitizeForLog(item, depth + 1);
  }
  return out;
}

export interface LoggerOptions {
  dir: string;
  clock: Clock;
  /** Size that triggers rotation (default 1 MB). */
  maxBytes?: number;
  /** Total files kept, including the active one (default 5). */
  maxFiles?: number;
}

/**
 * Small size-rotated JSON-lines logger: `bengkelin.log`, then
 * `bengkelin.log.1` (newest archive) ... `bengkelin.log.<maxFiles-1>`.
 * Synchronous appends keep the last lines on a crash; volume is tiny (startup,
 * failures), so blocking cost is irrelevant. Logging never throws.
 *
 * Callers pass small, explicit fields. Never pass whole command payloads: the
 * sanitizer is a safety net, not a licence.
 */
export function createLogger({
  dir,
  clock,
  maxBytes = 1_000_000,
  maxFiles = 5,
}: LoggerOptions): Logger {
  const active = path.join(dir, 'bengkelin.log');
  let size = 0;
  let ready = false;

  const archive = (index: number) => `${active}.${index}`;

  function prepare(): boolean {
    if (ready) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      size = fs.existsSync(active) ? fs.statSync(active).size : 0;
      ready = true;
    } catch {
      return false;
    }
    return true;
  }

  function rotate(): void {
    fs.rmSync(archive(maxFiles - 1), { force: true });
    for (let i = maxFiles - 2; i >= 1; i -= 1) {
      if (fs.existsSync(archive(i))) fs.renameSync(archive(i), archive(i + 1));
    }
    if (fs.existsSync(active)) fs.renameSync(active, archive(1));
    size = 0;
  }

  function write(
    level: LogLevel,
    event: string,
    fields?: Record<string, unknown>,
  ): void {
    try {
      if (!prepare()) return;
      let line = JSON.stringify({
        at: clock.now(),
        level,
        event,
        ...(fields ? (sanitizeForLog(fields) as object) : {}),
      });
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        line = JSON.stringify({
          at: clock.now(),
          level,
          event,
          truncated: true,
        });
      }
      line += '\n';
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) rotate();
      fs.appendFileSync(active, line);
      size += bytes;
    } catch {
      // A logging failure must never break the application.
    }
  }

  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}
