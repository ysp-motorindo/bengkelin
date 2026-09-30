// `npm run fixtures:db [-- <output file>]`
//
// Regenerates the committed populated-database fixture at the CURRENT
// schema (default: tests/fixtures/db/schema-v<NNN>-populated.sqlite) from
// tests/fixtures/db/populate.ts, which drives the app's real commands.
// A Vite SSR loader runs the TypeScript sources (path aliases and the
// import.meta.glob migrations work exactly as in the app and tests).
//
// Keep the committed files of earlier schema versions: each is a
// "previous-schema fixture" that tests/integration/migration-fixtures.test.ts
// upgrades to the latest schema.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const latest = readdirSync(path.join(root, 'src/main/database/migrations'))
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .sort()
  .at(-1)!
  .slice(0, 3);
const outFile = path.resolve(
  process.argv[2] ??
    path.join(root, `tests/fixtures/db/schema-v${latest}-populated.sqlite`),
);

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.main.config.mts'),
  logLevel: 'warn',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const module = (await server.ssrLoadModule(
    '/tests/fixtures/db/generate.ts',
  )) as typeof import('../tests/fixtures/db/generate.ts');
  const { schemaVersion, counts } = await module.generateFixture(outFile);
  console.log(
    `Wrote ${path.relative(root, outFile)} (schema v${schemaVersion})`,
  );
  for (const [table, n] of Object.entries(counts)) {
    console.log(`  ${table.padEnd(28)} ${n}`);
  }
} finally {
  await server.close();
}
