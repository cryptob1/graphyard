import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBackup, ledgerCounts, restoreBackup, verifyBackup } from '../backup.js';
import { Store } from '../store.js';
import { releaseInfo, schemaVersion } from '../release.js';
import { defineCommands } from './registry.js';

/**
 * Server-side maintenance over DATABASE_URL, never over the HTTP API: these commands run
 * where the database is reachable (the control-plane container or its host) and need no
 * Graphyard credential, so they never read the repository connection file. A backup is as
 * sensitive as the database itself.
 */
export const dbCommands = defineCommands([
  {
    name: 'db',
    readsConnection: () => false,
    help: [
      '  db migrate|status            Migrate or inspect the database named by DATABASE_URL (server host)',
      '  db backup FILE               Write a verified logical backup of the whole ledger (server host)',
      '  db verify FILE               Check a backup\'s digest and schema generation without restoring',
      '  db restore FILE              Restore a backup into an empty, migrated database (server host)',
    ],
    async run(context) {
      const { id, args, print } = context;
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('Set DATABASE_URL to the Graphyard database; db commands run on the control-plane host, not through the API');
      const store = new Store(url);
      try {
        if (id === 'migrate') { await store.init(); return print({ migrated: true, schema: await store.schema(), release: releaseInfo() }); }
        if (id === 'status') return print({ schema: await store.schema(), expectedSchema: schemaVersion, release: releaseInfo(), counts: await ledgerCounts(store.pool) });
        if (id === 'backup' && args.length === 1) {
          const backup = await createBackup(store.pool);
          await writeFile(resolve(args[0]), JSON.stringify(backup), { flag: 'wx', mode: 0o600 });
          return print({ file: args[0], takenAt: backup.takenAt, schema: backup.schemaVersion, digest: backup.digest, rows: Object.fromEntries(backup.tables.map(t => [t.name, t.rows.length])), note: 'Treat the file like the database: it holds private artifacts, evidence and credential hashes' });
        }
        if (id === 'verify' && args.length === 1) { const backup = verifyBackup(JSON.parse(await readFile(resolve(args[0]), 'utf8'))); return print({ file: args[0], valid: true, takenAt: backup.takenAt, graphyardVersion: backup.graphyardVersion, schema: backup.schemaVersion, rows: Object.fromEntries(backup.tables.map(t => [t.name, t.rows.length])) }); }
        if (id === 'restore' && args.length === 1) {
          const backup = verifyBackup(JSON.parse(await readFile(resolve(args[0]), 'utf8')));
          await store.init();
          const result = await restoreBackup(store.pool, backup);
          return print({ ...result, counts: await ledgerCounts(store.pool) });
        }
        throw new Error('Use db migrate | db status | db backup FILE | db verify FILE | db restore FILE');
      } finally { await store.close(); }
    },
  },
]);
