// Run by tests/test-postgres-clean-stop.test.ts through the suite's runner, the way 128 test files
// start Postgres: a warm cluster whose data dir lies inside a suite temporary directory, stopped by
// the file's own after hook — which runs after the helpers' hook that removes that directory.
import { after, test } from 'node:test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { temporaryDirectory } from '../helpers/temp-dirs.js';
import WarmPostgres from '../helpers/warm-postgres.js';

const report = process.env.CLEAN_STOP_REPORT!;
let pg: WarmPostgres;
after(async () => { await pg.stop(); });

test('a cluster stopped by its file', async () => {
  const scratch = await temporaryDirectory('clean-stop'), data = join(scratch, 'pg');
  pg = new WarmPostgres({ databaseDir: data, user: 'graphyard', password: 'testing-only', port: Number(process.env.GRAPHYARD_TEST_PORT) + 7, persistent: false, onError: () => {},
    onLog: message => appendFileSync(join(dirname(report), 'postgres.log'), message), postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start();
  const core = readFileSync('/proc/self/limits', 'utf8').match(/^Max core file size\s+(\S+)/m)?.[1];
  writeFileSync(report, JSON.stringify({ data, pid: Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]), core }));
});
