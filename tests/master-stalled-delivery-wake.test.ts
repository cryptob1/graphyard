import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { emptyDaemonState, runCycle, daemonStateSchema, daemonStatePath, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { dispatchCauses, deploymentCauses } from '../src/daemon/master-stalled-delivery.js';
import { baseFailureReason } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const at = '2026-11-01T18:00:00Z', head = 'a'.repeat(40), base = 'b'.repeat(40);
const failure = (tip = base, assertion = 'expected 1, got 0') => baseFailureReason({ tip, files: ['tests/base.test.ts'], tests: ['base works'], assertion });
function held(reason = failure()): Work {
  return { id: 'item', key: 'GY-1', title: 'Queued delivery', stage: 'merge', ready: false, epoch: 1, revision: 1, policyRevision: 1,
    type: 'bug', criteria: [], dependencies: [], evidence: [], gates: [], workspaces: [], createdAt: at, updatedAt: at,
    candidate: { sha: head }, submission: { epoch: 1 },
    mergeLedger: { key: 'GY-1', state: 'refused', head, baseTip: base, mergeSha: 'c'.repeat(40), risk: null,
      intentAt: at, pushedAt: null, observedTip: null, refusal: { kind: 'merge', reason }, events: 3 },
  } as unknown as Work;
}
async function fixture(visible = true) {
  const directory = await temporaryDirectory('master-stalled-wake');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/project',
    credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [] });
  const prompts: string[] = [], launches: string[] = [];
  let work = [held()], fail = false, now = Date.parse(at);
  let external: ReturnType<typeof dispatchCauses> = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: at }), agents: () => visible ? [{ name: 'master', pane_id: 'pM', agent_status: 'working' }] : [],
    credentials: async () => ({}), closeSession: () => {}, dispatch: async () => { assert.fail('no new implementation attempt'); },
    persist: async () => {},
    masterSession: {
      pendingCauses: async () => external,
      wake: async (target, text) => { assert.equal(target, 'pM'); if (fail) throw new Error('delivery unavailable'); prompts.push(text); },
      launch: async text => { launches.push(text); visible = true; return { agentName: 'master', pane: 'pM', runtime: 'codex', account: 'account', session: 'registered-master' }; },
    },
  };
  let state = emptyDaemonState(config);
  return { directory, config, prompts, launches, effects, get state() { return state; },
    work: (next: Work[]) => { work = next; }, fail: (next: boolean) => { fail = next; },
    restart: () => { state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state))); },
    advance: (minutes: number) => { now += minutes * 60_000; },
    external: (causes: typeof external) => { external = causes; },
    cycle: () => runCycle(config, state, effects, () => now),
  };
}

test('integration:master-stalled-delivery-wake — working master receives diagnosis once, including across restart; changed details/base and resumed delivery update subjects', async () => {
  const f = await fixture();
  await f.cycle();
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0], /expected 1, got 0/);
  assert.match(f.prompts[0], /Next agent action: Diagnose/);
  assert.equal(f.state.master.lastWake?.causes[0], `base:${base}`);
  assert.equal(f.state.actions['master:wake'].kind, 'wake');
  for (let i = 0; i < 3; i++) await f.cycle();
  f.restart();
  await f.cycle();
  assert.equal(f.prompts.length, 1, 'same pending diagnosis survives restart without another prompt');
  const retry = held();
  retry.mergeLedger = { ...retry.mergeLedger!, state: 'intent', refusal: null };
  f.work([retry]);
  await f.cycle();
  f.restart();
  f.work([held()]);
  await f.cycle();
  assert.equal(f.prompts.length, 1, 'an unchanged base retrial does not re-prompt');
  f.work([held(failure(base, 'different assertion'))]);
  await f.cycle();
  assert.equal(f.prompts.length, 2);
  const nextBase = 'd'.repeat(40);
  f.work([held(failure(nextBase))]);
  await f.cycle();
  assert.equal(f.prompts.length, 3);
  assert.deepEqual(Object.keys(f.state.master.subjects), [`base:${nextBase}`]);
  f.work([{ ...held(), stage: 'done' }]);
  await f.cycle();
  assert.deepEqual(f.state.master.subjects, {});
  f.work([held(failure(nextBase))]);
  await f.cycle();
  assert.equal(f.prompts.length, 4, 'a new stall after recovery is actionable again');
  assert.equal(f.launches.length, 0);
});

