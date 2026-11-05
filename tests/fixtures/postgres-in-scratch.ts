// Run by tests/test-postgres-clean-stop.test.ts through the suite's runner, the way test files
// start Postgres (tests/helpers/postgres.ts): a warm cluster whose data dir lies inside a suite
// temporary directory, stopped by the file's own after hook — which runs after the helpers' hook
// that removes that directory.
import { after, test } from 'node:test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { temporaryDirectory } from '../helpers/temp-dirs.js';
import { reserveTestPorts } from '../../src/cli/test-isolation.js';
import { copyTemplateCluster } from '../../src/e2e/warm-postgres.js';
import { postgresBinaries, startCluster, type LocalPaths, type RunningCluster } from '../../src/install/local-runtime.js';

const report = process.env.CLEAN_STOP_REPORT!;
let cluster: RunningCluster, release: () => void;
after(async () => { await cluster.stop(); release(); });

test('a cluster stopped by its file', async () => {
  const scratch = await temporaryDirectory('clean-stop'), data = join(scratch, 'pg');
  const reservation = await reserveTestPorts(), port = reservation.base;
  release = () => reservation.release();
  await copyTemplateCluster(data, port);
  cluster = await startCluster({ data } as LocalPaths, port, await postgresBinaries(), line => appendFileSync(join(dirname(report), 'postgres.log'), line));
  const core = readFileSync('/proc/self/limits', 'utf8').match(/^Max core file size\s+(\S+)/m)?.[1];
  writeFileSync(report, JSON.stringify({ data, pid: Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]), core }));
});
