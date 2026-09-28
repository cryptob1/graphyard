import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { githubBudgetAttention, type BudgetStatus } from '../src/cli/github-budget-attention.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { storeAction } from '../src/daemon/state.js';
import type { FaultInstance } from '../src/model/fault-classes.js';
import type { Work } from '../src/model.js';

// GY-537. The observation class ("a read of GitHub or of a check that is paused, stale or silent")
// filed an item from three instances of ordinary operation: one base move that two candidates
// conflicted with — each refresh returning its candidate to the worker as designed — and one
// minute of paced spend projected to run out before the reset while the budget was above the
// reserve. Each instance is replayed here through the loop's own cycle: none counts toward the
// class, while a pause, a budget below the reserve and a refresh that genuinely fails still do.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2026-09-26T07:43:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const hour = 3_600_000;
const policy = { threshold: 3, windowHours: 24 };
const base = 'd40b0a8f006e'.padEnd(40, '0');

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: false, mergeMethod: 'merge', workers: [] });
}
/** A candidate whose base refresh the control plane confirmed conflicting, as GY-303 and GY-404 were. */
function conflicted(key: string, head: string): Work {
  const sha = head.padEnd(40, '0');
  const conflict = `Candidate ${sha.slice(0, 12)} cannot be brought onto base branch tip ${base.slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved: Speculative merge of ${base.slice(0, 12)} into graphyard-merge-check/${key.toLowerCase()} conflicts and cannot be resolved by Graphyard. Run graphyard sync ${key}, resolve it and push`;
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'test', revision: 1, policyRevision: 1,
    createdAt: iso(-hour), updatedAt: iso(0), stageEnteredAt: iso(-hour), ready: true, epoch: 1, lease: null, workspaces: [],
    candidate: { sha, baseSha: 'a'.repeat(40), pr: 300, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker', createdAt: iso(-hour) },
    submission: { epoch: 1, pr: 300, sha, principal: 'worker', at: iso(-hour) }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    baseRefresh: { from: { sha, baseSha: 'a'.repeat(40) }, base, baseTree: 'b'.repeat(40), policyRevision: 1, at: iso(0), head: null, conflict, merge: null, trigger: 'conflict confirmed' },
    gates: [], violations: [],
  } as unknown as Work;
}
/** The budget the third instance read: 3082 of 5000 left at 80.2/min, paced, above the reserve. */
const budget = (overrides: Partial<NonNullable<BudgetStatus['githubBudget']>> = {}): BudgetStatus => ({ githubBudget: {
  limit: 5000, remaining: 3082, resetAt: '2026-09-26T08:28:43.000Z', observedAt: iso(0), perMinute: 80.2, projectedExhaustionAt: '2026-09-26T08:24:18.946Z', exhaustsBeforeReset: true,
  reserve: 500, belowReserve: false, paused: null, lastHour: { requests: 1918, byKind: [{ kind: 'observe', requests: 1918 }] }, pace: { tier: 'paced', perMinute: 60 }, ...overrides } });

function effects(work: Work[], status: () => BudgetStatus, filed: unknown[]): DaemonEffects {
  return {
    closeSession: () => {}, dispatch: async () => ({}), requestProof: () => {}, merge: async () => ({}), recordDeployment: async () => ({}), requestSmoke: () => {},
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work, now: iso(0) }), persist: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    faultClassPolicy: policy, controlPlane: async () => ({ github: true, ...status() }),
    reportedAttention: async () => ({ items: githubBudgetAttention(status(), clock) }),
    fileFaultClass: async (input: any) => { filed.push(input); return { key: `GY-${900 + filed.length}`, origin: input.origin } as unknown as Work; },
  } as unknown as DaemonEffects;
}
const observation = (state: ReturnType<typeof emptyDaemonState>) => state.faults.instances.filter(entry => entry.faultClass === 'observation');

test('manual:fault-class-observation — the three listed observation instances are replayed through the loop and none counts toward the class', async () => {
  const filed: unknown[] = [];
  const state = emptyDaemonState(config());
  const work = [conflicted('GY-303', '892a53a6789f'), conflicted('GY-404', '11cdbc378234')];
  let now = clock;
  for (let round = 0; round < 3; round++) { now = clock + round * 61_000; await runCycle(config(), state, effects(work, () => budget(), filed), () => now); }

  // Instances 1 and 2: each conflict-confirmed refresh is recorded, named for the worker, and not retried…
  const refreshes = Object.values(state.actions).filter(action => action.kind === 'refresh');
  assert.deepEqual(refreshes.map(action => [action.work, action.state]).sort(), [['GY-303', 'failed'], ['GY-404', 'failed']]);
  for (const action of refreshes) assert.match(action.detail, /\[trigger: conflict confirmed\]: .* cannot be brought onto base branch tip d40b0a8f006e by Graphyard; it returns to the worker with the conflict named/);
  // …but it is the refresh doing its job: no class, no instance, nothing failing.
  for (const action of refreshes) assert.equal(action.faultClass, undefined, `${action.work}: a confirmed conflict carries no fault class`);
  assert.deepEqual(Object.keys(state.faults.failing).filter(key => key.startsWith('refresh:')), []);
  // Instance 3: the paced projection above the reserve is still shown to the operator, as a projection…
  const shown = githubBudgetAttention(budget(), clock);
  assert.deepEqual(shown.map(item => [item.subject, item.kind]), [['github', 'github-budget-projection']]);
  assert.match(shown[0].text, /3082 of 5000 requests remain and the spend rate is 80.2\/min .* exhausted at 2026-09-26T08:24:18.946Z, before it resets at 2026-09-26T08:28:43.000Z/);
  // …and is not an observation fault.
  assert.deepEqual(observation(state), [], 'none of the three instances is an observation fault');
  assert.deepEqual(filed, [], 'so nothing is filed for the class');
});