test('integration:master-stalled-delivery-wake — absent master launches with unresolved cause; restart adopts without redelivery', async () => {
  const f = await fixture(false);
  await f.cycle();
  assert.equal(f.launches.length, 1);
  assert.match(f.launches[0], /base works/);
  assert.match(f.launches[0], /expected 1, got 0/);
  assert.equal(f.state.master.session, 'registered-master');
  assert.ok(f.state.master.lastWake);
  f.restart();
  await f.cycle();
  assert.equal(f.launches.length, 1);
  assert.equal(f.prompts.length, 0);
});

test('integration:master-stalled-delivery-wake — failed delivery remains pending on restart; duplicate held heads share one cause and worker failures do not wake', async () => {
  const f = await fixture();
  f.fail(true);
  await f.cycle();
  assert.equal(f.state.master.lastWake, null);
  assert.deepEqual(f.state.master.subjects, {});
  f.restart();
  f.fail(false);
  f.work([held(), { ...held(), id: 'other', key: 'GY-2' }]);
  await f.cycle();
  assert.equal(f.prompts.length, 1);
  assert.equal(Object.keys(f.state.master.subjects).length, 1);
  f.work([held('trial failed: tests worker.test.ts')]);
  await f.cycle();
  assert.deepEqual(f.state.master.subjects, {});
  assert.equal(f.prompts.length, 1);
});

test('integration:master-stalled-delivery-wake — master status distinguishes live coordinator from stalled delivery and names recovery action', async () => {
  const f = await fixture();
  await f.cycle();
  await writeFile(daemonStatePath(f.config), JSON.stringify(f.state));
  const root = await temporaryDirectory('master-stalled-status');
  execFileSync('git', ['init', '-q', root]);
  const report = (work: Work[]) => masterStatusReport(root, f.config, async () => ({ work, now: at }), async () => `${base}\n`);
  const stalled = await report([held()]);
  assert.equal(stalled.masterSession.state, 'working');
  assert.equal(stalled.delivery.state, 'stalled');
  assert.match(stalled.delivery.reason!, /expected 1, got 0/);
  assert.match(stalled.delivery.nextAction!, /file or advance its repair/);
  const resumed = await report([{ ...held(), stage: 'done' }]);
  assert.notEqual(resumed.delivery.state, 'stalled');
  assert.equal(resumed.delivery.reason, null);
});

for (const status of ['idle', 'working']) test(`integration:master-stalled-delivery-wake — bounded heartbeat for ${status}, repeated cycles and restart`, async () => {
  const f = await fixture();
  f.effects.agents = () => [{ name: 'master', pane_id: 'pM', agent_status: status }];
  f.config.run.masterHeartbeatMinutes = 7;
  f.work([{ ...held('ordinary trial failure'), blocker: null }]);
  await f.cycle();
  f.advance(6);
  await f.cycle();
  assert.equal(f.prompts.length, 0);
  f.restart();
  f.advance(1);
  await f.cycle();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.state.master.lastWake?.heartbeat, true);
  f.restart();
  for (let i = 0; i < 4; i++) await f.cycle();
  assert.equal(f.prompts.length, 1);
  f.advance(7);
  await f.cycle();
  assert.equal(f.prompts.length, 2);
  f.work([]);
  f.advance(60);
  await f.cycle();
  assert.equal(f.prompts.length, 2, 'no heartbeat without scoped open work');
});

