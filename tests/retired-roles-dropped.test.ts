import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AgentRegistry, readRegistry } from '../src/agent-registry.js';
import { emptyRegistry, unobservedQuota, registryRoles, proposedConcurrency, proposedRuntimeRoles, chooseSession, type AgentRegistry as Registry } from '../src/model/registry.js';
import { accountSchema, modelSchema, runtimeSchema, roleSchema, selectionRequestSchema } from '../src/model-boundary/registry.js';
import { registryCommand } from '../src/cli/master-registry.js';
import { masterConfigSchema, forwardTolerant } from '../src/master/profiles.js';
import { loadStoredMasterConfig, saveMasterSettings } from '../src/master/config.js';
import { Engine } from '../src/engine.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';

const retired = ['approver', 'escalation-handler', 'diagnostician', 'doctor', 'acceptance', 'planner'];
const base = { version: 1, url: 'https://graphyard.example', credentialFile: '/outside/token', cliPath: resolve('bin/graphyard.mjs'), repository: 'owner/project', baseBranch: 'main', hostId: 'fixture', masterAgentName: 'master' };
const admin = { id: 'fixture-admin', role: 'admin' as const };

test('e2e:retired-roles-dropped — legacy registry migrates once on a successful CLI mutation, with audit and live reservations retained', async t => {
  const store = await withDatabase('retired-roles'); await store.init(); t.after(() => store.close());
  const api = new AgentRegistry(store), now = new Date().toISOString();
  const legacy = { ...emptyRegistry(), runtimes: [runtimeSchema.parse({ name: 'claude', launch: { kind: 'claude' } })], models: [modelSchema.parse({ name: 'default' })],
    accounts: [{ ...accountSchema.parse({ name: 'legacy', runtime: 'claude', model: 'default', credential: { host: 'fixture' }, maxSessions: 1 }), quota: { ...unobservedQuota, loggedIn: true } }], roles: ['worker', 'reviewer', 'producer', 'master', ...retired].map(name => ({ name, accounts: ['legacy'], concurrency: 1 })),
    sessions: [{ id: 'old-live', role: 'approver', account: 'legacy', runtime: 'claude', model: 'default', host: 'fixture', work: null, principal: null,
      selectedAt: now, selectedBy: 'old-master', reason: 'historical', skipped: [], endedAt: null, endReason: null }] } as unknown as Registry;
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,'agent-registry.apply',$2)", [admin.id, JSON.stringify({ registry: legacy, change: {} })]);
  assert.equal((await api.document(admin)).roles.length, 10, 'legacy document loads');
  assert.deepEqual(registryRoles, ['worker', 'reviewer', 'producer', 'master']);
  assert.deepEqual(Object.keys(proposedConcurrency), [...registryRoles]);
  assert.ok(Object.values(proposedRuntimeRoles).flat().every(role => registryRoles.includes(role!)));
  const pi = await import('../integrations/pi/index.js');
  for (const role of [...retired, 'research', 'decomposition', 'triage']) assert.deepEqual(pi.graphyardTools(role), []);
  assert.deepEqual(pi.graphyardTools('producer').map(tool => tool.name), ['graphyard_submit_evidence']);
  const payloads = await import('../src/runner/payloads.js'), settings = await import('../src/master/merge-writer-settings.js');
  assert.equal('diagnosticianSettings' in payloads, false); assert.equal('candidateSettingsSchema' in settings, false);
  assert.deepEqual((await api.view(admin)).roles.map(role => role.role), [...registryRoles]);
  for (const name of retired) {
    assert.equal(roleSchema.safeParse({ name, accounts: [], concurrency: 1 }).success, false);
    assert.equal(selectionRequestSchema.safeParse({ role: name, host: 'fixture' }).success, false);
    assert.equal(chooseSession(legacy, { role: name as 'worker', host: 'fixture' }, Date.now()).account, null);
    await assert.rejects(api.select(admin, { role: name, host: 'fixture' }, randomUUID()));
  }
  await assert.rejects(api.mutate(admin, 'model.remove', { name: 'absent', reason: 'invalid' }, randomUUID()));
  assert.deepEqual(await readRegistry(store.pool), legacy, 'failed mutation does not migrate');
  const command = () => registryCommand({ hostId: 'fixture' }, ['role', 'set', 'worker', '--concurrency', '2', '--reason', 'ordinary change'], {
    read: () => api.document(admin), write: (_path, data) => api.mutate(admin, 'role.set', data, randomUUID()),
  });
  const first = await command();
  assert.deepEqual(first.attention, [`Removed retired roles: ${retired.join(', ')}`]);
  assert.deepEqual((await readRegistry(store.pool)).sessions, legacy.sessions, 'migration does not free live retired slots');
  assert.deepEqual((await readRegistry(store.pool)).roles.map(role => role.name), [...registryRoles]);
  assert.match(chooseSession(await readRegistry(store.pool), { role: 'worker', host: 'fixture' }, Date.now()).reason, /legacy is at its session limit/);
  assert.deepEqual((await command()).attention, []);
  assert.ok(!(await api.view(admin)).attention.some(line => line.includes('Removed retired roles')));
  const history = await api.history(admin);
  assert.deepEqual(history.filter(event => event.kind === 'roles-retired').map(event => event.change.removedRoles), [retired]);
  assert.equal((await store.pool.query("SELECT payload->'registry' AS registry FROM events WHERE kind='agent-registry.apply'")).rows[0].registry.roles.length, 10);
});

