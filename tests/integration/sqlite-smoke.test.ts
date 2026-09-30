import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

test('better-sqlite3 loads under the Electron ABI and runs SQL in memory', () => {
  expect(process.versions.electron).toBeTruthy();
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('halo');
  expect(db.prepare('SELECT v FROM t').get()).toEqual({ v: 'halo' });
  db.close();
});
