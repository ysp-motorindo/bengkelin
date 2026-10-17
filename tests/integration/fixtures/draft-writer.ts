/**
 * Child process for the forced-process recovery test (drafts.test.ts).
 * Bundled with Vite by the test and run under Electron-as-Node. It opens an
 * EXISTING, migrated database, signs a cashier into window 1 and keeps adding
 * custom lines to one draft through the real command table. After every
 * acknowledged (committed) command it writes `ACK <version> <lineCount>` to
 * stdout synchronously, so the parent only ever sees acknowledged saves. The
 * parent kills it with SIGKILL mid-stream.
 */
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { createApplicationServices } from '@/main/compose';
import { openDatabase } from '@/main/database/connection';
import { executeCommand } from '@/main/platform/command';
import { buildCommands } from '@/main/platform/commands';
import { CHANNELS } from '@/shared/channels';
import type { DraftView } from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
import { toInstant } from '@/shared/time';

interface ChildConfig {
  dbPath: string;
  logDir: string;
  cashierId: string;
  draftId: string;
  version: number;
}

async function main(): Promise<void> {
  const config = JSON.parse(
    process.env.BENGKELIN_DRAFT_WRITER ?? '{}',
  ) as ChildConfig;
  const db = openDatabase(config.dbPath);
  const services = createApplicationServices({
    db,
    clock: { now: () => toInstant(Date.now()) },
    logDir: config.logDir,
    openPath: async () => '',
  });
  services.sessions.start({
    windowId: 1,
    cashierId: config.cashierId,
    username: 'siti',
    displayName: 'Siti',
    role: 'CASHIER',
    language: 'id',
    appearance: 'SYSTEM',
  });
  const apply = buildCommands(services).find(
    (c) => c.channel === CHANNELS.drafts.apply,
  )!;
  let version = config.version;
  for (let i = 1; i <= 100_000; i += 1) {
    const result = (await executeCommand(
      apply,
      { windowId: 1 },
      {
        requestId: randomUUID(),
        invoiceId: config.draftId,
        expectedVersion: version,
        op: {
          kind: 'addCustomLine',
          type: 'SERVICE',
          title: `Jasa ${i}`,
          unitPrice: '1000',
        },
      },
      services.logger,
    )) as Result<DraftView>;
    if (!result.ok) {
      writeSync(1, `ERR ${result.error.code}\n`);
      process.exit(2);
    }
    version = result.value.version;
    writeSync(1, `ACK ${version} ${result.value.lines.length}\n`);
  }
}

void main();