test('manual:fault-class-observation — a pause, a budget below the reserve and a refresh that genuinely fails still count toward the class', async () => {
  // A budget already below the merge-path reserve: non-merge observation is yielding.
  const below = githubBudgetAttention(budget({ remaining: 400, belowReserve: true }), clock);
  assert.deepEqual(below.map(item => item.kind), ['github-budget']);
  const filed: unknown[] = [];
  let status = budget({ remaining: 400, belowReserve: true });
  const state = emptyDaemonState(config());
  await runCycle(config(), state, effects([], () => status, filed), () => clock);
  assert.deepEqual(observation(state).map(entry => [entry.kind, entry.subject]), [['github-budget', 'github']]);
  // A pause is an observation fault.
  status = budget({ paused: { since: iso(0), until: iso(hour), reason: 'GitHub answered 403 rate limit exceeded' } });
  const paused = emptyDaemonState(config());
  await runCycle(config(), paused, effects([], () => status, filed), () => clock);
  assert.deepEqual(observation(paused).map(entry => [entry.kind, entry.subject]), [['github-budget', 'github']], 'the pause is an observation fault');
  // A refresh that fails for any reason other than a confirmed conflict is still an action:refresh fault.
  const failed = storeAction(state, 'refresh:work-GY-9:x:y:1', { kind: 'refresh', work: 'GY-9', principal: null, state: 'failed', detail: 'GitHub answered 502 reading the base branch', attempts: 1, epoch: null, cycle: 1, at: iso(0) });
  assert.equal(failed.faultClass, 'observation');
  assert.ok(observation(state).some(entry => entry.kind === 'action:refresh' && entry.subject === 'GY-9'));
});

test('manual:fault-class-observation — an upgrade retires the spurious instances an older build counted, so three of them file nothing', async () => {
  // The cursor an installation upgrades with: the two conflict refreshes and the above-reserve
  // projection as the previous build recorded them — observation instances, unlinked, inside the
  // window, at the threshold. Beside them, a real below-reserve fault and a refresh that failed
  // for a real reason, which the retirement must leave standing.
  const at = iso(-hour), earlier = iso(-2 * hour);
  const conflictText = (key: string, sha: string) =>
    `${key} [trigger: conflict confirmed]: ${sha} cannot be brought onto base branch tip ${base.slice(0, 12)} by Graphyard; it returns to the worker with the conflict named: Candidate ${sha.slice(0, 12)} cannot be brought onto base branch tip ${base.slice(0, 12)} without resolving a conflict`;
  const instance = (id: string, kind: FaultInstance['kind'], subject: string, text: string, seen: string): FaultInstance =>
    ({ id, kind, faultClass: 'observation', subject, text, at: seen, lastSeenAt: seen, linkedTo: null });
  const spurious = [
    instance(`action:refresh|GY-303|${at}`, 'action:refresh', 'GY-303', conflictText('GY-303', '892a53a6789f'.padEnd(40, '0')), at),
    instance(`action:refresh|GY-404|${at}`, 'action:refresh', 'GY-404', conflictText('GY-404', '11cdbc378234'.padEnd(40, '0')), at),
    instance(`github-budget|github|${at}`, 'github-budget', 'github',
      'GitHub budget: 3082 of 5000 requests remain and the spend rate is 80.2/min over the last ten minutes; at that rate the budget is exhausted at 2026-09-26T08:24:18.946Z, before it resets at 2026-09-26T08:28:43.000Z', at),
  ];
  const genuine = [
    instance(`github-budget|github|${earlier}`, 'github-budget', 'github',
      'GitHub budget: 400 of 5000 requests remain and the spend rate is 80.2/min over the last ten minutes; at that rate the budget is exhausted at 2026-09-26T07:54:18.946Z, before it resets at 2026-09-26T08:28:43.000Z; it is already below the 500-request merge-path reserve, so only merge-gate candidates and webhook wakes are observed', earlier),
    instance(`action:refresh|GY-9|${earlier}`, 'action:refresh', 'GY-9', 'GitHub answered 502 reading the base branch', earlier),
  ];
  const state = emptyDaemonState(config());
  state.faults.instances = [...spurious, ...genuine];
  state.faults.failing['refresh:work-GY-303:8'.padEnd(60, '8')] = spurious[0].id;
  state.faults.failing['refresh:work-GY-404:1'.padEnd(60, '1')] = spurious[1].id;
  const filed: unknown[] = [];
  await runCycle(config(), state, effects([], () => budget(), filed), () => clock);

  // The threshold was met — three unlinked instances in the window — yet the first cycle after the
  // upgrade files nothing: the designed outcomes retired, with the failing runs that named them…
  assert.deepEqual(filed, [], 'three spurious instances file nothing');
  assert.deepEqual(observation(state).map(entry => entry.id).sort(), genuine.map(entry => entry.id).sort(), 'the designed outcomes retired; the genuine faults stayed');
  assert.deepEqual(Object.keys(state.faults.failing).filter(key => key.startsWith('refresh:')), [], 'a retired run keeps no failing entry');
});
