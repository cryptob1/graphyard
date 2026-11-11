import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { server } from '../src/server.js';
import { dispatchWork, masterConfigSchema } from '../src/master.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { emptyDaemonState, daemonStateSchema, pruneDaemonState } from '../src/daemon/state.js';
import type { HeadlessExec } from '../src/headless-session.js';
import { maskSecrets } from '../src/redaction.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterCauses } from '../src/daemon/master-stalled-delivery.js';
import type { Principal, Work } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
const operator: Principal = { id: 'operator', role: 'admin' }, coordinator: Principal = { id: 'loop', role: 'coordinator' };
const workers: Principal[] = ['worker-a', 'worker-b'].map(id => ({ id, role: 'worker' }));
const token = (actor: Principal) => `${actor.id}-${'x'.repeat(40)}`;
const host = 'exit-host', secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
let store: Store, http: ReturnType<typeof server>, url: string;
async function api(actor: Principal, path: string, data?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token(actor)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json() as any;
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`);
  return result;
}
before(async () => {
  store = await withDatabase('early-worker-exit-recovery'); await store.init();
  http = server(new Engine(store, 7200, 'owner/project'), [operator, coordinator, ...workers].map(actor => ({ ...actor, token: token(actor) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

const proof = 'integration:early-worker-exit-recovery';
test(`${proof} — a headless worker run that exits nonzero at once is a diagnosed, masked launch incident that cools off, routes around, wakes once, holds on the third and recovers`, { timeout: 180_000 }, async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const root = await temporaryDirectory('early-exit-repo'), credentials = await temporaryDirectory('early-exit-credentials');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'fixture'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  const initialHead = git('rev-parse', 'HEAD');
  const coordinatorFile = join(credentials, 'coordinator.token'); await writeFile(coordinatorFile, token(coordinator), { mode: 0o600 });
  const profiles = await Promise.all(workers.map(async (actor, index) => {
    const credentialFile = join(credentials, `${actor.id}.token`); await writeFile(credentialFile, token(actor), { mode: 0o600 });
    return { name: `claude-${index}`, principal: actor.id, agentName: `builder-${index}`, kind: 'claude', mode: 'launch', approvals: 'auto', credentialFile, environment: {} };
  }));
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile: coordinatorFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: host, masterAgentName: 'graphyard-master-project', workers: profiles });
  await mkdir(join(root, '.graphyard')); await writeFile(join(root, '.graphyard/master.json'), JSON.stringify(config), { mode: 0o600 });
  await api(operator, 'agent-registry/runtimes', { runtime: proposedRuntimes.find(runtime => runtime.name === 'codex'), reason: 'fixture runtime' });
  await api(operator, 'agent-registry/models', { model: { name: 'gpt', provider: 'openai' }, reason: 'fixture model' });
  await api(operator, 'agent-registry/accounts', { account: { name: 'codex-account', runtime: 'codex', model: 'gpt', credential: { host, home: null }, maxSessions: 5 }, reason: 'fixture account' });
  await api(operator, 'agent-registry/roles', { role: { name: 'worker', accounts: ['codex-account'], concurrency: 5 }, reason: 'fixture role' });
  const fileItem = async (title: string) => {
    const item = await api(operator, 'work', { title, type: 'chore', priority: title === 'Crash' ? 2 : 0, criteria: [{ id: 'AC-1', text: 'Works', proofs: [proof, 'e2e:early-worker-exit-recovery'] }] }) as Work;
    await api(operator, `work/${item.id}/ready`, {}); return item;
  };
  const target = await fileItem('Crash');
  const prompts: string[] = [], launchedProfiles: string[] = [], launches: Promise<unknown>[] = [];
  let crash = true, diagnostic = 'runtime error: controlled startup failure', now = Date.now();
  const reload = async () => (await store.list()).find(item => item.id === target.id)!;
  const snapshot = async () => {
    const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator)}`, 'X-Graphyard-View': 'coordination' } });
    assert.equal(response.status, 200);
    return { work: (await response.json() as { work: Work[] }).work, now: new Date(now).toISOString() };
  };
  // The runtime of the crashing item prints its diagnostic and a credential and exits 1 at once; the
  // run log holds it as the supervisor writes it, credentials masked. Every other run works on.
  const exec: HeadlessExec = async (_command, args, options) => {
    if (!crash || !args.includes(target.key)) return '';
    for (const text of [diagnostic, `token=${secret}`]) appendFileSync(join(options.run, 'log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), stream: 'stderr', text: maskSecrets(text) })}\n`);
    throw new Error('exited with code 1');
  };
  const effects: DaemonEffects = {
    snapshot, credentials: async () => ({}),
    // GY-3103: the loop reads the registry to back a failed runtime off its item.
    registry: () => api(coordinator, 'agent-registry/document'), agents: () => [{ name: config.masterAgentName, pane_id: 'master-live-pane', agent_status: 'working' }],
    persist: async () => {}, closeSession: () => {},
    recordSession: (item, handle) => api(coordinator, `work/${item.id}/session`, handle),
    dispatch: async (item, profile, _agents, observed, options) => {
      launchedProfiles.push(profile.name);
      const actor = workers.find(actor => actor.id === profile.principal)!;
      const launch = dispatchWork(root, item, profile, { ...options, allWork: observed.work, observedAt: observed.now, headless: exec, startupMs: 50,
        prepare: async () => {
          const claimed = await api(actor, `work/${item.id}/claim`, {}) as Work;
          const workspace = await temporaryDirectory('early-exit-assigned'), branch = `graphyard/${item.key.toLowerCase()}-${claimed.epoch}`;
          git('worktree', 'add', '-qb', branch, workspace, initialHead);
          await api(actor, `work/${item.id}/workspace`, { epoch: claimed.epoch, host, path: workspace, branch });
          return { epoch: claimed.epoch, path: workspace, base: initialHead, work: claimed };
        },
        // The supervisor of a run that exited released its lease; here the launcher's release stands for it.
        release: async (_root, _key, epoch) => { await api(actor, `work/${item.id}/release`, { epoch, cause: 'the worker exited at once' }); } });
      launches.push(launch.catch(() => {}));
      return launch;
    },
    masterSession: { launch: async () => { throw new Error('the configured master is already visible'); }, wake: async (pane, text) => { assert.equal(pane, 'master-live-pane'); prompts.push(text); } },
  };
  let state = emptyDaemonState(config);
  const cycle = async () => { now = Math.max(now, Date.now()); await runCycle(config, state, effects, () => now); await Promise.all(launches); };
  await fileItem('Unrelated');
  await cycle();
  const key = `early-exit:${target.id}`, incident = state.actions[key];
  assert.equal(incident?.state, 'failed', JSON.stringify(state.actions)); assert.equal(incident.epoch, 1);
  assert.match(incident.detail, /epoch 1: the codex worker exited at once/); assert.match(incident.detail, /controlled startup failure/);
  assert.ok(!incident.detail.includes(secret), 'the credential is masked before it is stored'); assert.match(incident.detail, /\[redacted\]/); assert.ok(incident.detail.length <= 500);
  const churn = daemonStateSchema.parse(JSON.parse(JSON.stringify(state)));
  for (let i = 0; i < 501; i++) churn.actions[`completed:${i}`] = { ...incident, kind: 'wake', work: null, state: 'done' };
  pruneDaemonState(churn);
  assert.deepEqual(churn.actions[key], incident, 'unrelated action churn never evicts an unresolved launch incident');
  assert.equal((await reload()).lease, null, 'the crashed attempt holds nothing');
  assert.equal(state.launchBackoff[`codex:${target.id}`]?.failures, 1, 'the failed runtime backs off for this item');
  assert.equal(launchedProfiles.length, 2, 'the other profile still launches the unrelated item');
  await cycle();
  assert.equal(prompts.length, 1); assert.match(prompts[0], /controlled startup failure/);
  // GY-3103: the failed runtime holds the item for its first minute of back-off.
  await cycle(); assert.equal((await reload()).epoch, 1, 'no profile relaunches the item inside its back-off');
  now += 61_000; await cycle(); await cycle();
  state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state)));
  // GY-3104: the second equal exit replaces the per-failure cause with the run's one wake, carrying both reasons.
  assert.equal(prompts.length, 2); assert.match(prompts[1], /the same launch failure twice[\s\S]*epoch 1[\s\S]*epoch 2/);
  await cycle(); assert.equal(prompts.length, 2, 'an unchanged diagnosis survives a restart without another wake');
  // The third equal exit holds the item and wakes the master once to decide.
  now += 11 * 60_000; await cycle(); await cycle();
  assert.equal(prompts.length, 3); assert.match(prompts[2], /a third time; the loop stopped dispatching it/);
  const held = launchedProfiles.length;
  now += 11 * 60_000; await cycle(); assert.equal(launchedProfiles.length, held, 'a held item is not relaunched');
  // The master's rework ends the run; a run that works clears the incident and the back-off once it is past its first minute.
  await api(operator, `work/${target.id}/rework`, { reason: 'Try a different start', previousWorkerStopped: true });
  crash = false; diagnostic = 'unused';
  for (const entry of Object.values(state.launchBackoff)) entry.until = new Date(0).toISOString();
  now += 11 * 60_000; await cycle();
  const running = await reload();
  assert.equal(running.lease?.owner !== undefined, true, 'the item runs again'); assert.ok(state.actions[key], 'a run inside its first minute keeps the incident');
  now += 61_000; await cycle();
  assert.equal(state.actions[key], undefined); assert.deepEqual(state.launchBackoff, {});
  assert.equal(masterCauses([await reload()], state.actions).filter(cause => cause.detail.includes('worker exited')).length, 0);
});
