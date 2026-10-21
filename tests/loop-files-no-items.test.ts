import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { baseFailureStep, baseFailureAttention } from '../src/daemon/cycle-base-failures.js';
import { advisoryIdle, advisoryStep, emptyMergeWriterState } from '../src/daemon/cycle-merge-writer.js';
import { daemonStatePath, readDaemonState } from '../src/daemon/state.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Work } from '../src/model.js';

// GY-2186: the loop files no work item on its own. A cycle that sees a test failing on the base
// branch, a flaky test past its rerun, a failing advisory test after a merge, exhausted docs
// headroom and a throughput needs-decision — plus every recurring fault class at any count — makes
// no work-item request: each is a master-status attention line, and the loop's effects expose no
// filing route at all.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const minute = 60_000, hour = 3_600_000;
const iso = (offset: number) => new Date(clock + offset).toISOString();
const sha = (seed: string) => { const hex = (c: string) => (c.charCodeAt(0) % 16).toString(16); return seed.split('').map(hex).join('').padEnd(40, '0').slice(0, 40); };
const serving = sha('serving');

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/x.ts'], stage: 'done', revision: 1, policyRevision: 1,
    createdAt: iso(-hour), updatedAt: iso(0), stageEnteredAt: iso(-hour), ready: true, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}
/** The serving delivery the deployment step verifies, so the throughput measurement runs. */
const delivered = () => item('GY-87', { title: "GY-87's throughput claim", delivery: { mergedAt: iso(-2 * hour), mergeSha: sha('m'), authorizationRevision: 1,
  deployment: { sha: serving, mergeSha: sha('m'), source: 'endpoint', observedAt: iso(-hour), covers: 'exact', at: iso(-hour), observer: 'coordinator-1' } } } as Partial<Work>);

