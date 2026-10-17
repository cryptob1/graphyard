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
  const root = await temporaryDirectory('daemon-state-keys');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const directory = await temporaryDirectory('daemon-state-keys-credentials');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const dispose = async () => { await rm(root, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); };
  return { root, master, file: daemonStatePath(master), dispose };
}

test('unit:daemon-state-ignores-unknown-keys keeps undeclared keys across read and write (GY-1960), still rejects malformed declared ones', async () => {
  const { root, master, file, dispose } = await fixture();
  try {
    const base = { ...emptyDaemonState(master), cycle: 7 };
    await writeFile(file, JSON.stringify({ ...base, undeclaredByAnyVersion: { at: 'x' } }));
    const loaded = await readDaemonState(root, master);
    assert.equal(loaded.cycle, 7);
    assert.deepEqual((loaded as any).undeclaredByAnyVersion, { at: 'x' }, 'a field a newer loop wrote parses and is kept, not dropped');

    await writeFile(file, JSON.stringify({ ...base, undeclaredByAnyVersion: {}, cycle: 'seven' }));
    await assert.rejects(readDaemonState(root, master));

    await writeFile(file, JSON.stringify({ ...base, constructor: 1, toString: 2 }));
    assert.equal((await readDaemonState(root, master)).cycle, 7);

    await writeFile(file, JSON.stringify({ ...base, undeclaredByAnyVersion: { at: 'x' } }));
    await writeDaemonState(master, await readDaemonState(root, master));
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).undeclaredByAnyVersion, { at: 'x' }, 'the kept field is written back unchanged');
    const again = await readDaemonState(root, master);
    assert.equal(again.cycle, 7);
    assert.deepEqual((again as any).undeclaredByAnyVersion, { at: 'x' });
  } finally { await dispose(); }
});
