import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { AppDatabase } from '@/main/database/connection';
import { readSchemaVersion } from '@/main/database/identity';
import { toInstant } from '@/shared/time';
import {
  FakeDialogs,
  FakePrintDriver,
} from '../../integration/helpers/fake-print';
import { createHarness } from '../../integration/helpers/harness';
import { populateWorkshop } from './populate';

/** Row count of every table (sqlite_* excluded), by name. */
export function tableCounts(db: AppDatabase): Record<string, number> {
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  return Object.fromEntries(
    tables.map((name) => [
      name,
      Number(
        (
          db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as {
            n: bigint;
          }
        ).n,
      ),
    ]),
  );
}

/**
 * Builds the populated workshop database through the real commands at the
 * CURRENT schema and writes it, as one self-contained rollback-journal
 * file, to `outFile` (used by `npm run fixtures:db`).
 */
export async function generateFixture(outFile: string) {
  let nowMs = 0;
  const dialogs = new FakeDialogs();
  const h = createHarness({
    clock: { now: () => toInstant(nowMs) },
    printDriver: new FakePrintDriver(),
    dialogs,
  });
  try {
    const exportDir = path.join(h.dir, 'exports');
    mkdirSync(exportDir, { recursive: true });
    await populateWorkshop({
      call: h.call,
      setNow: (ms) => {
        nowMs = ms;
      },
      exportDir,
      answerSave: (file) => dialogs.saveAnswers.push(file),
    });

    h.db.exec(
      "INSERT INTO supplier_opening_balances SELECT id,'2026-10-31',100,'2026-11-01T00:00:00.000Z',(SELECT id FROM cashiers LIMIT 1) FROM suppliers LIMIT 1",
    );
    h.db.exec(
      "INSERT INTO supplier_opening_payments SELECT 'supplier-opening-payment',supplier_id,'CASH',50,'2026-11-01T00:00:00.000Z',NULL,NULL,(SELECT id FROM cashiers LIMIT 1),'Fixture' FROM supplier_opening_balances LIMIT 1",
    );

    const counts = tableCounts(h.db);
    const schemaVersion = readSchemaVersion(h.db);
    h.db.pragma('wal_checkpoint(TRUNCATE)');
    h.db.pragma('journal_mode = DELETE');
    h.db.exec('VACUUM');
    h.db.close();
    mkdirSync(path.dirname(outFile), { recursive: true });
    rmSync(outFile, { force: true });
    copyFileSync(h.file, outFile);
    return { schemaVersion, counts };
  } finally {
    h.close();
  }
}
