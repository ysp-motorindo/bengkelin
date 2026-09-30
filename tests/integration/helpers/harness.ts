import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, type AppDatabase } from '@/main/database/connection';
import { migrateDatabase } from '@/main/database/migrate';
import { createApplicationServices } from '@/main/compose';
import { executeCommand } from '@/main/platform/command';
import { buildCommands } from '@/main/platform/commands';
import type { Result } from '@/shared/primitives';
import { toInstant, type Clock } from '@/shared/time';

export const ADMIN_PASSWORD = 'correct-horse-battery';

export function validSetup(overrides: Record<string, unknown> = {}) {
  return {
    shop: {
      name: 'Bengkel Maju Jaya',
      address: 'Jl. Merdeka No. 1, Bandung',
      phoneNumber: '081234567890',
      timezone: 'Asia/Jakarta',
    },
    admin: {
      username: 'Admin',
      displayName: 'Pak Budi',
      password: ADMIN_PASSWORD,
    },
    preferences: { language: 'id', appearance: 'SYSTEM' },
    ...overrides,
  };
}

/** A migrated temp database plus the full command table, without Electron. */
export function createHarness(options: { clock?: Clock } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bengkelin-auth-'));
  const file = path.join(dir, 'db.sqlite');
  const clock: Clock = options.clock ?? {
    now: () => toInstant(Date.UTC(2026, 8, 30, 3, 0, 0)),
  };
  const logDir = path.join(dir, 'logs');
  const opened: string[] = [];

  function build() {
    const db: AppDatabase = openDatabase(file);
    migrateDatabase(db);
    const services = createApplicationServices({
      db,
      clock,
      logDir,
      openPath: async (target) => {
        opened.push(target);
        return '';
      },
    });
    const commands = new Map(
      buildCommands(services).map((c) => [c.channel, c]),
    );
    return { db, services, commands };
  }

  let current = build();

  /** Invokes a channel exactly as IPC would (validation, Result mapping). */
  async function call<T = unknown>(
    channel: string,
    input?: unknown,
    windowId = 1,
  ): Promise<Result<T>> {
    const command = current.commands.get(channel);
    if (!command) throw new Error(`Unknown channel ${channel}`);
    return (await executeCommand(
      command,
      { windowId },
      input,
      current.services.logger,
    )) as Result<T>;
  }

  return {
    get db() {
      return current.db;
    },
    get services() {
      return current.services;
    },
    dir,
    file,
    logDir,
    opened,
    call,
    /**
     * Closes the connection and opens the same file again with fresh
     * services (an app restart: every session is gone).
     */
    reopen() {
      current.db.close();
      current = build();
    },
    close() {
      if (current.db.open) current.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;

export function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`Expected ok, got ${JSON.stringify(result)}`);
  return result.value;
}

export function failure<T>(result: Result<T>) {
  if (result.ok) throw new Error('Expected an error result');
  return result.error;
}
