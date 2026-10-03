import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { preferOtherRuntime, reblockedMarker, runtimeToAvoid } from '../src/daemon/reblocked-attempts.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';

/**
 * GY-867. On 2026-09-27 six of ten worker slots were held for hours by attempts that blocked, were
 * unblocked, and blocked again on the same cause — a sandbox's file ownership, a pane in another
 * item's worktree, a remote branch the session believed only a force push could fix. Unblocking
 * only re-prompts the same session, so nothing ended them. An attempt that blocks again on an epoch
 * whose blocker was already cleared is now ended: its work kept on its branch, its own blocker
 * ended with it, and the item dispatched to a fresh session, preferably on another runtime.
 */
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();

async function setup() {
  const directory = await temporaryDirectory('reblocked');
  const credentialFile = join(directory, 'coordinator.token'), worker = join(directory, 'worker.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await writeFile(worker, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const profile = { name: 'alpha', principal: 'alpha-principal', agentName: 'agent-alpha', mode: 'launch', kind: 'claude', credentialFile: worker, agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', herdrWorkspace: 'w1',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile] });
  return { directory, master };
}
function held(overrides: Partial<Work> = {}): Work {
  const epoch = overrides.epoch ?? 1;
  return {
    id: 'work-710', key: 'GY-710', title: 'Fresh observations', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/a.ts'], stage: 'build', revision: 3, policyRevision: 1,
    createdAt: iso(-3_600_000), updatedAt: iso(0), stageEnteredAt: iso(-3_600_000), ready: true, epoch,
    lease: { owner: 'alpha-principal', epoch, expiresAt: iso(3_600_000) },
    lastAssignment: { owner: 'alpha-principal', epoch, claimedAt: iso(-3_600_000) },
    workspaces: [{ host: 'machine-a', path: `/srv/worktrees/GY-710-${epoch}`, epoch, owner: 'alpha-principal', branch: `graphyard/gy-710-${epoch}` }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], violations: [],
    ...overrides,
  } as Work;
}
function harness(item: { current: Work[] }, agent: HerdrAgent) {
  const log = { prompts: [] as string[], closed: [] as string[], capacity: [] as Record<string, unknown>[] };
  const effects: DaemonEffects = {
    agents: () => [agent],
    credentials: async profiles => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: item.current, now: iso(0) }),
    closeSession: pane => { log.closed.push(pane); },
    dispatch: async () => {},
    requestProof: () => {},
    merge: async () => ({ result: 'merge requested' }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    promptSession: (_agent, text) => { log.prompts.push(text); },
    recordSession: async () => {},
    // The control plane ends the attempt and, for an attempt's own blocker, the blocker with it.
    reportCapacity: async (work, event) => {
      log.capacity.push(event);
      item.current = item.current.map(entry => entry.id === work.id ? { ...entry, lease: null, containmentQuarantine: null, ...(event.endsBlocker ? { blocker: null } : {}) } as Work : entry);
      return item.current[0];
    },
    preserveWork: async () => ({ state: 'committed', commit: 'a'.repeat(40), branch: 'graphyard/gy-710-1', detail: 'kept as WIP' }),
  };
  return { log, effects };
}

