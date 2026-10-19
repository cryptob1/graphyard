import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupMaster } from '../src/master.js';
import { setupRepository } from '../src/repository-setup.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-2179: while a held-cli pin stands, the checkout's launcher loads the snapshot's modules, so the
 * CLI's own launcher path is the snapshot's. Setup run then recorded that snapshot as cliPath, and
 * the next pin change removed it from under every unit and session. Setup now records the checkout's
 * own launcher. Each test is named for the proof it produces: unit:held-snapshot-setup-records-checkout-launcher.
 */

async function checkout(label: string) {
  const root = await realpath(await temporaryDirectory(label));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const launcher = join(root, 'bin', 'graphyard.mjs');
  const snapshot = join(root, '.graphyard', 'held-cli', 'abcdef123456', 'bin', 'graphyard.mjs');
  for (const path of [launcher, snapshot]) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, '// launcher\n'); }
  return { root, launcher, snapshot };
}

const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const coordinator = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: null }))) as typeof fetch;
const worker = (async () => new Response(JSON.stringify({ actor: { id: 'worker-a', role: 'worker' }, repository: 'owner/project' }))) as typeof fetch;

for (const from of ['snapshot', 'launcher'] as const) {
  test(`unit:held-snapshot-setup-records-checkout-launcher — master setup run from the ${from === 'snapshot' ? 'held snapshot' : "checkout's launcher"} records the checkout's launcher in master.json`, async () => {
    const world = await checkout(`held-cli-path-master-${from}`), credentials = await temporaryDirectory('held-cli-path-credentials');
    await setupMaster(world.root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: world[from], credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinator);
    assert.equal((await json(join(world.root, '.graphyard', 'master.json'))).cliPath, world.launcher);
  });

  test(`unit:held-snapshot-setup-records-checkout-launcher — repository setup run from the ${from === 'snapshot' ? 'held snapshot' : "checkout's launcher"} records the checkout's launcher in connection.json`, async () => {
    const world = await checkout(`held-cli-path-repo-${from}`);
    await setupRepository(world.root, { url: 'https://graphyard.example', cliPath: world[from], hostId: 'host-a', token: 'worker-token-'.padEnd(40, 'x') }, { fetcher: worker, executors: false });
    assert.equal((await json(join(world.root, '.graphyard', 'connection.json'))).cliPath, world.launcher);
  });
}
