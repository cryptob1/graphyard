import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { cliReleasePath, currentCliPath, repairCliStamp } from '../src/install/cli-release.js';
import { recordedCommit, releaseIdentityPath } from '../src/release.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';

// GY-3553: the loop clears an environment blocker itself once its cause is gone. A worker blocked
// on a host heavy-job slot, heat, a host verification timeout, a CLI/server commit mismatch or an
// unwritable worktree waited hours for a person to run `master unblock` after the cause had cleared.
// Driven through the loop's own cycle against a temporary control plane.

const proof = 'integration:loop-clears-environment-blockers';
const repository = 'owner/environment-blockers';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, workerA].map(principal => ({ ...principal, token: `env-${principal.id}-${'x'.repeat(32)}` }));
const token = (id: string) => credentials.find(credential => credential.id === id)!.token;

let store: Store, http: ReturnType<typeof server>, url: string;
const ok = async (bearer: string, path: string, body: unknown = {}) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
  const result = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
};
const snapshot = async () => {
  const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator.id)}`, 'X-Graphyard-View': 'coordination' } });
  return response.json() as Promise<{ work: Work[]; now: string }>;
};
const reload = async (id: string) => (await snapshot()).work.find(item => item.id === id)!;
const unblockLines = async (id: string) => (await store.pool.query("SELECT payload FROM events WHERE work_id=$1 AND kind='unblock' ORDER BY seq", [id])).rows.map(row => String(row.payload?.reason ?? JSON.stringify(row.payload)));

/** A ready item a worker claimed and then blocked with `reason`. */
async function blocked(title: string, reason: string) {
  const item = await ok(token(operator.id), 'work', { title, why: 'w', simplest: 's', type: 'chore', priority: 1,
    criteria: [{ id: 'AC-1', text: 'Works', proofs: [proof, 'e2e:loop-clears-environment-blockers'] }], policy: { checks: ['test'], review: true } }) as Work;
  await ok(token(operator.id), `work/${item.id}/ready`);
  const claimed = await ok(token(workerA.id), `work/${item.id}/claim`) as Work;
  await ok(token(workerA.id), `work/${item.id}/blocked`, { epoch: claimed.epoch, reason });
  return item;
}

before(async () => {
  store = await withDatabase('loop-clears-environment-blockers');
  await store.init();
  http = server(new Engine(store, 7200, repository), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

const profile = { name: 'w1', principal: workerA.id, agentName: 'agent-w1', mode: 'launch', kind: 'claude', credentialFile: '/outside/w1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
const makeConfig = async (): Promise<MasterConfig> => masterConfigSchema.parse({ version: 1, url, credentialFile: join(await temporaryDirectory('env-blockers-credentials'), 'coordinator.token'), cliPath: '/bin/graphyard',
  repository, baseBranch: 'main', githubAppId: 1234, hostId: 'env-host', masterAgentName: 'graphyard-master-env', workers: [profile] });

/** The loop's effects over this control plane, with the host readings a test controls and every launch counted. */
function world(host: { slotsFree: boolean; celsius: number | null; cliCommit: string; serverCommit: string; writable: Set<string> }) {
  const dispatched: string[] = [];
  const effects: DaemonEffects = {
    snapshot, agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({ w1: { available: true, reason: null } }), closeSession: () => {},
    dispatch: async item => { dispatched.push(item.key); return { pane: `pane-${item.key}`, epoch: 2 }; },
    cpuPressure: async () => ({ pressure: null, stat: null, celsius: host.celsius }),
    environmentReadings: async () => ({ slotsFree: host.slotsFree, cliCommit: host.cliCommit, serverCommit: host.serverCommit, writable: path => host.writable.has(path) }),
    unblock: (work, reason) => ok(token(operator.id), `work/${work.id}/unblock`, { expectedRevision: work.revision, reason }),
    persist: async () => {},
  };
  return { effects, dispatched };
}

test(`${proof} — each environment cause is cleared by the loop within two cycles of clearing, with one history line naming it; a person's or the change's blocker stays`, async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const config = await makeConfig(), state = emptyDaemonState(config);
  const host = { slotsFree: false, celsius: 99 as number | null, cliCommit: 'a'.repeat(40), serverCommit: 'b'.repeat(40), writable: new Set<string>() };
  const { effects } = world(host);
  const items = {
    slot: await blocked('Slot', 'complete failed: graphyard: worker verification waits for a host heavy-job slot and timed out after 30 minutes'),
    heat: await blocked('Heat', 'complete could not start: the CPU is too hot (96C at a 85C limit); launches waiting'),
    timeout: await blocked('Timeout', 'the host verification timed out after 1800s on the trial host'),
    commit: await blocked('Commit', `CLI commit ${'a'.repeat(40)} and server commit ${'b'.repeat(40)} differ: run graphyard upgrade`),
    writable: await blocked('Writable', 'git commit failed: EROFS: read-only file system, open \'/srv/worktrees/GY-9-1/.git/index.lock\''),
    person: await blocked('Person', 'the staging credential expired; the owner must issue a new token'),
    code: await blocked('Code', 'tests failed: AssertionError: expected 2 to equal 3 in tests/export.test.ts; the host verification timed out on retry'),
  };
  const cycle = () => runCycle(config, state, effects, Date.now, undefined, () => {});
  await cycle();
  for (const item of Object.values(items)) assert.ok((await reload(item.id)).blocker, `${item.key} stays blocked while its cause stands`);
  // Every cause clears; the code and person blockers name causes the loop could also test, and still stay.
  host.slotsFree = true; host.celsius = 40; host.serverCommit = host.cliCommit; host.writable.add('/srv/worktrees/GY-9-1/.git/index.lock');
  await cycle();
  await cycle();
  const expected = { slot: 'heavy-job slot wait', heat: 'heat wait', timeout: 'host verification timeout', commit: 'CLI/server commit mismatch', writable: 'unwritable worktree' } as const;
  for (const [name, cause] of Object.entries(expected)) {
    const item = items[name as keyof typeof expected];
    assert.equal((await reload(item.id)).blocker, null, `${item.key} (${cause}) is unblocked by the loop`);
    const lines = await unblockLines(item.id);
    assert.equal(lines.length, 1, `one history line for ${item.key}: ${JSON.stringify(lines)}`);
    assert.ok(lines[0]!.includes(cause), `the line names the cleared cause: ${lines[0]}`);
  }
  for (const item of [items.person, items.code]) {
    assert.ok((await reload(item.id)).blocker, `${item.key}'s blocker needs a person or names the change, so it stays`);
    assert.deepEqual(await unblockLines(item.id), []);
  }
});

