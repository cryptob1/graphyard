import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { decisionInput, masterConfigSchema, workerPrompt, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { parkedOnHuman } from '../src/model/human-request.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1815, on the real loop across cycles. A goals park whose asked state already holds is
 * withdrawn by an approved `withdraw-park`; from then on the loop's own cycles dispatch the item
 * once, and the resumed attempt's request carries the observation. That attempt parks on a second,
 * different question the operator answers; the attempt after it still carries the first
 * observation beside the answer, so the worker — which parks again on the first question whenever
 * its request does not say the state already holds — continues instead. While parked the item is
 * never dispatched; each answer or withdrawal dispatches it exactly once however many cycles run,
 * it never parks on the withdrawn question again, and every system invariant holds every cycle.
 */
const repository = 'owner/withdraw-park-soak';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator].map(principal => ({ ...principal, token: `withdraw-soak-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const master = { id: 'master-operator', token: `withdraw-soak-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'decision:resolve'] };
const approver = { id: 'independent-approver', token: `withdraw-soak-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
const question = 'Which of the two dashboards ships first this quarter';
const later = 'Which weekday the billing dashboard launches on';
const observed = 'Observed: the operator merged the billing dashboard first (PR #42) out of band, so the ordering asked for is already decided';
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});
async function ok(credential: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.equal(response.status, 200, `${method} ${path}: ${text}`);
  return JSON.parse(text) as any;
}
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;

before(async () => {
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('withdraw-park-soak'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('withdraw_park_soak');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/withdraw_park_soak`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver]) await ok(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: `Onboarding provisions ${agent.id}` });
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); await store?.close(); await database?.stop(); });

const profile = { name: 'alpha', principal: implementer.id, agentName: 'worker-alpha', mode: 'launch', kind: 'claude', credentialFile: join(tmpdir(), 'withdraw-park-soak-worker.token'), agentArgs: [], environment: {} };
const loopConfig = () => masterConfigSchema.parse({ version: 1, url, credentialFile: join(tmpdir(), 'withdraw-park-soak-coordinator.token'), cliPath: 'graphyard',
  repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-withdraw-soak', workers: [profile] }) as MasterConfig;

test('unit:soak-invariants-hold — across the real loop\'s cycles a withdrawn park is dispatched once, every later request carries the observation even after a later park is answered, the item never parks again on the withdrawn question, and every invariant holds every cycle', { timeout: 300_000 }, async () => {
  const sessions: HerdrAgent[] = [], dispatched: string[] = [], prompts: string[] = [], parks: string[] = [];
  /** The worker the loop launches: it parks on the ordering unless its request says the ordering already holds, then on the launch day unless its request carries the answer. */
  const launch = async (work: Work) => {
    dispatched.push(work.key);
    const claimed = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
    const prompt = workerPrompt(loopConfig(), claimed, profile as any, claimed.epoch);
    prompts.push(prompt);
    const asks = !prompt.includes(observed) ? question : !prompt.includes('the human answered: Monday') ? later : null;
    if (asks) {
      await ok(token(implementer), 'POST', `work/${claimed.key}/park`, { epoch: claimed.epoch, kind: 'goals-and-priorities', needed: asks, reason: 'The schedule of the dashboards is a priority call',
        ask: 'Choose as asked.', recommendation: 'Go ahead as asked', why: 'The billing dashboard is already half built.' });
      parks.push(`${claimed.epoch}: ${asks}`);
      return;
    }
    // It continues: its session runs under the lease, so the one slot stays busy.
    sessions.push({ name: profile.agentName, pane_id: `pane-${claimed.epoch}`, agent_status: 'working', agent: 'claude' } as HerdrAgent);
  };
  const effects = {
    agents: () => sessions,
    herdr: () => ({ agents: sessions, available: true }),
    credentials: async (profiles: { name: string }[]) => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => { const snapshot = await ok(token(coordinator), 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: snapshot.now }; },
    closeSession: () => {},
    dispatch: launch,
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'no deployment endpoint in this soak', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(loopConfig()), violations: string[] = [];
  let cycle = 0;
  const cycles = async (count: number, each: () => Promise<void> = async () => {}) => {
    for (let index = 0; index < count; index++, cycle++) {
      await runCycle(loopConfig(), state, effects);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
      await each();
    }
  };

  let work = await ok(master.token, 'POST', 'work', { title: 'Dashboard ordering', plannedFiles: ['src/dashboards.ts'], criteria: [{ id: 'AC-1', text: 'Ships the dashboard asked for first', proofs: ['unit:dashboards'] }], reason: 'Operator goal: dashboards' }) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for an attempt' }) as Work;

  // The loop dispatches it; the worker parks on the ordering, and the loop never dispatches it again while it waits.
  await cycles(1);
  assert.deepEqual(dispatched, [work.key]);
  assert.deepEqual(parks, [`1: ${question}`], 'the first attempt parks on the ordering');
  await cycles(8, async () => assert.ok(parkedOnHuman(await reload(work.id)), 'it stays parked'));
  assert.deepEqual(dispatched, [work.key], 'a parked item is never dispatched while it waits on the human');

  // The operator ships the billing dashboard out of band; the master withdraws the park on that observation, an independent approver approves.
  work = await reload(work.id);
  const requested = await ok(master.token, 'POST', `work/${work.key}/decide`, { action: 'withdraw-park', input: decisionInput('withdraw-park', work, {}), reason: observed });
  const applied = await ok(approver.token, 'POST', `work/${work.key}/approve`, { decision: requested.id, reason: 'Confirmed PR #42 merged; the ordering is settled' });
  assert.equal(applied.state, 'applied', JSON.stringify(applied));

  // The loop's own cycles redispatch it once; the resumed attempt carries the observation and parks only on the later question.
  await cycles(8, async () => assert.equal((await reload(work.id)).humanRequests?.length, 1, `cycle ${cycle}: the withdrawn request stays closed, never asked again`));
  assert.deepEqual(dispatched, [work.key, work.key], 'dispatched exactly once after the withdrawal, however many cycles run');
  assert.deepEqual(parks, [`1: ${question}`, `2: ${later}`], 'the resumed attempt parks only on the later question');
  assert.match(prompts.at(-1)!, /the request was closed as superseded by observation, because the asked state already holds: Observed: the operator merged the billing dashboard first/);

  // The operator answers the later park; every attempt after it still carries the first observation beside the answer.
  const open = (await reload(work.id)).humanRequest!;
  assert.equal(open.needed, later);
  await ok(token(operator), 'POST', `work/${work.key}/answer`, { request: open.id, answer: 'Monday' });
  await cycles(12, async () => {
    const current = await reload(work.id);
    assert.equal(current.humanRequest ?? null, null, `cycle ${cycle}: the item never parks again`);
    assert.equal(current.humanRequests?.length, 2, `cycle ${cycle}: no new human-only request`);
  });
  assert.deepEqual(dispatched, [work.key, work.key, work.key], 'dispatched exactly once after the answer, however many cycles run');
  assert.deepEqual(parks, [`1: ${question}`, `2: ${later}`], 'the attempt after the answer parks on neither question');
  assert.match(prompts.at(-1)!, /the request was closed as superseded by observation, because the asked state already holds: Observed: the operator merged the billing dashboard first/, 'the observation outlives the later answered park');
  assert.match(prompts.at(-1)!, /the human answered: Monday/);
  const final = await reload(work.id);
  assert.equal(final.lease?.owner, implementer.id, 'the resumed attempt holds the item');
  assert.equal(final.epoch, 3);
  assert.deepEqual(violations, [], 'every system invariant holds every cycle');
});