test('integration:master-stalled-delivery-wake — blocker, launch failure, failed review and abandoned proof reach master once and clear on resolution', async () => {
  const f = await fixture();
  const item: Work = { ...held('ordinary trial failure'), blocker: 'worker cannot reach test database' };
  f.work([item]);
  f.state.actions['dispatch:item'] = { kind: 'dispatch', work: 'GY-1', principal: null, state: 'failed', detail: 'launch failed: runtime unavailable', attempts: 1, epoch: 1, cycle: 0, at };
  const review = { id: 'review-request', kind: 'review', state: 'requested', sha: head, baseSha: base, policyRevision: 1, pr: 1, requestedAt: at, reason: 'required' } as const;
  const proof = { id: 'proof-request', kind: 'producer', state: 'requested', sha: head, baseSha: base, policyRevision: 1, pr: 1, requestedAt: at, reason: 'required' } as const;
  item.autoDispatch = { review, producers: [proof], history: [] } as Work['autoDispatch'];
  const cursor = { failures: { 'review-request': { reason: 'review failed: session exited without verdict' } }, abandoned: { 'proof-request': { reason: 'proof abandoned: all attempts ended without evidence' } } } as unknown as Parameters<typeof dispatchCauses>[1];
  f.external(dispatchCauses([item], cursor));
  await f.cycle();
  for (const reason of ['worker cannot reach test database', 'runtime unavailable', 'session exited without verdict', 'all attempts ended without evidence', 'GY-1']) assert.ok(f.prompts[0].includes(reason));
  f.restart();
  for (let i = 0; i < 3; i++) await f.cycle();
  assert.equal(f.prompts.length, 1);
  assert.equal(Object.keys(f.state.master.subjects).length, 4);
  item.blocker = null;
  f.state.actions['dispatch:item'].state = 'done';
  item.autoDispatch = null;
  f.external(dispatchCauses([item], cursor));
  await f.cycle();
  assert.deepEqual(f.state.master.subjects, {});
  f.work([{ ...item, blocker: 'new unresolved cause' }]);
  await f.cycle();
  assert.equal(f.prompts.length, 2);
});

test('integration:master-stalled-delivery-wake — deployment failure handoff and absent master include concrete causes', async () => {
  const f = await fixture(false);
  f.work([{ ...held('ordinary trial failure'), blocker: 'worker build blocked' }]);
  f.external(deploymentCauses({ tip: base, reason: 'health failed: connection refused', restoring: head }));
  await f.cycle();
  assert.match(f.launches[0], /worker build blocked/);
  assert.match(f.launches[0], /health failed: connection refused/);
  f.restart();
  await f.cycle();
  assert.equal(f.prompts.length, 0);
  f.external(deploymentCauses(null));
  await f.cycle();
  assert.ok(!('deployment' in f.state.master.subjects));
});

test('integration:master-stalled-delivery-wake — actionable wake resets heartbeat deadline and failed board operations clear after retry', async () => {
  const f = await fixture();
  const item = held('ordinary trial failure');
  item.actionQueue = { actions: [{ id: 'board-review', kind: 'review', history: [{ event: 'failed', reason: 'review runner crashed', result: 'no verdict' }] }], history: [] } as unknown as Work['actionQueue'];
  f.work([item]);
  await f.cycle();
  assert.match(f.prompts[0], /GY-1 review: review runner crashed; no verdict/);
  f.advance(29);
  item.blocker = 'worker needs dependency repair';
  await f.cycle();
  assert.equal(f.prompts.length, 2);
  f.restart();
  f.advance(1);
  await f.cycle();
  assert.equal(f.prompts.length, 2, 'material wake reset the deadline');
  item.actionQueue = { actions: [], history: [] };
  item.blocker = null;
  await f.cycle();
  assert.deepEqual(f.state.master.subjects, {});
  f.advance(29);
  await f.cycle();
  assert.equal(f.prompts.length, 3);
  assert.equal(f.state.master.lastWake?.heartbeat, true);
});
