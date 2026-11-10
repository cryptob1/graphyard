import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { daemonEffects, type DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3227: an ended attempt's directory that Git no longer registers as a worktree is removed by the
// loop's reclaim step; a live attempt's directory and a path outside the worktree root are left alone.
const HOST = 'loop-host';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let store: Store, http: ReturnType<typeof server>, url: string, install: string;
const ok = async (principal: Principal, path: string, body: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } });
  const text = await response.text();
  assert.equal(response.status, 200, `${path}: ${text}`);
  return JSON.parse(text);
};
const git = (args: string[], cwd = install) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

before(async () => {
  store = await withDatabase('reclaim-unregistered-worktree');
  await store.init();
  http = server(new Engine(store, 1, 'owner/reclaim-unregistered'), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  install = await temporaryDirectory('reclaim-unregistered-install');
  await writeFile(join(install, 'coordinator.token'), `${'c'.repeat(40)}\n`, { mode: 0o600 });
});
after(async () => { http?.close(); await store?.close(); });

test('e2e:reclaim-unregistered-worktree — the loop removes an ended attempt\'s unregistered directory holding a 0555 tree, leaving a live attempt and an outside path alone', async () => {
  git(['init', '-q', '-b', 'main']);
  await writeFile(join(install, '.gitignore'), 'scratch/\n');
  git(['add', '.gitignore']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base']);
  const prepare = async (title: string, path: (key: string) => string) => {
    const filed = await ok(operator, 'work', { title, type: 'chore',
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:reclaim-unregistered-worktree'] }] }) as Work;
    await ok(operator, `work/${filed.id}/ready`, {});
    const branch = `graphyard/${filed.key.toLowerCase()}-1`;
    const directory = path(filed.key);
    await mkdir(dirname(directory), { recursive: true });
    git(['worktree', 'add', '-q', '-b', branch, directory]);
    const leaf = join(directory, 'scratch', 'node_modules', 'pkg', 'lib');
    await mkdir(leaf, { recursive: true });
    await writeFile(join(leaf, 'index.js'), 'module.exports = 1;\n');
    for (const nested of [leaf, dirname(leaf), dirname(dirname(leaf))]) await chmod(nested, 0o555);
    const claimed = await ok(worker, `work/${filed.id}/claim`, {}) as Work;
    await ok(worker, `work/${filed.id}/workspace`, { epoch: claimed.epoch, host: HOST, path: directory, branch });
    return { filed, directory };
  };
  const root = join(install, '.graphyard', 'worktrees');
  const ended = await prepare('Ended attempt', key => join(root, `${key}-1`));
  const outside = await prepare('Outside root', key => join(install, 'elsewhere', `${key}-1`));
  // Git forgets the ended attempt's and the outside path's worktrees, leaving their directories.
  for (const { directory } of [ended, outside]) rmSync(join(install, '.git', 'worktrees', basename(directory)), { recursive: true });
  assert.ok(!git(['worktree', 'list']).includes(ended.directory));
  await new Promise(resolve => setTimeout(resolve, 1_200)); // the one-second leases lapse: those attempts have ended
  const live = await prepare('Live attempt', key => join(root, `${key}-1`));

  const config = masterConfigSchema.parse({ version: 1, url, credentialFile: join(install, 'coordinator.token'), cliPath: '/bin/graphyard',
    repository: 'owner/reclaim-unregistered', baseBranch: 'main', hostId: HOST, masterAgentName: 'graphyard-master-reclaim', workers: [] }) as MasterConfig;
  const snapshot = async () => {
    const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator)}`, 'X-Graphyard-View': 'coordination' } });
    assert.equal(response.status, 200);
    return await response.json() as { work: Work[]; now: string };
  };
  const real = daemonEffects(install, config, { snapshot, mutate: async () => undefined });
  const effects: DaemonEffects = {
    ...real,
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    closeSession: () => {}, dispatch: async () => {}, dispatchTick: async () => {}, sweepCheckouts: async () => {},
    masterSession: undefined, mergeWriter: null, reclaimLease: undefined, endExpiredLease: undefined,
  };
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects);
  assert.equal(state.actions[`worktree:${ended.filed.id}:1`]?.state, 'done', JSON.stringify(state.actions));
  assert.ok(!existsSync(ended.directory), 'the unregistered directory with its 0555 tree is gone');
  assert.ok(existsSync(live.directory), 'a live attempt\'s directory is left alone');
  assert.ok(existsSync(outside.directory), 'a path outside the worktree root is left alone');
});
