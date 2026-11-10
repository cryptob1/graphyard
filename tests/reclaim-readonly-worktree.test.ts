import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

// GY-3226: an ended attempt's worktree holding a read-only (0555) directory tree is removed by the
// loop's reclaim step; a removal that fails is tried again on the next cycle; a symlink out of the
// tree is neither followed nor chmodded.

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
  store = await withDatabase('reclaim-readonly-worktree');
  await store.init();
  http = server(new Engine(store, 1, 'owner/reclaim-readonly'), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  install = await temporaryDirectory('reclaim-readonly-install');
  await writeFile(join(install, 'coordinator.token'), `${'c'.repeat(40)}\n`, { mode: 0o600 });
});
after(async () => { http?.close(); await store?.close(); });

test('e2e:reclaim-readonly-worktree — the loop removes an ended attempt\'s worktree holding a 0555 tree, retries a failed removal, and leaves an outside symlink target alone', async () => {
  const filed = await ok(operator, 'work', { title: 'Reclaim a read-only worktree', type: 'chore',
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:reclaim-readonly-worktree'] }] }) as Work;
  await ok(operator, `work/${filed.id}/ready`, {});

  git(['init', '-q', '-b', 'main']);
  await writeFile(join(install, '.gitignore'), 'scratch/\n');
  git(['add', '.gitignore']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base']);
  const branch = `graphyard/${filed.key.toLowerCase()}-1`;
  const worktree = join(install, '.graphyard', 'worktrees', `${filed.key}-1`);
  await mkdir(dirname(worktree), { recursive: true });
  git(['worktree', 'add', '-q', '-b', branch, worktree]);
  // An npm install the attempt left under its ignored scratch: nested directories at 0555, with files.
  const leaf = join(worktree, 'scratch', 'node_modules', 'pkg', 'lib');
  await mkdir(leaf, { recursive: true });
  await writeFile(join(leaf, 'index.js'), 'module.exports = 1;\n');
  await writeFile(join(dirname(leaf), 'package.json'), '{}\n');
  // A read-only directory outside the tree, linked from inside it.
  const outside = await temporaryDirectory('reclaim-readonly-outside');
  await writeFile(join(outside, 'keep.txt'), 'keep\n');
  await chmod(outside, 0o555);
  await symlink(outside, join(worktree, 'scratch', 'node_modules', 'outside'));
  for (const directory of [leaf, dirname(leaf), dirname(dirname(leaf))]) await chmod(directory, 0o555);

  const claimed = await ok(worker, `work/${filed.id}/claim`, {}) as Work;
  await ok(worker, `work/${filed.id}/workspace`, { epoch: claimed.epoch, host: HOST, path: worktree, branch });
  await new Promise(resolve => setTimeout(resolve, 1_200)); // the one-second lease lapses: the attempt has ended

  const config = masterConfigSchema.parse({ version: 1, url, credentialFile: join(install, 'coordinator.token'), cliPath: '/bin/graphyard',
    repository: 'owner/reclaim-readonly', baseBranch: 'main', hostId: HOST, masterAgentName: 'graphyard-master-reclaim', workers: [] }) as MasterConfig;
  const snapshot = async () => {
    const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator)}`, 'X-Graphyard-View': 'coordination' } });
    assert.equal(response.status, 200);
    return await response.json() as { work: Work[]; now: string };
  };
  const real = daemonEffects(install, config, { snapshot, mutate: async () => undefined });
  let removals = 0;
  const effects: DaemonEffects = {
    ...real,
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    closeSession: () => {}, dispatch: async () => {}, dispatchTick: async () => {}, sweepCheckouts: async () => {},
    masterSession: undefined, mergeWriter: null, reclaimLease: undefined, endExpiredLease: undefined,
    removeWorktree: async (path, force) => { if (++removals === 1) throw new Error('injected removal failure'); return real.removeWorktree!(path, force); },
  };
  const state = emptyDaemonState(config);
  const key = `worktree:${filed.id}:1`;

  await runCycle(config, state, effects);
  assert.equal(state.actions[key]?.state, 'failed', JSON.stringify(state.actions[key]));
  assert.ok(existsSync(worktree), 'the injected failure keeps the tree');

  await runCycle(config, state, effects);
  assert.equal(state.actions[key]?.state, 'done', JSON.stringify(state.actions[key]));
  assert.equal(removals, 2, 'the failed removal was tried again on the next cycle');
  assert.ok(!existsSync(worktree), 'the worktree with its 0555 tree is gone');
  assert.equal(statSync(outside).mode & 0o777, 0o555, 'the symlink target outside the tree is not chmodded');
  assert.ok(existsSync(join(outside, 'keep.txt')), 'the symlink target outside the tree is not followed into');
  await chmod(outside, 0o755);
});