test(`${proof} — a served CLI release whose commit stamp names another commit is restamped to the commit checked out in it, and the loop logs it once`, async () => {
  const directory = await temporaryDirectory('env-blockers-install');
  const source = await temporaryDirectory('env-blockers-source');
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'release']);
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const release = cliReleasePath(directory, commit);
  await mkdir(join(release, '..'), { recursive: true });
  execFileSync('git', ['-C', source, 'worktree', 'add', '-q', '--detach', release, commit]);
  await symlink(release, currentCliPath(directory));
  await mkdir(join(release, '.graphyard'), { recursive: true });
  await writeFile(releaseIdentityPath(release), 'c'.repeat(40));
  assert.equal(recordedCommit(release), 'c'.repeat(40), 'the stale stamp names another commit');

  const config = await makeConfig(), state = emptyDaemonState(config);
  const lines: string[] = [];
  const effects: DaemonEffects = { snapshot: async () => ({ work: [], now: new Date().toISOString() }), agents: () => [], credentials: async () => ({}), closeSession: () => {},
    dispatch: async () => { assert.fail('nothing to launch'); }, persist: async () => {}, repairCliStamp: () => repairCliStamp(directory) };
  const actions = [...(await runCycle(config, state, effects, Date.now, undefined, line => lines.push(line))).actions, ...(await runCycle(config, state, effects, Date.now, undefined, line => lines.push(line))).actions];
  assert.equal((await readFile(releaseIdentityPath(release), 'utf8')).trim(), commit, 'the stamp names the commit checked out in the release');
  const restamped = actions.filter(action => /CLI release commit stamp/.test(action.detail));
  assert.equal(restamped.length, 1, `logged once: ${JSON.stringify(actions.map(action => action.detail))}`);
  assert.ok(restamped[0]!.detail.includes(commit.slice(0, 12)));
});

test(`e2e:loop-clears-environment-blockers — an item blocked on a slot timeout resumes without any unblock command once slots free`, async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const config = await makeConfig(), state = emptyDaemonState(config);
  const host = { slotsFree: false, celsius: null, cliCommit: 'a'.repeat(40), serverCommit: 'a'.repeat(40), writable: new Set<string>() };
  const { effects, dispatched } = world(host);
  const item = await blocked('Slot timeout', 'complete failed: worker verification waited for a host heavy-job slot and timed out');
  const cycle = () => runCycle(config, state, effects, Date.now, undefined, () => {});
  await cycle();
  assert.deepEqual(dispatched, [], 'no launch while every slot is held');
  host.slotsFree = true;
  await cycle();
  await cycle();
  assert.equal((await reload(item.id)).blocker, null, 'the loop cleared the blocker');
  assert.deepEqual(dispatched, [item.key], 'and launched the item again');
});