test('unit:loop-files-no-items — a cycle with a failing base test, a flaked rerun, a failing advisory test, saturated docs headroom and a throughput needs-decision files nothing and raises no escalation', async t => {
  const root = await temporaryDirectory('loop-files-no-items');
  t.after(() => rm(root, { recursive: true, force: true }));
  const master = config(), state = emptyDaemonState(master);
  const work: Work[] = [delivered()];

  // 1. A test failing on the base branch: the merge ledger holds the writer's refusal, which the
  // base-failure step reads and raises as the attention line, never a filing.
  const head = sha('candidate'), tip = sha('basetip');
  const held = item('GY-100', { stage: 'review', candidate: { sha: head, baseSha: tip } } as Partial<Work>);
  held.mergeLedger = { key: 'GY-100', state: 'refused', head, baseTip: tip, mergeSha: null, risk: null, intentAt: iso(-minute), pushedAt: null, observedTip: null,
    refusal: { kind: 'merge', reason: `base failure: tests tests/base-failing.test.ts fail on the base tip ${tip} too: tests/base-failing.test.ts unit:base-failing` }, events: 1 } as Work['mergeLedger'];
  work.push(held);

  // 2. A test that failed once and passed on the rerun: the trial's flake, carried on the merge ledger.
  work.push(item('GY-101', { stage: 'review', candidate: { sha: sha('flakehead'), baseSha: tip } } as Partial<Work>)).constructor;
  const flaky = work.at(-1)!;
  flaky.mergeLedger = { key: 'GY-101', state: 'refused', head: sha('flakehead'), baseTip: tip, mergeSha: null, risk: null, intentAt: iso(-2 * minute), pushedAt: null, observedTip: null,
    refusal: { kind: 'merge', reason: 'trial failed: tests/flaky.test.ts fails on its first run and passes on its rerun' },
    flakes: [{ head: sha('flakehead'), mergeSha: sha('flicker'), files: ['tests/flaky.test.ts'], tests: ['tests/flaky.test.ts › unit:flaky'], at: iso(-2 * minute) }], events: 1 } as Work['mergeLedger'];

  const posted: string[] = [], escalations: string[] = [];
  const effects: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: work.map(entry => ({ ...entry })), now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'endpoint', sha: serving, at: iso(0), reason: null, deployed: ['GY-87'], pending: [], requests: 0 }),
    recordDeployment: async () => {},
    // The measurement misses its p50 with an admitted population past the minimum: a needs-decision
    // stands, and the loop neither files an owner nor raises an escalation on one (GY-2186).
    measureThroughput: async () => ({ outcome: 'recorded', revision: serving, verdict: 'unverified',
      detail: `Recorded for ${serving.slice(0, 12)}: unverified: submit→merge p50 45 min over the 30 min budget; 10 admitted of 10` }),
    persist: async () => {},
  };
  await runCycle(master, state, effects, () => clock);

  // No work item was created and no decision requested: every action row is a record, not a filing.
  for (const action of Object.values(state.actions)) {
    assert.doesNotMatch(action.detail, /^Filed /, `nothing is filed: ${action.detail}`);
    // A throughput or owner escalation would be a work-item ask; a launch-profile escalation on a
    // review-stage item is not a filing, so only those are forbidden here.
    if (action.kind === 'escalation' && /needs decision on |owner|Filed /.test(action.detail)) escalations.push(`${action.work}: ${action.detail}`);
  }
  assert.deepEqual(escalations, [], `no throughput or owner escalation is raised: ${JSON.stringify(escalations)}`);
  assert.deepEqual(Object.keys(state.actions).filter(key => key.includes('throughput:owner')), [], 'no throughput owner record');

  // 3. The base failure and the flake are the attention lines that name them.
  const baseFailures = await baseFailureStep({ state, effects, snapshot: { work, now: iso(0) }, clock, isolate: async () => undefined } as never);
  assert.equal(baseFailures.size, 0);
  const lines = baseFailureAttention(Object.values(state.baseFailures), master.baseBranch);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.match(lines[0]!.text, /Base branch main fails the trial test "tests\/base-failing\.test\.ts unit:base-failing"/);
  assert.match(lines[0]!.text, /no rework is requested for it and GY-999 \(P0\) repairs it|no rework is requested for it$/, 'no item is filed and none promised by the loop');

  // 4. A failing advisory test after a merge: one log line, no work item, no refusal.
  const logs: string[] = [], errors = console.error;
  console.error = line => logs.push(String(line));
  try {
    state.mergeWriter = emptyMergeWriterState();
    const mergeSha = sha('merged'), reads = { ...effects, mergeWriter: { advisory: async () => ({ build: 'fail', failed: ['tests/module-budgets.test.ts'] }) } };
    const step = advisoryStep as (cycle: unknown, delivered: { key: string; mergeSha: string } | null) => Promise<boolean>;
    await step({ state, effects: reads, now: () => clock, performed: [] }, { key: 'GY-87', mergeSha });
    await advisoryIdle(state);
    // The run settles beside the step: the next step folds its outcome, which is the one log line.
    await step({ state, effects: reads, now: () => clock, performed: [] }, null);
  } finally { console.error = errors; }
  assert.equal(logs.length, 1, JSON.stringify(logs));
  assert.match(logs[0]!, /The advisory budget tests failed on .*they are advisory, so nothing is refused, reverted or filed/);
  assert.deepEqual(Object.values(state.actions).filter(action => /advisory/i.test(action.detail) && action.work), [], 'the advisory failure files nothing');

  // The recurring classes the cycle saw stand as recorded instances, never items.
  assert.ok(Object.values(state.actions).every(action => action.kind !== 'fault' || !/^Filed /.test(action.detail)), 'no fault item is filed');
});

