import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runTests } from './helpers/run-tests.js';
import { trialContainerWords } from '../src/merge-writer/trial-container.js';

test('integration:test-postgres-clean-stop — a cluster a test file leaves running is stopped, not aborted, before its data goes, and test and trial runs disable core dumps', async () => {
  const scratch = await temporaryDirectory('clean-stop'), report = join(scratch, 'report.json');
  const run = await runTests({ args: ['tests/fixtures/leaves-postgres-running.ts'], stdio: 'pipe', environment: { ...process.env, CLEAN_STOP_REPORT: report } });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const { data, pid, core } = JSON.parse(await readFile(report, 'utf8')) as { data: string; pid: number; core: string };
  assert.equal(core, '0', 'the runner starts the test files, and every Postgres they start, with core dumps off');
  assert.throws(() => process.kill(pid, 0), 'the postmaster is gone once the file has exited');
  assert.equal(existsSync(data), false, 'its data directory is removed after it stopped');
  const log = await readFile(join(scratch, 'postgres.log'), 'utf8');
  assert.match(log, /database system is shut down/);
  assert.doesNotMatch(log, /PANIC|terminated by signal|abort/i, log);
  // The merge trial's container carries the same limit for everything it runs.
  if (!existsSync('/etc/graphyard-trial')) assert.match(trialContainerWords([scratch]).join(' '), /'--ulimit', 'core=0'/);
});
