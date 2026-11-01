import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { emptyDaemonState, runCycle, daemonStateSchema, daemonStatePath, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { masterStatusReport } from '../src/cli/master-status.js';
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
  let work = [held()], fail = false;
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: at }), agents: () => visible ? [{ name: 'master', pane_id: 'pM', agent_status: 'working' }] : [],
    credentials: async () => ({}), closeSession: () => {}, dispatch: async () => { assert.fail('no new implementation attempt'); },
    persist: async () => {},
    masterSession: {
      wake: async (target, text) => { assert.equal(target, 'pM'); if (fail) throw new Error('delivery unavailable'); prompts.push(text); },
      launch: async text => { launches.push(text); visible = true; return { agentName: 'master', pane: 'pM', runtime: 'codex', account: 'account', session: 'registered-master' }; },
    },
  };
  let state = emptyDaemonState(config);
  return { directory, config, prompts, launches, effects, get state() { return state; },
    work: (next: Work[]) => { work = next; }, fail: (next: boolean) => { fail = next; },
    restart: () => { state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state))); },
    cycle: () => runCycle(config, state, effects, () => Date.parse(at)),
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