test('unit:no-flake-or-advisory-items — a test that fails then passes on rerun, and an advisory test that fails after a merge, file no work item and are at most one line each', async t => {
  // The flake: GY-101's merge ledger holds the trial's flake (failed once, passed on its rerun, none
  // of them the item's proofs). The writer holds the head on the ledger; the loop files nothing for
  // it, and the trial record is at most the one attention line the writer's own refusal names.
  const root = await temporaryDirectory('no-flake-items');
  t.after(() => rm(root, { recursive: true, force: true }));
  const master = config(), state = emptyDaemonState(master);
  const flaky = item('GY-101', { stage: 'review', candidate: { sha: sha('flakehead'), baseSha: sha('basetip') } } as Partial<Work>);
  flaky.mergeLedger = { key: 'GY-101', state: 'refused', head: sha('flakehead'), baseTip: sha('basetip'), mergeSha: null, risk: null, intentAt: iso(-2 * minute), pushedAt: null, observedTip: null,
    refusal: { kind: 'merge', reason: 'trial failed: tests/flaky.test.ts fails on its first run and passes on its rerun' },
    flakes: [{ head: sha('flakehead'), mergeSha: sha('flicker'), files: ['tests/flaky.test.ts'], tests: ['tests/flaky.test.ts › unit:flaky'], at: iso(-2 * minute) }], events: 1 } as Work['mergeLedger'];
  const effects: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [flaky], now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, persist: async () => {},
  };
  await runCycle(master, state, effects, () => clock);
  const filings = Object.values(state.actions).filter(action => action.kind === 'fault' && /^Filed |flake/i.test(action.detail));
  assert.deepEqual(filings, [], `a flake files no work item: ${JSON.stringify(filings.map(entry => entry.detail))}`);
  assert.deepEqual(Object.keys(state.actions).filter(key => key.startsWith('fault:')), [], 'no fault-class action row at all');

  // The advisory failure after a merge: one log line, no work item, no refusal, no revert.
  const logs: string[] = [], errors = console.error;
  console.error = line => logs.push(String(line));
  try {
    state.mergeWriter = emptyMergeWriterState();
    const reads = { ...effects, mergeWriter: { advisory: async () => ({ build: 'fail', failed: ['tests/module-budgets.test.ts'] }) } };
    const step = advisoryStep as (cycle: unknown, delivered: { key: string; mergeSha: string } | null) => Promise<boolean>;
    await step({ state, effects: reads, now: () => clock, performed: [] }, { key: 'GY-87', mergeSha: sha('merged') });
    await advisoryIdle(state);
    await step({ state, effects: reads, now: () => clock, performed: [] }, null);
  } finally { console.error = errors; }
  assert.equal(logs.length, 1, JSON.stringify(logs));
  assert.match(logs[0]!, /The advisory budget tests failed on .*they are advisory, so nothing is refused, reverted or filed/);
  const advisoryActions = Object.values(state.actions).filter(action => /advisory/i.test(action.detail));
  assert.deepEqual(advisoryActions.filter(action => action.work), [], 'an advisory failure files no work item');
  assert.ok(advisoryActions.every(action => action.state !== 'failed' || action.faultClass === undefined), 'and no fault instance either');
});

test('unit:loop-files-no-items — the loop exposes no filing effect at all', async t => {
  const { daemonEffects } = await import('../src/master-daemon.js');
  const root = await temporaryDirectory('loop-files-no-effects');
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = { snapshot: async () => ({ work: [], now: iso(0) }), mutate: async () => ({}), executor: { principal: 'coordinator', instance: 'test' } };
  const bare = daemonEffects(root, config(), deps) as unknown as Record<string, unknown>;
  const provisioned = daemonEffects(root, { ...config(), operatorAgent: { id: 'graphyard-master-operator', credentialFile: '/outside/operator.token' } } as MasterConfig, deps) as unknown as Record<string, unknown>;
  for (const effects of [bare, provisioned]) {
    assert.equal('fileFaultClass' in effects, false, 'no fault-class filing effect');
    assert.equal('fileBaseFailure' in effects, false, 'no base-failure filing effect');
    assert.equal('fileThroughputOwner' in effects, false, 'no throughput-owner filing effect');
    assert.equal('closeThroughputOwner' in effects, false, 'and no owner closing effect');
    assert.equal('diagnostician' in effects, false, 'and no diagnostician');
  }
});

