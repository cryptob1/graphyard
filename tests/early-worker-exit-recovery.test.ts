import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { server } from '../src/server.js';
import { supervise } from '../src/session-watch.js';
import { dispatchWork, masterConfigSchema } from '../src/master.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { emptyDaemonState, daemonStateSchema, pruneDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { actionStallDelay } from '../src/model/action-progress.js';
import { masterCauses } from '../src/daemon/master-stalled-delivery.js';
import { detectRuntimeExhaustion } from '../src/master/runtime-prompt.js';
import type { Principal, Work } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { renewWorkerLaunch } from '../src/master/dispatch.js';
import { observeSessions, reportedHandle } from '../src/model/session-state.js';
import { startedAtOnce } from './helpers/launch-shell.js';

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
test(`${proof} — supervised nonzero exits retain diagnosis, cool off, route around, wake once and recover`, { timeout: 180_000 }, async t => {
  process.env.EARLY_EXIT_TEST_TOKEN = 'plain-known-provider-value';
  t.after(() => { delete process.env.EARLY_EXIT_TEST_TOKEN; });
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
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile: coordinatorFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: host, masterAgentName: 'the-configured-master', workers: profiles });
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
  const prompts: string[] = [], closed: string[] = [], screens = new Map<string, string>(), launchedProfiles: string[] = [];
  const runs: Promise<number>[] = [];
  let mode: 'crash' | 'useful' | 'long' | 'unreadable' | 'zero' = 'crash', diagnostic = 'runtime error: controlled startup failure', now = Date.now();
  const reload = async () => (await store.list()).find(item => item.id === target.id)!;
  const snapshot = async () => {
    const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator)}`, 'X-Graphyard-View': 'coordination' } });
    assert.equal(response.status, 200);
    return { work: (await response.json() as { work: Work[] }).work, now: new Date(now).toISOString() };
  };
  const effects: DaemonEffects = {
    snapshot, credentials: async () => ({}), agents: () => [{ name: config.masterAgentName, pane_id: 'master-live-pane', agent_status: 'working' }],
    persist: async () => {}, closeSession: pane => { closed.push(pane); },
    recordSession: (item, handle) => api(coordinator, `work/${item.id}/session`, handle),
    sessionScreen: session => { if (mode === 'unreadable' && session.pane !== 'master-live-pane') throw new Error('pane vanished'); return screens.get(session.pane!) ?? null; },
    worktreeState: async space => ({ head: execFileSync('git', ['-C', space.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: null }),
    dispatch: async (item, profile, _agents, observed) => {
      launchedProfiles.push(profile.name);
      const actor = workers.find(actor => actor.id === profile.principal)!;
      let claimed: Work, workspace: string, firstRenewal: Promise<unknown> | undefined;
      const pane = `${item.key}-pane-${item.epoch + 1}`;
      // Production registers before claim; this timestamp must not measure runtime age.
      await api(coordinator, `work/${item.id}/session`, { id: `${actor.id}:${item.epoch + 1}`, kind: 'implementation', principal: actor.id, runtime: 'claude', host, subject: item.title, state: 'running' });
      const result = await dispatchWork(root, item, profile, [], (command, args) => {
        if (command === 'git') return execFileSync(command, args, { encoding: 'utf8' });
        return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' && args[1] === 'create' ? { type: 'tab_created', root_pane: { pane_id: pane, tab_id: pane }, tab: { tab_id: pane } } : {} });
      }, observed.work, async (_root, _key, _profile, _run, _claimBy, keep) => {
        claimed = await api(actor, `work/${item.id}/claim`, {});
        keep?.(claimed.epoch);
        if (item.id === target.id && claimed.epoch === 1) {
          // Real preparation exceeds the startup window while production renewals keep it live.
          await firstRenewal;
          assert.ok((await reload()).lastAssignment?.startedAt);
          await new Promise(resolve => setTimeout(resolve, 61_000));
        }
        workspace = await temporaryDirectory('early-exit-assigned');
        const branch = `graphyard/${item.key.toLowerCase()}-${claimed.epoch}`;
        git('worktree', 'add', '-qb', branch, workspace, initialHead);
        await api(actor, `work/${item.id}/workspace`, { epoch: claimed.epoch, host, path: workspace, branch });
        return { epoch: claimed.epoch, path: workspace, base: initialHead, work: claimed };
      }, async () => {}, 5000, observed.now, { renew: (...args) => { const beat = renewWorkerLaunch(...args); firstRenewal ??= beat; return beat; }, renewIntervalMs: 10_000, prompt: { attempts: 1, pauseMs: 0, acceptMs: 1000 } });
      if (item.id !== target.id) return result;
      if (mode === 'long') return result;
      const output = join(root, `runtime-${result.epoch}.txt`);
      const text = `${diagnostic}\ntoken=${secret}\nplain-known-provider-value`;
      // This is a real child supervised under the claimed epoch; its output is the controlled pane.
      const run = supervise(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(output)}, 'started'); setTimeout(() => { const text = ${JSON.stringify(text)}; console.error(text); require('fs').writeFileSync(${JSON.stringify(output)}, text); process.exit(${mode === 'zero' ? 0 : 1}); }, 100);`], result.epoch!,
        () => api(actor, `work/${item.id}/heartbeat`, { epoch: result.epoch }),
        { intervalMs: 5000, graceMs: 25, session: { visible: () => true, surrender: cause => api(actor, `work/${item.id}/release`, { epoch: result.epoch, cause }) } });
      runs.push(run.then(async code => { screens.set(pane, await readFile(output, 'utf8')); return code; }));
      return result;
    },
    masterSession: { launch: async () => { throw new Error('the configured master is already visible'); }, wake: async (pane, text) => { assert.equal(pane, 'master-live-pane'); prompts.push(text); } },
  };
  let state = emptyDaemonState(config);
  const cycle = async () => { now = Math.max(now, Date.now()); return runCycle(config, state, effects, () => now); };
  await cycle(); assert.ok(runs.length, JSON.stringify(state.actions));
  const live = await reload();
  const liveReport = observeSessions([live], [{ pane_id: live.sessions!.at(-1)!.pane!, agent: 'codex', agent_status: 'working' }], new Date());
  for (const entry of liveReport.entries) await api(coordinator, `work/${target.id}/session`, reportedHandle(entry));
  await Promise.all(runs);
  const launched = (await reload()).sessions!.at(-1)!;
  assert.equal(launched.runtime, 'codex');
  assert.ok(Date.parse(launched.runtimeStartedAt!) - Date.parse(launched.startedAt) >= 60_000);
  assert.ok(Date.parse(launched.runtimeStartedAt!) - Date.parse((await reload()).lastAssignment!.startedAt!) >= 60_000);
  // The reporter sees the exited shell before the close step's next snapshot.
  const report = observeSessions([await reload()], [{ pane_id: launched.pane!, agent: null }], new Date());
  const ended = report.entries.find(entry => entry.id === launched.id)!;
  assert.equal(ended.closed, 'ended');
  await api(coordinator, `work/${target.id}/session`, reportedHandle(ended));
  assert.equal((await reload()).sessions!.at(-1)!.state, 'finished');
  await fileItem('Unrelated');
  await cycle(); // close first failed pane; the other healthy profile advances unrelated work
  const failed = await reload(), key = `early-exit:${target.id}`, incident = state.actions[key];
  const currentIncident = () => state.actions[key];
  assert.equal(incident.state, 'failed'); assert.equal(incident.epoch, 1);
  const churn = daemonStateSchema.parse(JSON.parse(JSON.stringify(state)));
  for (let i = 0; i < 501; i++) churn.actions[`completed:${i}`] = { ...incident, kind: 'wake', work: null, state: 'done' };
  pruneDaemonState(churn);
  assert.deepEqual(churn.actions[key], incident, 'unrelated action churn never evicts an unresolved launch incident');
  assert.match(incident.detail, /epoch 1.*code 1/s); assert.match(incident.detail, /controlled startup failure/);
  assert.ok(!incident.detail.includes(secret) && !incident.detail.includes('plain-known-provider-value'));
  assert.match(incident.detail, /\[redacted\]/); assert.ok(incident.detail.length <= 500);
  assert.match(failed.sessions![0].outcome!, /controlled startup failure/); assert.ok(closed.includes(`${target.key}-pane-1`));
  assert.equal(state.actions[`close:${target.id}:${launched.id}`]?.state, 'done');
  assert.equal(state.launchBackoff[`codex:${target.id}`].failures, 1, 'the failed runtime backs off for this item');
  assert.ok(launchedProfiles.includes('claude-1'), 'healthy fallback profile still advances work');
  assert.equal(prompts.length, 1); assert.match(prompts[0], /controlled startup failure/);
  assert.equal((await store.coordinationSnapshot()).work.find(item => item.id === target.id)?.pipeline, undefined, 'test reads the actual compact snapshot');
  await Promise.all(runs); await cycle(); await Promise.all(runs); await cycle();
  state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state)));
  await cycle(); assert.equal(prompts.length, 1, 'unchanged diagnosis survives restart without another wake');
  assert.equal(closed.filter(pane => pane === launched.pane).length, 1, 'reporter-finished pane closes exactly once');

  // Retry the same exact failure on another epoch. Starting it does not erase health or incident.
  now += 11 * 60_000;
  await cycle(); assert.ok(state.actions[key]); assert.ok(state.launchBackoff[`codex:${target.id}`]); await Promise.all(runs);
  await cycle(); assert.equal(prompts.length, 1, 'unchanged failure across epochs does not spam');
  assert.ok(currentIncident().attempts >= 2, JSON.stringify(state.actions));
  diagnostic = 'runtime error: changed failure'; now += 11 * 60_000;
  await cycle(); await Promise.all(runs); await cycle();
  assert.equal(prompts.length, 2); assert.match(prompts[1], /changed failure/);
  const attempts = launchedProfiles.length;
  for (const entry of Object.values(state.launchBackoff)) entry.until = new Date(0).toISOString();
  await cycle(); assert.equal(launchedProfiles.length, attempts, 'item backoff applies even with healthy profiles');
  now += actionStallDelay(currentIncident().attempts) + 1;
  mode = 'long'; await cycle(); assert.ok(state.actions[key], 'started pane retains incident');
  now += 61_000; await cycle();
  assert.equal(state.actions[key], undefined); assert.deepEqual(state.launchBackoff, {});
  assert.equal(masterCauses([await reload()], state.actions).filter(cause => cause.detail.includes('worker exited')).length, 0);
  const running = await reload();
  const session = running.sessions!.at(-1)!;
  assert.ok(detectRuntimeExhaustion("You've hit your usage limit. Try again in 2 hours", session.runtime, now), 'selected runtime drives the exhaustion reader');
  await api(workers.find(actor => actor.id === session.principal)!, `work/${target.id}/release`, { epoch: running.epoch, cause: 'finished long-lived fixture' });

  // A useful short attempt clears an old incident, even when the child later exits nonzero.
  state.actions[key] = { ...incident, attempts: 1 };
  mode = 'useful'; await cycle();
  const usefulSpace = (await reload()).workspaces.at(-1)!.path;
  await writeFile(join(usefulSpace, 'useful-change'), 'useful');
  execFileSync('git', ['-C', usefulSpace, 'add', 'useful-change']); execFileSync('git', ['-C', usefulSpace, 'commit', '-qm', 'useful progress']);
  await Promise.all(runs); await cycle(); assert.equal(state.actions[key], undefined);

  // Missing panes do not prevent close and cannot manufacture a diagnostic.
  const wakesAfterRecovery = prompts.length;
  mode = 'unreadable'; await cycle(); await Promise.all(runs);
  const unreadableEpoch = (await reload()).epoch;
  await cycle();
  assert.ok(closed.includes(`${target.key}-pane-${unreadableEpoch}`));
  assert.ok(!currentIncident().detail.includes('pane vanished'));
  assert.ok(!currentIncident().detail.includes('changed failure'));
  assert.equal(prompts.length, wakesAfterRecovery + 1, 'a new failure after useful recovery wakes the master again');
  // An exit code 0 and a routine release are not failed launches.
  mode = 'zero'; now += 11 * 60_000; await cycle(); await Promise.all(runs); config.workers = []; await cycle();
  assert.equal(currentIncident().attempts, 1, 'a successful exit adds no failure');
});