test('e2e:retired-roles-dropped — every retired setting accepts arbitrary legacy values, drops on ordinary save, and future settings survive', async () => {
  const root = await temporaryDirectory('retired-config'), credentials = await temporaryDirectory('retired-config-credentials');
  execFileSync('git', ['init', '-q', root]);
  const credentialFile = join(credentials, 'token'); await writeFile(credentialFile, 'fixture-token', { mode: 0o600 });
  await mkdir(join(root, '.graphyard'));
  const file = join(root, '.graphyard/master.json');
  const top = ['autoMerge', 'reviewRoundCap', 'reviewer', 'approver', 'invariants', 'browser', 'mergeQueue'];
  const run = ['research', 'decomposition', 'doctor', 'diagnostician', 'candidates', 'awaitReviewers', 'awaitReviewersMinutes'];
  for (const arbitrary of [false, 42, 'old', null, ['arbitrary'], { future: true }]) {
    const legacy = { ...base, credentialFile, ...Object.fromEntries(top.map(key => [key, arbitrary])), future: { keep: true }, confinement: { maskPaths: ['/private'] },
      run: { ...Object.fromEntries(run.map(key => [key, arbitrary])), future: ['keep'], mergeWriter: { retrials: arbitrary, parallel: 2, future: true },
        runtimes: { approver: arbitrary, producer: 'pi', future: 'keep' }, pi: { approverTimeoutMinutes: arbitrary, command: 'pi-local', future: true } } };
    await writeFile(file, JSON.stringify(legacy), { mode: 0o600 });
    assert.deepEqual(forwardTolerant(masterConfigSchema).parse(legacy), masterConfigSchema.parse(legacy));
    await loadStoredMasterConfig(root);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), legacy, 'reads never rewrite');
    await saveMasterSettings(root, { intervalSeconds: 30 });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    for (const key of top) assert.equal(key in saved, false, key);
    for (const key of run) assert.equal(key in saved.run, false, key);
    for (const [section, key] of [['mergeWriter', 'retrials'], ['runtimes', 'approver'], ['pi', 'approverTimeoutMinutes']]) assert.equal(key in saved.run[section], false);
    assert.deepEqual([saved.future, saved.run.future, saved.run.mergeWriter.future, saved.run.runtimes.future, saved.run.pi.future], [{ keep: true }, ['keep'], true, 'keep', true]);
    assert.deepEqual(saved.confinement, legacy.confinement);
    assert.equal(saved.run.runtimes.producer, 'pi'); assert.equal(saved.run.pi.command, 'pi-local');
    await saveMasterSettings(root, { intervalSeconds: 30 });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved);
  }
});

test('e2e:retired-roles-dropped — an ordinary worker blocker reaches the registered master once with its typed next action', async t => {
  setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
  const store = await withDatabase('retired-escalation'); await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 120, 'owner/project'), worker = { id: 'ordinary-worker', role: 'worker' as const };
  let item = await engine.execute(admin, 'create', null, { title: 'Fixture implementation', type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:retired-roles-dropped'] }] }, randomUUID());
  item = await engine.execute(admin, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  const reason = 'Fixture dependency is unavailable';
  item = await engine.execute(worker, 'blocked', item.id, { epoch: item.epoch, reason }, randomUUID());
  const config = masterConfigSchema.parse(base), state = emptyDaemonState(config), prompts: string[] = [];
  state.master.session = 'registered-master';
  const effects = { snapshot: async () => ({ work: [item], now: new Date().toISOString() }), agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'working' }],
    credentials: async () => ({}), closeSession: () => {}, persist: async () => {}, dispatch: async () => { assert.fail('blocked work must not launch'); },
    masterSession: { wake: async (pane: string, prompt: string) => { assert.equal(pane, 'pM'); prompts.push(prompt); }, launch: async () => { throw new Error('must wake registered master'); } } };
  await runCycle(config, state, effects);
  assert.equal(prompts.length, 1);
  for (const text of [item.key, reason, `master unblock ${item.key} REASON`]) assert.ok(prompts[0].includes(text), text);
  await runCycle(config, state, effects);
  assert.equal(prompts.length, 1, 'unchanged next cycle does not wake again');
  assert.deepEqual((await readRegistry(store.pool)).sessions, [], 'no retired selection or launch');
});