test('unit:reblocked-attempt-ended — an attempt that blocks again on an epoch whose blocker was cleared is ended within one cycle, keeping its work and ending its own blocker', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: [held({ blocker: 'runner-attestor tests fail: /tmp is owned by uid 65534' })] };
    const agent: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:p7J1', agent_status: 'idle', agent: 'claude' };
    const { log, effects } = harness(item, agent);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    // The master clears it; the session is re-prompted once, as before.
    item.current = [held()];
    await runCycle(master, state, effects, () => clock + 30_000);
    assert.equal(log.prompts.length, 1);
    assert.equal(log.capacity.length, 0, 'a clearance alone ends nothing');

    // It blocks again on the same epoch: the next cycle ends the attempt.
    item.current = [held({ blocker: 'still failing: /tmp is owned by uid 65534; needs a new sandbox' })];
    await runCycle(master, state, effects, () => clock + 60_000);
    assert.equal(log.capacity.length, 1, 'the attempt is ended on the record');
    const report = log.capacity[0];
    assert.equal(report.cause, 'interrupted');
    assert.equal(report.role, 'worker');
    assert.equal(report.epoch, 1);
    assert.equal(report.endsBlocker, true, 'the blocker this attempt recorded ends with it');
    assert.ok(String(report.reason).startsWith(reblockedMarker));
    assert.match(String(report.reason), /cleared \("runner-attestor tests fail: \/tmp is owned by uid 65534"\); it now reports "still failing/, 'both blockers are named');
    assert.deepEqual(log.closed, ['w1:p7J1'], 'its pane is closed');
    assert.equal(log.prompts.length, 1, 'the session is not re-prompted again');
    const ended = Object.entries(state.actions).find(([key]) => key === 'resume:reblocked:work-710:1')?.[1];
    assert.equal(ended?.state, 'done');
    assert.match(ended!.detail, /keeping the attempt's branch and ending the blocker it recorded/);
    assert.equal(item.current[0].lease, null);
    assert.equal(item.current[0].blocker, null, 'the item can be dispatched again');

    // Ended once: later cycles do nothing more for that epoch.
    await runCycle(master, state, effects, () => clock + 90_000);
    assert.equal(log.capacity.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:first-block-still-waits — a first block, or a block on a new epoch after an earlier epoch was cleared, waits and is re-prompted once when cleared', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: [held({ blocker: 'needs a decision' })] };
    const agent: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:p7J1', agent_status: 'idle', agent: 'claude' };
    const { log, effects } = harness(item, agent);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    await runCycle(master, state, effects, () => clock + 30_000);
    assert.equal(log.capacity.length, 0, 'a first block waits');
    assert.equal(state.actions['resume:blocker:work-710:1']?.state, 'waiting');
    item.current = [held()];
    await runCycle(master, state, effects, () => clock + 60_000);
    assert.equal(log.prompts.length, 1, 'cleared, it is re-prompted once');

    // A new attempt (epoch 2) that blocks has no clearance of its own yet: it waits.
    item.current = [held({ epoch: 2, blocker: 'a different cause on a fresh attempt' })];
    await runCycle(master, state, effects, () => clock + 90_000);
    await runCycle(master, state, effects, () => clock + 120_000);
    assert.equal(log.capacity.length, 0, 'an earlier epoch\'s clearance does not end a new attempt');
    assert.equal(state.actions['resume:blocker:work-710:2']?.state, 'waiting');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:reblocked-attempt-redispatched-elsewhere — after a reblocked end, a profile on another runtime is chosen first; otherwise the order is unchanged', () => {
  const entry = (name: string, kind: string) => ({ profile: { name, kind, mode: 'launch' }, healthy: true });
  const health = [entry('claude-primary', 'claude'), entry('claude-secondary', 'claude'), entry('opencode-primary', 'opencode')];
  const reblocked = { capacity: { exhaustions: [{ role: 'worker', cause: 'interrupted', epoch: 7, runtime: 'claude', reason: `${reblockedMarker}7 after its blocker was cleared ("x"); it now reports "y"` }], escalations: [] } } as unknown as Work;
  assert.equal(runtimeToAvoid(reblocked), 'claude');
  assert.deepEqual(preferOtherRuntime(health, runtimeToAvoid(reblocked)).map(candidate => candidate.profile.name), ['opencode-primary', 'claude-primary', 'claude-secondary'], 'another runtime first, the same runtime still possible after it');
  // An idle hand-over or a quota end is not a session-local cause: no runtime is avoided.
  const idle = { capacity: { exhaustions: [{ role: 'worker', cause: 'interrupted', epoch: 7, runtime: 'claude', reason: 'idle with a live lease: no activity' }], escalations: [] } } as unknown as Work;
  assert.equal(runtimeToAvoid(idle), null);
  assert.equal(runtimeToAvoid({ capacity: undefined } as unknown as Work), null);
  assert.deepEqual(preferOtherRuntime(health, null).map(candidate => candidate.profile.name), ['claude-primary', 'claude-secondary', 'opencode-primary']);
});

// The control plane's side: the blocker ends with the attempt only when that attempt wrote it.
const repository = 'owner/reblocked';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator].map(principal => ({ ...principal, token: `reblocked-${principal.id}-${'x'.repeat(32)}` }));
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements'] };
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
const call = async (credential: string, path: string, body: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const interrupted = (epoch: number, endsBlocker: boolean) => ({ event: 'exhausted', cause: 'interrupted', role: 'worker', epoch, profile: 'alpha', account: null, runtime: 'claude',
  reason: `${reblockedMarker}${epoch} after its blocker was cleared`, resetsAt: null, partialWork: { state: 'committed', commit: 'a'.repeat(40), branch: 'graphyard/x', detail: 'kept' }, ...(endsBlocker ? { endsBlocker: true } : {}) });

async function blockedAttempt(title: string) {
  let work = (await call(master.token, 'work', { title, plannedFiles: ['src/a.ts'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Operator goal: reblocked attempts end' })).body as Work;
  work = (await call(master.token, `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready' })).body as Work;
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  const lease = work.lease!;
  work = await engine.execute(implementer, 'blocked', work.id, { epoch: lease.epoch, reason: 'sandbox /tmp owned by uid 65534' }, randomUUID());
  // Since GY-1008 a blocker ends its attempt at once; an attempt blocked before that still holds
  // its lease, which is the record the loop's reblocked end (GY-867) was made for.
  assert.equal(work.lease, null);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease}',$2::jsonb) WHERE id=$1", [work.id, JSON.stringify(lease)]);
  return reload(work.id);
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 881;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('reblocked-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('reblocked_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/reblocked_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const agent = await call(token(operator), 'operator-agents', { id: master.id, displayName: master.id, capabilities: master.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: master.token, reason: 'Onboarding provisions the master operator agent' });
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('integration:reblocked-attempt-ends-own-blocker — an interrupted report with endsBlocker ends the lease and the blocker that attempt wrote, and nothing else', async () => {
  // The attempt's own blocker ends with it, and the item is claimable again.
  const own = await blockedAttempt('Own blocker');
  const ended = await call(token(coordinator), `work/${own.id}/capacity`, interrupted(own.epoch, true));
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  let work = await reload(own.id);
  assert.equal(work.lease, null);
  assert.equal(work.blocker, null, 'its own blocker ended with the attempt');
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  assert.equal(work.epoch, own.epoch + 1, 'a new attempt claims the item');

  // Without endsBlocker the blocker stays, exactly as before.
  const plain = await blockedAttempt('Plain interruption');
  assert.equal((await call(token(coordinator), `work/${plain.id}/capacity`, interrupted(plain.epoch, false))).status, 200);
  assert.equal((await reload(plain.id)).blocker, 'sandbox /tmp owned by uid 65534');

  // endsBlocker is refused on anything but an interrupted worker end.
  const refused = await call(token(coordinator), `work/${plain.id}/capacity`, { ...interrupted(plain.epoch, true), cause: 'quota' });
  assert.equal(refused.status, 400);
});
