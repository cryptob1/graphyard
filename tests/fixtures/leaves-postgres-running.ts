// Run by tests/test-postgres-clean-stop.test.ts through the suite's runner: a test file that starts
// a warm cluster through the suite helpers and never stops it, so the helpers' own teardown must.
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../helpers/temp-dirs.js';
import WarmPostgres from '../helpers/warm-postgres.js';

test('a cluster left running', async () => {
  const report = process.env.CLEAN_STOP_REPORT!, data = await temporaryDirectory('clean-stop-pg');
  const pg = new WarmPostgres({ databaseDir: data, user: 'graphyard', password: 'testing-only', port: Number(process.env.GRAPHYARD_TEST_PORT) + 7, persistent: true, onLog: () => {}, onError: () => {},
    postgresFlags: ['-h', '127.0.0.1', '-c', 'logging_collector=on', '-c', `log_directory=${join(report, '..')}`, '-c', 'log_filename=postgres.log'] });
  await pg.initialise(); await pg.start();
  const core = readFileSync('/proc/self/limits', 'utf8').match(/^Max core file size\s+(\S+)/m)?.[1];
  writeFileSync(report, JSON.stringify({ data, pid: Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]), core }));
});
