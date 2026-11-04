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

test('unit:retired-fields-migrated — daemon cursors carrying retired keys load and preserve them across read and write, still rejecting malformed active fields', async () => {
  const { root, master, file, dispose } = await fixture();
  try {
    const base = { ...emptyDaemonState(master), cycle: 7, scope: { pending: true }, promotion: {}, orphans: [], deployment: {}, lane: 'old', metrics: [{ cycle: 6, at: '2026-11-01T00:00:00Z', open: 1, actions: 0, durationMs: 10, scope: {} }] };
    await writeFile(file, JSON.stringify({ ...base, undeclaredByAnyVersion: { at: 'x' } }));
    const loaded = await readDaemonState(root, master);
    assert.equal(loaded.cycle, 7);
    for (const field of ['scope', 'promotion', 'orphans', 'deployment', 'lane', 'undeclaredByAnyVersion']) assert.deepEqual((loaded as any)[field], ({ ...base, undeclaredByAnyVersion: { at: 'x' } } as any)[field], `${field} survives`);
    assert.deepEqual(loaded.metrics, base.metrics);

    await writeFile(file, JSON.stringify({ ...base, undeclaredByAnyVersion: {}, cycle: 'seven' }));
    await assert.rejects(readDaemonState(root, master));

    await writeFile(file, JSON.stringify({ ...base, constructor: 1, toString: 2 }));
    assert.equal((await readDaemonState(root, master)).cycle, 7);

    await writeFile(file, JSON.stringify({ ...base, undeclaredByAnyVersion: { at: 'x' } }));
    await writeDaemonState(master, await readDaemonState(root, master));
    const written = JSON.parse(await readFile(file, 'utf8'));
    for (const field of ['scope', 'promotion', 'orphans', 'deployment', 'lane', 'metrics']) assert.deepEqual(written[field], (base as any)[field], `${field} survives write`);
    assert.deepEqual(written.undeclaredByAnyVersion, { at: 'x' });
    const again = await readDaemonState(root, master);
    assert.equal(again.cycle, 7);
    assert.deepEqual((again as any).undeclaredByAnyVersion, { at: 'x' });
  } finally { await dispose(); }
});
