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

test('unit:daemon-state-ignores-unknown-keys drops undeclared keys, still rejects malformed declared ones, and does not write them back', async () => {
  const { root, master, file, dispose } = await fixture();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
  try {
    const base = { ...emptyDaemonState(master), cycle: 7 };
    await writeFile(file, JSON.stringify({ ...base, mainWatch: { at: 'x' } }));
    const loaded = await readDaemonState(root, master);
    assert.equal(loaded.cycle, 7);
    assert.equal('mainWatch' in loaded, false);
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /mainWatch/);

    await writeFile(file, JSON.stringify({ ...base, mainWatch: {}, cycle: 'seven' }));
    await assert.rejects(readDaemonState(root, master));

    await writeFile(file, JSON.stringify({ ...base, constructor: 1, toString: 2 }));
    assert.equal((await readDaemonState(root, master)).cycle, 7);

    await writeFile(file, JSON.stringify({ ...base, mainWatch: { at: 'x' } }));
    await writeDaemonState(master, await readDaemonState(root, master));
    assert.equal('mainWatch' in JSON.parse(await readFile(file, 'utf8')), false);
    const again = await readDaemonState(root, master);
    assert.equal(again.cycle, 7);
    assert.equal('mainWatch' in again, false);
  } finally { console.error = original; await dispose(); }
});
