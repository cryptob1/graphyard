import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master.js';
import { authorizedForProof, unauthorizedProofs, type Principal, type Work } from '../src/model.js';
import { apiRoutes } from '../src/server/index.js';
import { HumanSignIn } from '../src/server/auth.js';
import { migration, retiredTables, tables } from '../src/store/schema.js';

// GY-2876 AC-2: dispatch is not capped and nothing is measured; proof authority is the roster's.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const at = '2031-01-01T00:00:00.000Z', clock = Date.parse(at);
const workers = Array.from({ length: 6 }, (_, index) => ({ name: `worker-${index + 1}`, principal: `worker-${index + 1}`, agentName: `agent-worker-${index + 1}`, mode: 'launch', kind: 'codex',
  credentialFile: '/nonexistent/worker.token', agentArgs: [], environment: {} }) as unknown as WorkerProfile);
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token', cliPath: launcher, repository: 'owner/project',
  baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers });
const ready = (index: number): Work => ({ id: `id-${index}`, key: `GY-${index}`, title: `Ready ${index}`, description: '', type: 'feature', priority: 1, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1,
  createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] }) as unknown as Work;

test('unit:uncapped-dispatch-roster-proofs — six ready items with six free worker profiles all dispatch in one cycle, nothing is measured, and proof authority is the roster\'s alone', async () => {
  const work = Array.from({ length: 6 }, (_, index) => ready(index + 1)), dispatched: string[] = [], written: DaemonState[] = [];
  const effects: DaemonEffects = {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work, now: at }), closeSession: () => {}, dispatch: async item => { dispatched.push(item.key); },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at, reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
    persist: async state => { written.push(JSON.parse(JSON.stringify(state))); },
  };
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, () => clock);
  assert.deepEqual(dispatched.sort(), work.map(item => item.key).sort(), 'every ready item dispatches in the one cycle');

  // No throughput, lead-time, latency or reclaim reading is written anywhere the loop writes: a cycle
  // records what it could act on and did, never how long it or any step or call took, nor what the host holds.
  assert.ok(written.length > 0);
  for (const cursor of [state, ...written]) {
    for (const field of ['latency', 'clocks', 'reclaim', 'memory']) assert.equal(field in cursor, false, `the cursor carries no ${field}`);
    for (const metric of cursor.metrics) assert.deepEqual(Object.keys(metric).sort(), ['actionable', 'actions', 'at', 'cycle', 'open'], 'a cycle records no measurement');
    assert.deepEqual(Object.keys(cursor.actions).filter(key => /^(throughput|wip|reclaim:(resources|trees|tmp)|attention:dispatch:memory|sweep:panes:)/.test(key)), []);
    assert.doesNotMatch(JSON.stringify(cursor), /durationMs|childWaitMs|workMs|planeWaitMs|timings|standing agentless/);
  }

  // Nor does anything beside the loop: no heartbeat latency on the server, no step or call timings in
  // master status, no child-wait ledger in the runner.
  const modules = { engine: await import('../src/engine.js'), runner: await import('../src/child-runner.js') };
  for (const name of ['LeaseHealth', 'leaseHealthWindowMs']) assert.equal(name in modules.engine, false, `the engine exports no ${name}`);
  assert.equal('ChildWaitLedger' in modules.runner, false);
  await assert.rejects(import('../src/master/timings.js' as string), /Cannot find module|ERR_MODULE_NOT_FOUND/);
  await assert.rejects(import('../src/cli/lease-health-attention.js' as string), /Cannot find module|ERR_MODULE_NOT_FOUND/);

  // Proof authority is the roster's --proof patterns: one without a pattern is refused, one with it accepted.
  // The admin role grants nothing of its own: a manual proof needs the admin's own roster pattern too.
  const bare: Principal = { id: 'producer-a', role: 'producer' }, seeded: Principal = { id: 'producer-b', role: 'producer', proofs: ['unit:*'] };
  const admin: Principal = { id: 'admin-a', role: 'admin' }, attester: Principal = { id: 'admin-b', role: 'admin', proofs: ['manual:*'] };
  assert.equal(authorizedForProof(bare, 'unit:works'), false);
  assert.equal(authorizedForProof(seeded, 'unit:works'), true);
  assert.equal(authorizedForProof(admin, 'manual:works'), false);
  assert.equal(authorizedForProof(attester, 'manual:works'), true);
  // A human sign-in session keeps its roster entry's patterns, and gains none it lacks.
  const signIn = new HumanSignIn(), session = (issuer: Principal) => signIn.authenticate(signIn.redeem(signIn.issue({ ...issuer, sessionKind: 'human' }, true).code).token)!;
  assert.equal(authorizedForProof(session(attester), 'manual:works'), true);
  assert.equal(authorizedForProof(session(admin), 'manual:works'), false);
  assert.deepEqual(unauthorizedProofs([admin], ['manual:works']), ['manual:works']);
  assert.deepEqual(unauthorizedProofs([bare], ['unit:works']), ['unit:works']);
  assert.deepEqual(unauthorizedProofs([bare, seeded], ['unit:works']), []);
  // No grant route serves or changes it, and no table holds it: the migration drops the old ones.
  const paths = apiRoutes.flatMap(module => module.routes).map(route => String(route.path));
  assert.deepEqual(paths.filter(path => /grant/.test(path)), []);
  assert.equal(tables.some(table => /grant/.test(table.name)), false);
  for (const table of ['proof_grants', 'proof_grant_history']) assert.ok(retiredTables.includes(table as typeof retiredTables[number]) && migration.includes(table), `${table} is dropped`);
});