test('unit:diagnostician-removed-cursor-loads — a cursor still carrying diagnoses, linked fault instances, advisory entries or base-failure item keys loads, and the retired keys drop on read', async t => {
  const root = await temporaryDirectory('diagnostician-cursor');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const directory = await temporaryDirectory('diagnostician-cursor-credentials');
  t.after(() => { rm(root, { recursive: true, force: true }); rm(directory, { recursive: true, force: true }); });
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const file = daemonStatePath(master);
  const base = emptyDaemonState(master);
  const carried = {
    ...base,
    // The diagnostician's records, per recurring item and invariant instance.
    diagnoses: { 'GY-1682': { subject: 'GY-1682', kind: 'recurring', faultClass: 'scope', work: 'GY-1682', state: 'answered', startedAt: iso(-hour), updatedAt: iso(-minute),
      runs: [{ runtime: 'pi', model: 'zai/glm-5.3-flash', startedAt: iso(-hour), endedAt: iso(-minute), result: 'diagnosed', detail: 'Diagnosed' }], diagnosis: null, fix: 'GY-1683', decision: null, answeredBy: 'GY-1683', refusedAt: null, retryAt: null, detail: 'answered' } },
    // Instance linking, and the instances themselves still carrying a link.
    faults: { ...base.faults, linked: { 'GY-1682': iso(-hour) }, instances: [{ id: 'blocker|GY-1|' + iso(-minute), kind: 'blocker', faultClass: 'stalled-gate', subject: 'GY-1', text: 'blocked', at: iso(-minute), lastSeenAt: iso(-minute), linkedTo: 'GY-1682' }] },
    // The advisory run ledger and a base-failure record naming the item an older loop filed for it.
    mergeWriter: { ...emptyMergeWriterState(), advisory: { since: iso(-2 * hour), due: [], ran: [{ key: 'GY-87', mergeSha: sha('merged'), deliveredAt: iso(-hour) }] } },
    baseFailures: { 'trial:work-100:abc': { test: 'tests/flaky.test.ts', check: 'trial', baseSha: tip40(), jobId: null, url: null, raisedAt: iso(-hour), blocks: [{ key: 'GY-100', id: 'work-100', sha: sha('candidate'), jobId: null, url: null }], item: 'GY-999', cleared: null } },
  };
  await writeFile(file, JSON.stringify(carried));
  const loaded = await readDaemonState(root, master);
  // Everything the loop still reads survived; the retired keys did not.
  assert.equal((loaded as unknown as Record<string, unknown>).diagnoses, undefined, 'the diagnoses record is dropped on read');
  assert.equal(loaded.faults.instances.length, 1, 'the recorded instances stay');
  assert.equal(loaded.faults.instances[0]!.linkedTo, 'GY-1682', 'an old link rides on its instance, read but never followed');
  assert.equal((loaded.faults as { linked?: unknown }).linked, undefined, 'the linked map is dropped on read');
  assert.equal(loaded.mergeWriter.advisory?.ran.length, 1, 'the advisory run ledger loads');
  assert.equal(Object.values(loaded.baseFailures)[0]!.item, 'GY-999', 'a base-failure record with its old item key loads');
  // And it round-trips: the next read loads the written-back cursor without the retired keys.
  await writeFile(file, JSON.stringify({ ...loaded }));
  const again = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(again.diagnoses, undefined);
  assert.equal(again.faults.linked, undefined);
});

function tip40() { return sha('basetip'); }

test('unit:diagnostician-removed-cursor-loads — the loop launches no diagnostician session, and acceptance still reads the run.diagnostician model settings', async () => {
  // The role's tool is gone from the Pi integration, and no module launches its sessions.
  const pi = await import('../integrations/pi/index.js');
  assert.equal('diagnose' in pi.graphyardTools, false, 'graphyard_diagnose is retired');
  // The headless model settings survive under the same configuration key, for the acceptance runs.
  const settings = diagnosticianSettings({ diagnostician: { model: 'zai/acceptance', fallbackModel: 'zai/strong' }, pi: { command: 'pi-a' } });
  assert.deepEqual({ model: settings.model, fallbackModel: settings.fallbackModel, command: settings.command, enabled: settings.enabled },
    { model: 'zai/acceptance', fallbackModel: 'zai/strong', command: 'pi-a', enabled: true });
  const defaults = diagnosticianSettings(undefined);
  assert.equal(defaults.model, 'zai/glm-5.3-flash', 'the default model reads even with no run.diagnostician configured');
  // A daemon summary carries no diagnoses section, so no status line can name a diagnostician run.
  const summary = await import('../src/daemon/run.js');
  const state = emptyDaemonState(config());
  const master = config();
  const detailed = (summary as { daemonSummary: (state: DaemonState, now: number, intervalMs: number, hostId: string) => Record<string, unknown> })
    .daemonSummary(state, clock, minute, master.hostId);
  assert.equal('diagnoses' in detailed, false, 'the daemon summary no longer reports diagnoses');
});
