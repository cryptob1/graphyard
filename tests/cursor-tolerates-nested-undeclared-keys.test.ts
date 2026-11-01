import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { daemonStatePath, emptyDaemonState, readDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

async function fixture() {
  const root = await temporaryDirectory('cursor-nested-keys');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const directory = await temporaryDirectory('cursor-nested-keys-credentials');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const dispose = async () => { await rm(root, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); };
  return { root, master, file: daemonStatePath(master), dispose };
}

test('unit:cursor-tolerates-nested-undeclared-keys keeps a key retired from a strict object behind z.lazy across read and write (GY-2160)', async () => {
  const { root, master, file, dispose } = await fixture();
  try {
    // A cursor written while mergeWriter still declared retired nested objects (`advisory` ran the
    // per-merge advisory trial until GY-3002 dropped the field and its old value on read);
    // `mergeWriter` itself is a strict object reached through z.lazy, so a retired key at either
    // depth once refused the whole read.
    const base = emptyDaemonState(master);
    const stored = { ...base, cycle: 9, mergeWriter: { ...base.mergeWriter, retiredQueueField: 1, retiredLedger: { since: null, due: [], ran: [], unfiled: [] },
      advisory: { since: null, due: [{ key: 'GY-1', mergeSha: 'a'.repeat(40), deliveredAt: '2030-01-01T00:00:00Z' }], ran: [] } } };
    await writeFile(file, JSON.stringify(stored));

    const loaded = await readDaemonState(root, master);
    assert.equal(loaded.cycle, 9);
    assert.ok(!('advisory' in loaded.mergeWriter), 'the retired advisory obligation is dropped on read');
    assert.deepEqual((loaded as any).mergeWriter.retiredQueueField, 1, 'an undeclared key under the lazy strict mergeWriter object parses and is kept');
    assert.deepEqual((loaded as any).mergeWriter.retiredLedger.unfiled, [], 'a retired nested object parses and is kept');

    await writeDaemonState(master, loaded);
    const written = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(written.cycle, 9);
    assert.ok(!('advisory' in written.mergeWriter), 'the retired advisory obligation is not written back');
    assert.deepEqual(written.mergeWriter.retiredQueueField, 1, 'the kept key under mergeWriter is written back unchanged');
    assert.deepEqual(written.mergeWriter.retiredLedger.unfiled, [], 'the kept nested object is written back unchanged');

    // Reading the written cursor again keeps both keys: the tolerance holds however many parses
    // have already resolved the lazy getters in this process.
    const again = await readDaemonState(root, master);
    assert.ok(!('advisory' in again.mergeWriter), 'the obligation stays absent after a restart');
    assert.deepEqual((again as any).mergeWriter.retiredQueueField, 1);
    assert.deepEqual((again as any).mergeWriter.retiredLedger.unfiled, []);
  } finally { await dispose(); }
});
