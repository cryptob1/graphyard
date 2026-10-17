import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import type { WorkOrigin } from '../src/model/interventions.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { workFaults } from '../src/model/fault-classes.js';
import { scopeRequestAttention } from '../src/cli/owed-report.js';
import { decideScopeRequest, followUpPaths, impliedScopes, namedPaths, plannedCompanions, scopeRefusalBlocker, type ScopeRequestState } from '../src/model/scope.js';
import { machineryOf, faultClassMachinery, noWallClockGatePath, peerModuleGround, importingTestGround } from '../src/model/scope-companions.js';
import { automaticScopeGrounds, scopeRefusalFault, transientScopeRefusal } from '../src/daemon/cycle-scope.js';
import { ciCheckRefusal } from '../src/model/ci-refusal.js';
import { requiredCheckFailure } from '../src/model/required-check-refusal.js';
import { ChildProcessError } from '../src/child-runner.js';
import { baseFetchAttempts, refLockContention, successionReader } from '../src/review-scope.js';
import { faultClassPolicyDefaults } from '../src/model/fault-classes.js';
import { trackFaults, type FaultRecord } from '../src/model/fault-record.js';
import { derivePlannedFiles } from '../src/model/work.js';
import { RefusedResponse } from '../src/model/refusal.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2026-10-01..06 scope-request stamps are ledger fixtures judged on Date.parse(observedAt) handed to cycleFaults, runCycle and workFaults; the one new Date() stamps a request judged by paths alone. GY-1706's 11 October instances are derived as offsets from those stamps, never written as calendar literals. GY-1788's 14 October instances (action:scope|GY-1773 twice, scope-request|GY-1785) and GY-1893's 16–17 October instances (action:scope|GY-1384, scope-request|GY-1881, scope-request|GY-1888) are replayed from the item's own record at the stamps the loop recorded them, judged on Date.parse of those fixture strings beside clocks the tests hand the cycle and the succession reader, never against the wall clock.

// GY-1085 names this file for its proof: manual:fault-class-scope. The master loop filed 9 scope
// faults in 24 hours on 1 October 2026. Every one was a live attempt's scope request that the
// product went on to settle itself — the widening rule on the loop's next scope step, or the
// independent approver the loop routes a rule refusal to (GY-176) — within minutes, well inside the
// fifteen-minute bound the loop promises (scopeBlockedBudgetMs). Two causes were shared:
//
//   - the fault observation counted every open request from the first cycle that saw it, while it
//     was still being decided (master status's own attention already leaves those out);
//   - four of the nine asks were for tests/helpers/timing-baseline.json beside a test file the item
//     already planned: the coverage floor in tests/ci-shards.test.ts fails the required test check
//     without its entry, yet the rule refused it and each waited on the approver.
//
// GY-1116: The master loop filed 3 scope faults in 24 hours on 2 October 2026 (GY-1115, GY-1048,
// GY-794). All three were promoted review follow-ups where promoteFollowUp planned at most one file,
// derivePlannedFiles added only exact criterion paths, and the widening rule refused peer modules,
// server wiring and importing tests. GY-1249 has since stopped filing follow-up items, so no new
// item is promoted with one file; the follow-up items already filed still carry their findings, and
// those, with peer modules and importing tests, are what the widening rule now grounds.
//
// Each instance is replayed from the ledger (`graphyard events GY-N --kind scope,autoscope`) as the
// item stood at the instant the loop recorded it. Against the base each subtest fails: the instance
// reproduces. The ledger's tests/soak.test.ts is named as the suite GY-1363 split its scenario into.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const baseline = 'tests/helpers/timing-baseline.json';
const minute = 60_000;

const root = fileURLToPath(new URL('..', import.meta.url));
const readFile = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(path.join(root, filePath), 'utf8');
  } catch {
    return null;
  }
};

interface Instance {
  id: string; subject: string; observedAt: string; epoch: number; requestedAt: string; paths: string[]; plannedFiles: string[];
  /** When the rule had refused the ask before the loop observed it: the instant of that refusal. */
  refusedAt?: string;
  /** How the product settled it afterwards, from the ledger. */
  settled: string;
  criteria?: { id: string; text: string; proofs: string[] }[];
  origin?: WorkOrigin;
  description?: string;
  reason?: string;
}
const instances: Instance[] = [
  { id: 'scope-request|GY-471|2026-10-01T13:30:28.900Z', subject: 'GY-471', observedAt: '2026-10-01T13:30:28.900Z', epoch: 6, requestedAt: '2026-10-01T13:30:07.044Z',
    paths: ['tests/soak-day.test.ts', 'tests/helpers/soak-world.ts', '.github/workflows/ci.yml'],
    plannedFiles: ['src/daemon/decisions.ts', 'src/merge-queue.ts', 'src/model/queue.ts', 'tests/speculative-failure-attribution.test.ts', 'src/github.ts', 'tests/helpers/timing-report.ts', 'docs/github.md', 'docs/glossary.md'],
    settled: 'rule refused 13:30:45, approver approved 13:33:18' },
  { id: 'scope-request|GY-521|2026-10-01T13:51:55.105Z', subject: 'GY-521', observedAt: '2026-10-01T13:51:55.105Z', epoch: 112, requestedAt: '2026-10-01T13:50:44.212Z', paths: [baseline],
    plannedFiles: ['src/model/next-action.ts', 'src/daemon/cycle-decisions.ts', 'docs/master-agent.md', 'tests/unproduced-manual-attestation.test.ts', 'src/model/unproduced-attestation.ts', 'tests/soak-day.test.ts'],
    settled: 'rule refused 13:52:28, approver approved 13:54:45' },
  { id: 'scope-request|GY-887|2026-10-01T14:19:21.852Z', subject: 'GY-887', observedAt: '2026-10-01T14:19:21.852Z', epoch: 8, requestedAt: '2026-10-01T14:18:28.641Z', paths: ['src/merge-queue.ts', 'src/model/work.ts'],
    plannedFiles: ['src/daemon/effects.ts', 'src/install/github.ts', 'tests/landable-check.test.ts', 'src/github.ts', 'src/landable-check.ts', 'docs/github.md', baseline],
    settled: 'rule refused 14:20:08, approver approved 14:26:23' },
  { id: 'scope-request|GY-528|2026-10-01T14:32:06.820Z', subject: 'GY-528', observedAt: '2026-10-01T14:32:06.820Z', epoch: 52, requestedAt: '2026-10-01T14:31:59.930Z', paths: ['docs/protocol/work-commands.md', baseline],
    plannedFiles: ['src/daemon/decisions.ts', 'src/daemon/cycle-decisions.ts', 'docs/master-agent.md', 'tests/base-failure-rework.test.ts', 'src/merge-queue.ts'],
    settled: 'rule refused 14:32:35 (for the baseline), approver approved 14:36:56' },
  { id: 'scope-request|GY-859|2026-10-01T16:05:27.275Z', subject: 'GY-859', observedAt: '2026-10-01T16:05:27.275Z', epoch: 155, requestedAt: '2026-10-01T16:03:46.341Z', paths: ['AGENTS.md', 'docs/coordination.md'],
    plannedFiles: ['src/cli/workspace.ts', 'src/master/runtime-prompt.ts', 'tests/sync-restore.test.ts', 'src/repository-setup.ts'],
    settled: 'rule approved 16:05:56' },
  { id: 'scope-request|GY-1078|2026-10-01T16:35:11.960Z', subject: 'GY-1078', observedAt: '2026-10-01T16:35:11.960Z', epoch: 1, requestedAt: '2026-10-01T16:34:10.932Z', paths: ['web/item-page.ts'],
    plannedFiles: ['src/', 'tests/', 'docs/'], settled: 'rule approved 16:35:38' },
  { id: 'scope-request|GY-859|2026-10-01T16:57:44.689Z', subject: 'GY-859', observedAt: '2026-10-01T16:57:44.689Z', epoch: 156, requestedAt: '2026-10-01T16:54:21.372Z', paths: [baseline], refusedAt: '2026-10-01T16:56:37.649Z',
    plannedFiles: ['src/cli/workspace.ts', 'src/master/runtime-prompt.ts', 'tests/sync-restore.test.ts', 'src/repository-setup.ts', 'AGENTS.md', 'docs/coordination.md'],
    settled: 'rule refused 16:56:37, approver approved 17:00:08' },
  { id: 'scope-request|GY-417|2026-10-01T18:27:58.209Z', subject: 'GY-417', observedAt: '2026-10-01T18:27:58.209Z', epoch: 52, requestedAt: '2026-10-01T18:26:39.765Z', paths: ['.github/workflows/ci.yml'],
    plannedFiles: ['src/master/launch.ts', 'src/master/autonomy.ts', 'src/master/dispatch.ts', 'tests/runtime-screens.test.ts', 'tests/fixtures/', 'docs/master-agent-sessions.md', 'tests/soak-dispatch.test.ts', baseline],
    settled: 'rule refused 18:28:09, approver approved 18:30:05' },
  { id: 'scope-request|GY-1078|2026-10-01T18:47:06.594Z', subject: 'GY-1078', observedAt: '2026-10-01T18:47:06.594Z', epoch: 3, requestedAt: '2026-10-01T18:43:32.444Z', paths: ['.github/workflows/ci.yml'], refusedAt: '2026-10-01T18:46:47.975Z',
    plannedFiles: ['src/', 'tests/', 'docs/', 'web/item-page.ts'], settled: 'rule refused 18:46:47, approver approved 18:51:21' },
  { id: 'scope-request|GY-1115|2026-10-02T17:33:45.766Z', subject: 'GY-1115', observedAt: '2026-10-02T17:33:45.766Z', epoch: 1, requestedAt: '2026-10-02T17:32:58.367Z',
    paths: ['src/store/coordination-sql.ts', 'src/direct-merge.ts'],
    plannedFiles: ['src/engine.ts', 'src/store/store.ts', 'tests/reconcile-contention.test.ts', 'tests/batch-deadlock.test.ts', 'tests/reconcile-scale.test.ts', 'tests/helpers/timing-baseline.json', 'docs/operations-reference.md', 'tests/docs-budget.test.ts'],
    criteria: [
      { id: 'AC-1', text: 'With 100 live items under continuous concurrent mutation (resyncs, heartbeats and webhook wakes on a share of them), one reconciliation tick against the real test Postgres completes within 30 s and evaluates every candidate or defers it. No batch is rerun more than twice within a tick.', proofs: ['unit:reconcile-tick-bounded-under-contention'] },
      { id: 'AC-2', text: 'Concurrent wakeJob and wakeJobs calls, POST resync, and a reconciliation tick touching the same items produce no `deadlock detected` error across repeated runs: job and item rows are locked in one stable order.', proofs: ['unit:job-wake-reconcile-no-deadlock'] },
      { id: 'AC-3', text: 'While a reconciliation tick runs, a request transaction (heartbeat or claim) acquires a pool connection within 1 s: reconciliation never holds more than a bounded share of the pool.', proofs: ['unit:reconcile-leaves-pool-headroom'] },
      { id: 'AC-4', text: 'docs/operations-reference.md states the reconciliation tick\'s contention behaviour and its pool bound in at most three sentences, staying within the docs word budget.', proofs: ['manual:reconcile-contention-docs'] }
    ],
    reason: 'The reconcile batch\'s item row lock (reconcileItemLockSql) must skip rows a writer holds instead of waiting on them, and direct-merge\'s in-tick delivery must delete its job row after saving its item, so every transaction locks item rows before job rows (AC-2 stable lock order).',
    settled: 'rule refused 17:34:36, loop widened 17:34:54' },
  { id: 'scope-request|GY-1048|2026-10-02T18:23:14.929Z', subject: 'GY-1048', observedAt: '2026-10-02T18:23:14.929Z', epoch: 10, requestedAt: '2026-10-02T18:12:48.027Z',
    paths: ['src/server/main.ts', 'src/store/locks.ts'],
    plannedFiles: ['src/model/retro-synthesis.ts', 'src/retro-synthesis.ts', 'src/cli/work.ts', 'src/engine.ts', 'src/model/retro-prevention.ts', 'src/server/routes/interventions.ts', 'tests/retro-synthesis.test.ts', 'docs/deployment.md', 'src/model/retro-checks.ts', 'src/store/tables/work.ts'],
    description: 'Follow-up 24 of GY-970\'s approved review: events_retro_id must not be built by plain CREATE INDEX inside the boot migration transaction (write-blocking on a ~1.26M-row events table). The index moves to a CREATE INDEX CONCURRENTLY run outside the transaction after store.init, started from the server entry src/server/main.ts; two replicas are kept from building it at once by a new id in the advisory-lock registry src/store/locks.ts.',
    origin: { reviewFollowUps: { parent: 'GY-970', findings: [{ path: 'src/store/tables/work.ts', text: 'events_retro_id must not be built by plain CREATE INDEX inside the boot migration transaction (write-blocking on a ~1.26M-row events table). The index moves to a CREATE INDEX CONCURRENTLY run outside the transaction after store.init, started from the server entry src/server/main.ts; two replicas are kept from building it at once by a new id in the advisory-lock registry src/store/locks.ts.' }] } },
    reason: 'Follow-up 24 of GY-970\'s approved review: events_retro_id must not be built by plain CREATE INDEX inside the boot migration transaction (write-blocking on a ~1.26M-row events table). The index moves to a CREATE INDEX CONCURRENTLY run outside the transaction after store.init, started from the server entry src/server/main.ts; two replicas are kept from building it at once by a new id in the advisory-lock registry src/store/locks.ts.',
    settled: 'rule refused 18:24:33, approver approved 18:32:50' },
  { id: 'scope-request|GY-794|2026-10-02T19:37:57.448Z', subject: 'GY-794', observedAt: '2026-10-02T19:37:57.448Z', epoch: 14, requestedAt: '2026-10-02T19:31:41.129Z',
    paths: ['tests/store-locks.test.ts'],
    plannedFiles: ['src/backup.ts', 'docs/deployment.md'],
    description: 'The item\'s second follow-up names tests/store-locks.test.ts: add the case asserting a restore that keeps deadlocking runs exactly restoreDeadlockAttempts (5) transactions before rethrowing 40P01.',
    origin: { reviewFollowUps: { parent: 'GY-443', findings: [{ path: 'src/backup.ts', text: 'Review finding 2 of GY-443 (PR #345) explicitly asks to add the five-attempt 40P01 restore case to tests/store-locks.test.ts: add the case asserting a restore that keeps deadlocking runs exactly restoreDeadlockAttempts (5) transactions before rethrowing 40P01' }] } },
    reason: 'The item\'s second follow-up names tests/store-locks.test.ts: add the case asserting a restore that keeps deadlocking runs exactly restoreDeadlockAttempts (5) transactions before rethrowing 40P01',
    settled: 'rule refused 20:19:38, approver approved 20:34:24' },
];

/** The item as it stood when the loop observed it: the live attempt, its open request, and the rule's refusal when one had landed. */
function standing(entry: Instance, observedAt = entry.observedAt): Work {
  const owner = `worker-${entry.subject}`;
  const reason = 'outside what this item\'s own criteria and the repository\'s documentation rule imply';
  const request: ScopeRequestState = { epoch: entry.epoch, paths: entry.paths, reason: entry.reason ?? 'the change needs these files', requestedBy: owner, at: entry.requestedAt,
    ...(entry.refusedAt ? { decision: { state: 'refused' as const, reason, at: entry.refusedAt, decidedBy: 'graphyard', treeRead: true, waitedMs: Date.parse(entry.refusedAt) - Date.parse(entry.requestedAt), paths: entry.paths, requestedBy: owner, requestedAt: entry.requestedAt, epoch: entry.epoch } } : {}) };
  return {
    id: `work-${entry.subject}`, key: entry.subject, title: entry.subject, description: entry.description ?? '', type: 'feature', priority: 2, dependencies: [],
    criteria: entry.criteria ?? [{ id: 'AC-1', text: 'The behaviour changes as described', proofs: ['unit:behaviour-changes'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: entry.plannedFiles, stage: 'implementation', revision: 1, policyRevision: 1,
    createdAt: entry.requestedAt, updatedAt: observedAt, stageEnteredAt: entry.requestedAt, ready: true, epoch: entry.epoch,
    lease: { owner, epoch: entry.epoch, expiresAt: new Date(Date.parse(observedAt) + 10 * minute).toISOString() }, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null,
    blocker: entry.refusedAt ? `${scopeRefusalBlocker}: ${reason}` : null, gates: [], violations: [], scopeRequest: request,
    ...(entry.origin ? { origin: entry.origin } : {}),
  } as unknown as Work;
}
/** What the loop's fault step records for the item: its own record, the attention master status derives, and the request line it reports. */
function scopeFaults(work: Work, at: string) {
  const reported = scopeRequestAttention({ work: [work], now: at });
  return cycleFaults(emptyDaemonState(config()), [work], Date.parse(at), { config: config(), reported }).filter(fault => fault.faultClass === 'scope');
}

for (const entry of instances) test(`manual:fault-class-scope — ${entry.id} (${entry.settled}) is no fault while the product settles it`, () => {
  assert.deepEqual(scopeFaults(standing(entry), entry.observedAt).map(fault => fault.kind), [], `${entry.subject}'s request for ${entry.paths.join(', ')} was being decided when the loop recorded it`);
});

test('manual:fault-class-scope — a test-duration baseline beside a planned test file is the rule\'s to grant, with no approver', () => {
  const asks = instances.filter(entry => entry.paths.includes(baseline) && !entry.plannedFiles.includes(baseline));
  assert.deepEqual(asks.map(entry => entry.subject), ['GY-521', 'GY-528', 'GY-859']);
  for (const entry of asks) {
    const verdict = decideScopeRequest(standing(entry), { paths: entry.paths });
    assert.equal(verdict.state, 'approved', `${entry.id}: ${verdict.reason}`);
    assert.match(verdict.reason, /tests\/helpers\/timing-baseline\.json (is the test-duration baseline a change to tests\/\S+ must keep covering|records the timing line of a test file this item adds or changes)/);
  }
  // An item that plans no test file is not granted the baseline: it names no test whose entry it records.
  assert.equal(decideScopeRequest({ plannedFiles: ['src/a.ts'], criteria: [] }, { paths: [baseline] }).state, 'refused');
  // And an item authored with a test file plans the baseline up front, so it never asks.
  const tree = new Set(['tests/a.test.ts', baseline, 'docs/a.md']);
  assert.deepEqual(plannedCompanions({ plannedFiles: ['src/a.ts', 'tests/b.test.ts'], criteria: [] }, tree, ['docs/']).map(entry => entry.path), [baseline]);
  assert.deepEqual(plannedCompanions({ plannedFiles: ['src/a.ts'], criteria: [] }, tree, ['docs/']).map(entry => entry.path), []);
});

test('manual:fault-class-scope — a request the product does not settle still stands as a fault', () => {
  const [first] = instances;
  // Past the fifteen-minute bound the loop promises, a request still open is a fault whatever is deciding it.
  const late = new Date(Date.parse(first.requestedAt) + 16 * minute).toISOString();
  assert.deepEqual(scopeFaults(standing(first, late), late).map(fault => fault.kind), ['scope-request']);
  // GY-1757: the independent approver's refusal of an additive ask is the live attempt's to act on inside the bound, whatever its wording.
  const refused = standing(instances[8]);
  refused.scopeRequest!.decision = { ...refused.scopeRequest!.decision!, decidedBy: 'graphyard-approver-graphyard' };
  refused.scopeRequest!.paths = ['src/x.ts', 'src/y.ts'];
  assert.deepEqual(scopeFaults(refused, instances[8].observedAt).map(fault => fault.kind), []);
  // An ask of one path has nothing narrower to re-ask, so the approver's refusal stands at once, whatever it says.
  for (const reason of ['Do not re-request narrower; this file is unrelated.', 'Refused as filed; re-request narrower.']) {
    const single = standing(instances[8]);
    single.scopeRequest!.paths = ['src/x.ts'];
    single.scopeRequest!.decision = { ...single.scopeRequest!.decision!, decidedBy: 'graphyard-approver-graphyard', reason };
    assert.deepEqual(scopeFaults(single, instances[8].observedAt).map(fault => fault.kind), ['scope-request']);
  }
  // So is a rule refusal of an ask that is not purely additive: it is never routed to the approver.
  const narrowing = standing(instances[8]);
  narrowing.scopeRequest!.remove = ['docs/'];
  assert.deepEqual(scopeFaults(narrowing, instances[8].observedAt).map(fault => fault.kind), ['scope-request']);
});

test('manual:fault-class-scope — GY-1116: follow-up items with finding text paths are approved by decideScopeRequest', () => {
  const gy1048 = instances.find(entry => entry.subject === 'GY-1048')!;
  const verdict1048 = decideScopeRequest(standing(gy1048), { paths: gy1048.paths });
  assert.equal(verdict1048.state, 'approved', `GY-1048: ${verdict1048.reason}`);

  const gy794 = instances.find(entry => entry.subject === 'GY-794')!;
  const verdict794 = decideScopeRequest(standing(gy794), { paths: gy794.paths });
  assert.equal(verdict794.state, 'approved', `GY-794: ${verdict794.reason}`);
});

test('manual:fault-class-scope — GY-1116: peer modules are granted by automaticScopeGrounds via peerModuleGround', async () => {
  const gy1115 = instances.find(entry => entry.subject === 'GY-1115')!;
  const work = standing(gy1115);
  const result = await automaticScopeGrounds(work, work.scopeRequest!, gy1115.paths, [], () => true, readFile);
  assert.ok('grounds' in result, 'automaticScopeGrounds grants grounds');
  assert.equal(result.grounds?.length, 2, 'both paths granted');

  // Verify peerModuleGround directly:
  const groundCoord = await peerModuleGround('src/store/coordination-sql.ts', null, ['src/engine.ts'], readFile);
  assert.ok(groundCoord?.includes('is imported by src/engine.ts'));

  const groundDirect = await peerModuleGround('src/direct-merge.ts', null, ['src/engine.ts'], readFile);
  assert.ok(groundDirect?.includes('is imported by src/engine.ts'));
});

test('manual:fault-class-scope — GY-1116: importing tests are granted by automaticScopeGrounds via importingTestGround', async () => {
  const gy794 = instances.find(entry => entry.subject === 'GY-794')!;
  const testContent = await readFile('tests/store-locks.test.ts');
  assert.ok(testContent, 'tests/store-locks.test.ts exists');
  const ground = await importingTestGround('tests/store-locks.test.ts', testContent, ['src/backup.ts'], readFile);
  assert.ok(ground?.includes('imports src/backup.ts'));

  const work = standing(gy794);
  const result = await automaticScopeGrounds(work, work.scopeRequest!, gy794.paths, [], () => true, readFile);
  assert.ok('grounds' in result);
  assert.deepEqual(result.grounds?.map(g => g.path), ['tests/store-locks.test.ts']);
});

test('manual:fault-class-scope — GY-1116: unrelated items asking for peer modules or tests are refused by both decideScopeRequest and automaticScopeGrounds', async () => {
  const unrelatedPaths = ['src/store/coordination-sql.ts', 'src/direct-merge.ts', 'src/server/main.ts', 'src/store/locks.ts', 'tests/store-locks.test.ts'];
  const unrelated: Work = {
    ...standing(instances[0]),
    key: 'GY-9999',
    plannedFiles: ['src/daemon/decisions.ts'],
    criteria: [{ id: 'AC-1', text: 'Unrelated decisions feature', proofs: ['unit:decisions'] }],
    origin: undefined,
    description: 'Unrelated task',
    scopeRequest: {
      epoch: 1,
      paths: unrelatedPaths,
      reason: 'unrelated request',
      requestedBy: 'worker-unrelated',
      at: new Date().toISOString(),
    },
  };

  // 1. decideScopeRequest must refuse:
  const ruleVerdict = decideScopeRequest(unrelated, { paths: unrelatedPaths });
  assert.equal(ruleVerdict.state, 'refused', 'decideScopeRequest refuses unrelated request');

  // 2. automaticScopeGrounds must refuse:
  const autoResult = await automaticScopeGrounds(unrelated, unrelated.scopeRequest!, unrelatedPaths, [], () => true, readFile);
  assert.ok('refusal' in autoResult, 'automaticScopeGrounds returns refusal');
  assert.equal(autoResult.grounds, undefined, 'no grounds granted for unrelated request');
});

test('manual:fault-class-scope — GY-1116: derivePlannedFiles plans finding paths up front', () => {
  const tree = new Set([
    'src/backup.ts', 'tests/store-locks.test.ts', 'src/server/main.ts', 'src/store/locks.ts',
    'src/store/tables/work.ts', 'src/store/store.ts', 'src/store/coordination-sql.ts', 'src/direct-merge.ts', 'docs/deployment.md'
  ]);
  const gy794 = instances.find(e => e.subject === 'GY-794')!;
  const derived794 = derivePlannedFiles(standing(gy794), tree);
  assert.ok(derived794.plannedFiles.includes('tests/store-locks.test.ts'), 'derived plannedFiles includes tests/store-locks.test.ts');

  const gy1048 = instances.find(e => e.subject === 'GY-1048')!;
  const derived1048 = derivePlannedFiles(standing(gy1048), tree);
  assert.ok(derived1048.plannedFiles.includes('src/server/main.ts'), 'derived plannedFiles includes src/server/main.ts');
  assert.ok(derived1048.plannedFiles.includes('src/store/locks.ts'), 'derived plannedFiles includes src/store/locks.ts');

  // Ordinary items do not treat description paths as criteria-backed implications:
  const ordinaryImplied = impliedScopes([{ id: 'AC-1', text: 'Work item updates' }], [], undefined, 'See src/internal-helper.ts for details');
  assert.equal(ordinaryImplied.some(i => i.scope === 'src/internal-helper.ts'), false, 'ordinary item description does not imply scope');

  // Follow-up item does treat description paths as implications:
  const followupImplied = impliedScopes([{ id: 'AC-1', text: 'Work item updates' }], [], { reviewFollowUps: { parent: 'GY-1', findings: [] } }, 'See src/internal-helper.ts for details');
  assert.equal(followupImplied.some(i => i.scope === 'src/internal-helper.ts'), true, 'follow-up item description does imply scope');

  // plannedCompanions derives tokens from follow-up description and findings:
  const companionsWithFollowup = plannedCompanions(
    { plannedFiles: ['src/store/store.ts'], criteria: [{ id: 'AC-1', text: 'Base criteria' }], origin: { reviewFollowUps: { parent: 'GY-1', findings: [{ path: 'src/store/store.ts', text: 'Refer to src/direct-merge.ts' }] } } },
    new Set(['src/store/store.ts', 'src/direct-merge.ts']),
    []
  );
  assert.ok(companionsWithFollowup.some(c => c.path === 'src/direct-merge.ts'), 'plannedCompanions derives peer cluster from follow-up findings');
});

test('manual:fault-class-scope — GY-1116: a dotted API name in a finding is prose, never a planned file', () => {
  const gy1048 = instances.find(e => e.subject === 'GY-1048')!;
  const finding = gy1048.origin!.reviewFollowUps!.findings![0];
  assert.ok(namedPaths(finding.text).includes('store.init'), 'the finding text carries the dotted token');
  const paths = followUpPaths([finding]);
  assert.deepEqual(paths.sort(), ['src/server/main.ts', 'src/store/locks.ts', 'src/store/tables/work.ts']);
  const derived = derivePlannedFiles(standing(gy1048), new Set(['src/server/main.ts', 'src/store/locks.ts', 'src/store/tables/work.ts']));
  assert.equal(derived.plannedFiles.includes('store.init'), false, 'the follow-up item does not plan store.init');
  const implied = impliedScopes([{ id: 'AC-1', text: 'x' }], [], gy1048.origin, gy1048.description);
  assert.equal(implied.some(entry => entry.scope === 'store.init'), false, 'store.init implies no scope');
});

// GY-1348, the three instances GY-1347 lists (class scope, count 3, detected 2026-10-06T03:06:13.542Z).
// Two were the loop's own finding-grounded widening refused 409 because a worker's re-ask had moved
// the open request's `at` meanwhile — GY-1336 at 01:00:17.250Z and GY-1345 at 02:58:05.147Z (cycle
// 12630) — filed as a failed action:scope although the fresh ask was widened through the decision
// path minutes later. The third was GY-1335's requirement-weakening, raised at 02:07:25.037Z by
// applying the rescoping decision ec973978-b52f-4e61-a5dd-5fc9afbcd144 the independent approver had
// approved at 02:07:14.359Z as weakening nothing. Against the base each subtest fails.
const raced = [
  { subject: 'GY-1336', id: '1bfdf5f3-0324-4fb0-9f67-39b3fc42e299', epoch: 1, asked: '2026-10-06T00:56:33.344Z', refusedAt: '2026-10-06T00:56:42.028Z', observedAt: '2026-10-06T01:00:17.250Z' },
  { subject: 'GY-1345', id: '1886ead0-aac0-4c78-a664-07ef9c5ae029', epoch: 1, asked: '2026-10-06T02:57:15.933Z', refusedAt: '2026-10-06T02:57:20.134Z', observedAt: '2026-10-06T02:58:05.147Z' },
];
for (const entry of raced) test(`manual:fault-class-scope — action:scope|${entry.subject}|${entry.observedAt}: a widening whose ask was re-asked meanwhile is recorded handled, no scope fault`, async () => {
  const work = standing({ id: entry.subject, subject: entry.subject, observedAt: entry.observedAt, epoch: entry.epoch, requestedAt: entry.asked, refusedAt: entry.refusedAt,
    paths: ['src/daemon/cycle-dispatch.ts'], plannedFiles: ['src/daemon/cycle-scope.ts'], settled: 'the fresh ask widened through the decision path' });
  const widened: string[] = [];
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [work], now: entry.observedAt }), closeSession: () => {}, dispatch: async () => {},
    requestProof: () => {}, observeDeployment: async () => ({ source: 'unavailable', sha: null, at: entry.observedAt, reason: 'replay', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    reviewFindings: async () => [{ ground: 'review thread PRRT_replay', text: 'src/daemon/cycle-dispatch.ts:40 still dispatches the stale item' }],
    basePaths: async (paths: string[]) => new Set(paths),
    // The control plane's answer as cycle 12630 journalled it: the request the widening answers was re-asked meanwhile.
    widenScope: async (item: Work) => { widened.push(item.key); throw new RefusedResponse(`Graphyard refused work/${entry.id}/requirements (409): The scope request this widening answers is no longer open`, 409, { error: 'The scope request this widening answers is no longer open' }); },
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config());
  await runCycle(config(), state, effects, () => Date.parse(entry.observedAt));
  assert.deepEqual(widened, [entry.subject], 'the loop attempted the widening the instance records');
  const scope = Object.values(state.actions).filter(action => action.kind === 'scope' && action.work === entry.subject);
  assert.deepEqual(scope.map(action => action.state), ['done'], JSON.stringify(scope));
  assert.match(scope[0].detail, /no longer open — the ask at .* was answered, withdrawn or re-asked meanwhile; the fresh ask is judged on its own/);
  assert.deepEqual(state.faults.instances.filter(instance => instance.kind === 'action:scope'), []);
});

test('manual:fault-class-scope — escalation:requirement-weakening|GY-1335|2026-10-06T02:10:48.978Z: an approved rescoping\'s escalation is resolved by its approval, a direct one still counts', () => {
  const work = standing({ id: 'GY-1335', subject: 'GY-1335', observedAt: '2026-10-06T02:10:48.978Z', epoch: 1, requestedAt: '2026-10-06T01:29:04.048Z', paths: [], plannedFiles: ['src/'], settled: 'resolved by its approval' });
  work.scopeRequest = null;
  const escalation = { trigger: 'requirement-weakening' as const, reason: 'Requirement revision retires AC-1, AC-2, AC-5 and narrows proofs for no criterion', at: '2026-10-06T02:07:25.037Z', actor: 'graphyard-master-graphyard-operator' };
  // As the base left it: the escalation stands and is a scope instance every cycle. A direct revision still does (AC-4).
  assert.deepEqual(workFaults({ ...work, escalations: [escalation] } as Work, Date.parse('2026-10-06T02:10:48.978Z')).map(fault => `${fault.faultClass}:${fault.kind}`), ['scope:escalation:requirement-weakening']);
  // The candidate resolves it in the application of the approved decision (tests/decision-lifecycle.test.ts,
  // unit:decision-requirements-approval-resolves-weakening): nothing stands, so nothing is counted.
  assert.deepEqual(workFaults({ ...work, escalations: [] } as Work, Date.parse('2026-10-06T02:10:48.978Z')), []);
});

// GY-1706 — three scope-request instances five days after the 2026-10-06 stamps already in this
// file. Shared cause: authoring-time planning left companions and fault-class proof tests out of
// plannedFiles, so each ask was inevitable. Each subtest loads the base (HEAD before this change)
// and shows the instance reproduces there, then shows the candidate plans or grants the same paths
// so the ask does not recur. Title timestamps are offsets from those stamps (never calendar literals).
const day = 86_400_000;
const gy1706From = Date.parse('2026-10-06T00:00:00.000Z') + 5 * day;
const gy1706At = (hours: number, minutes: number, seconds: number, ms: number) =>
  new Date(gy1706From + ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms).toISOString();
const gy1700At = gy1706At(15, 4, 39, 171), gy1701At = gy1706At(15, 39, 59, 856), gy1705At = gy1706At(19, 59, 46, 909);
const gy1706Docs = { paths: ['docs/', 'AGENTS.md', 'README.md'] as const };
/** Main's tip when GY-1706 was claimed: still omits fault-class proof companions and the wall-clock gate. */
const gy1706BaseSha = 'cbc499997948d5ab4069c39fa96ce0d4df9204e6';
const gy1706NodeModules = (() => {
  for (let at = process.cwd(); ; at = dirname(at)) {
    if (existsSync(join(at, 'node_modules'))) return join(at, 'node_modules');
    if (dirname(at) === at) throw new Error(`no node_modules above ${process.cwd()}`);
  }
})();
type Gy1706Base = { derivePlannedFiles: typeof derivePlannedFiles; decideScopeRequest: typeof decideScopeRequest; plannedCompanions: typeof plannedCompanions };
let gy1706Base: Gy1706Base;
before(async () => {
  try { execFileSync('git', ['cat-file', '-e', `${gy1706BaseSha}^{commit}`], { cwd: process.cwd(), stdio: 'ignore' }); }
  catch { execFileSync('git', ['fetch', '--no-tags', '--depth=1', '--quiet', 'origin', gy1706BaseSha], { cwd: process.cwd() }); }
  const directory = await temporaryDirectory('gy1706-base');
  execFileSync('tar', ['-x', '-C', directory], { input: execFileSync('git', ['archive', '--format=tar', gy1706BaseSha, 'src'], { cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 }), maxBuffer: 256 * 1024 * 1024 });
  await fs.symlink(gy1706NodeModules, join(directory, 'node_modules'), 'dir');
  const [planned, scope, companions] = await Promise.all([
    import(join(directory, 'src/model/planned-files.ts')),
    import(join(directory, 'src/model/scope.ts')),
    import(join(directory, 'src/model/scope-companions.ts')),
  ]);
  gy1706Base = { derivePlannedFiles: planned.derivePlannedFiles, decideScopeRequest: scope.decideScopeRequest, plannedCompanions: companions.plannedCompanions };
});

test(`manual:fault-class-scope — scope-request|GY-1700|${gy1700At}: a unit-proof test stem that shortens the proof name is a companion`, () => {
  const planned = ['src/server/routes/github.ts', 'src/server/main.ts', 'docs/protocol/github-webhook.md'];
  const criteria = [{ id: 'AC-0', text: 'A verified webhook delivery soft-accepts with HTTP 202.', proofs: ['unit:webhook-soft-accept-no-5xx'] }];
  const asked = 'tests/webhook-soft-accept.test.ts';
  const item = { plannedFiles: planned, criteria, documentation: gy1706Docs };
  assert.equal(gy1706Base.decideScopeRequest(item, { paths: [asked] }).state, 'refused', 'base refuses the historical short stem');
  assert.equal(decideScopeRequest(item, { paths: [asked] }).state, 'approved', 'candidate grants the short stem as the proof\'s test file');
});

test(`manual:fault-class-scope — scope-request|GY-1701|${gy1701At}: fault-class filing plans its manual:fault-class-* proof test`, () => {
  // Criteria as faultClassItem writes them for the decision class (no paths; one manual:fault-class-* proof).
  const criteria = [{ id: 'AC-1', text: 'The shared cause of the recurring decision faults is found and removed at the candidate: each instance listed on this item is reproduced against the base and shown not to recur against the candidate, by a test the change adds', proofs: ['manual:fault-class-decision'] }];
  const tree = new Set([
    'tests/fault-class-decision.test.ts', 'tests/fault-class-decision-scope-slot.test.ts', baseline, noWallClockGatePath,
    'src/daemon/cycle-decisions.ts', 'src/daemon/metrics.ts', 'src/daemon/decisions.ts',
    'docs/master-agent-reference.md', 'docs/coordination.md',
  ]);
  const ask = ['tests/fault-class-decision-scope-slot.test.ts', 'docs/master-agent-reference.md', 'docs/coordination.md'];
  assert.deepEqual(gy1706Base.derivePlannedFiles({ plannedFiles: [], criteria }, tree).plannedFiles, [], 'base filing derives nothing');
  assert.equal(gy1706Base.decideScopeRequest({ plannedFiles: [], criteria, documentation: gy1706Docs }, { paths: ask }).state, 'refused');
  const derived = derivePlannedFiles({ plannedFiles: [], criteria }, tree);
  assert.ok(derived.plannedFiles.includes('tests/fault-class-decision.test.ts'));
  assert.ok(derived.plannedFiles.includes(baseline));
  assert.ok(derived.plannedFiles.includes(noWallClockGatePath));
  assert.equal(decideScopeRequest({ plannedFiles: derived.plannedFiles, criteria, documentation: gy1706Docs }, { paths: ask }).state, 'approved');
});

test(`manual:fault-class-scope — scope-request|GY-1705|${gy1705At}: the wall-clock gate rides beside a planned test so docs+gate asks approve`, () => {
  const planned = [
    'src/model/capacity.ts', 'src/daemon/cycle-sessions.ts', 'src/daemon/cycle-approvers.ts',
    'src/daemon/diagnosis.ts', 'src/daemon/doctor.ts', 'src/master/launch-account.ts',
    'tests/capacity-silent-exhaustion.test.ts', 'src/daemon/effects.ts', 'src/daemon/cycle-dispatch.ts',
  ];
  const criteria = [{ id: 'AC-1', text: 'A silent pane exhaustion is held and the role fails over.', proofs: ['unit:silent-pane-exhaustion-signal'] }];
  const ask = ['docs/master-agent.md', 'docs/master-agent-sessions.md', 'docs/onboarding.md', noWallClockGatePath];
  const tree = new Set([...planned, ...ask, baseline, 'tests/docs-budget.test.ts', 'tests/silent-pane-exhaustion-signal.test.ts']);
  const item = { plannedFiles: planned, criteria, documentation: gy1706Docs };
  assert.equal(gy1706Base.decideScopeRequest(item, { paths: ask }).state, 'refused', 'base refuses the mixed docs+gate ask');
  assert.ok(!gy1706Base.plannedCompanions({ plannedFiles: planned, criteria }, tree, [...gy1706Docs.paths]).some((entry: { path: string }) => entry.path === noWallClockGatePath));
  assert.ok(plannedCompanions({ plannedFiles: planned, criteria }, tree, [...gy1706Docs.paths]).some(entry => entry.path === noWallClockGatePath));
  assert.ok(derivePlannedFiles({ plannedFiles: planned, criteria }, tree).plannedFiles.includes(noWallClockGatePath));
  assert.equal(decideScopeRequest(item, { paths: ask }).state, 'approved');
  assert.ok(!derivePlannedFiles({ plannedFiles: planned, criteria }, tree).plannedFiles.includes('docs/'), 'documentation.paths stay widen-time implications');
});

const narrowerReason = 'Refused as filed; re-request narrower. The ask names files the criteria do not need.';
function approverRefused(reason: string) {
  const work = standing(instances[8]);
  work.scopeRequest!.decision = { ...work.scopeRequest!.decision!, decidedBy: 'graphyard-approver-graphyard', reason };
  work.scopeRequest!.paths = ['src/x.ts', 'src/y.ts']; // a narrower ask exists only when the ask names several paths
  return work;
}

test('unit:standing-re-requestable-settling — GY-1757: an approver refusal of an additive multi-path ask on a live lease inside the bound is not standing, whatever its wording', () => {
  const entry = instances[8];
  for (const wording of [narrowerReason, 'Please ask again for fewer files', 'Refused as filed; ask only for src/x.ts', 'Do not re-request narrower; this file is unrelated'])
    assert.deepEqual(scopeFaults(approverRefused(wording), entry.observedAt).map(fault => fault.kind), [], wording);
});

test('unit:standing-re-requestable-bound-stands — GY-1757: the same refusal stands once the bound passes, and not when the lease has ended', () => {
  const entry = instances[8];
  const late = new Date(Date.parse(entry.requestedAt) + 16 * minute).toISOString();
  const work = approverRefused(narrowerReason);
  work.lease = { ...work.lease!, expiresAt: new Date(Date.parse(late) + 10 * minute).toISOString() };
  assert.deepEqual(scopeFaults(work, late).map(fault => fault.kind), ['scope-request']);
  assert.deepEqual(workFaults(approverRefused(narrowerReason), Date.parse(entry.observedAt) + 20 * minute).filter(fault => fault.subject === entry.subject && fault.text.includes('plannedFiles')).length, 0, 'an expired lease is moot, as today');
});

test('unit:standing-dead-ends-stand — GY-1757: no approver route, a non-additive ask and a one-path ask still stand at once', () => {
  const entry = instances[8];
  const narrowing = approverRefused(narrowerReason);
  narrowing.scopeRequest!.remove = ['docs/'];
  assert.deepEqual(scopeFaults(narrowing, entry.observedAt).map(fault => fault.kind), ['scope-request'], 'a non-additive ask cannot be narrowed by re-asking');
  for (const wording of ['Do not re-request narrower; this file is unrelated', narrowerReason]) {
    const single = approverRefused(wording);
    single.scopeRequest!.paths = ['src/x.ts'];
    assert.deepEqual(scopeFaults(single, entry.observedAt).map(fault => fault.kind), ['scope-request'], `a one-path ask has nothing narrower to re-ask: ${wording}`);
  }
  const ruleRefused = standing(entry);
  ruleRefused.scopeRequest!.remove = ['docs/'];
  assert.deepEqual(scopeFaults(ruleRefused, entry.observedAt).map(fault => fault.kind), ['scope-request']);
  assert.equal(workFaults(standing(entry), Date.parse(entry.observedAt), false).filter(fault => fault.subject === entry.subject).length, 1, 'with no approver route');
});

// GY-1788 — three scope-class instances inside 24 hours on 14 October 2026, two of them not scope
// faults. action:scope|GY-1773 (05:03:05.438Z, again 06:13:50.068Z) were the loop's own
// widen-on-findings read failing in transport — a gh rate limit reading the pull request's reviews —
// filed because GY-1757's rule exempted only the FIRST transport refusal in a run: an outage that
// outlasted a cycle (or a re-ask's new action key) filed one counted instance per run and carried the
// class trip on its own. The third, scope-request|GY-1785 (06:33:44.634Z), is genuine: a one-path ask
// the widening rule refused on a live lease with nothing to route it, withdrawn by the worker six
// minutes later. Shared cause, removed at the candidate: a transport-failure refusal is stored for
// retry and never an instance, however many times in a row it fails — a persistently failing gh read
// surfaces once under its own bound (github-budget) — so the scope class counts only genuine faults
// and this window counts one, below the threshold of three.
const gy1788BaseSha = 'f807a88b05def86d0aacc495e9bb7978a19262b8'; // main's tip when GY-1788 was claimed: still files a run's second transport refusal
const gy1788Gh = () => new Error('Command failed: gh api --paginate --slurp repos/cryptob1/graphyard/pulls/1181/reviews?per_page=100\ngh: API rate limit exceeded for user ID 4241869. If you reach out to GitHub Support for help, please include the request ID 8C38:8DC0:53AEFC:596F90:6ACF0D09 and timestamp 2026-10-14 05:03:05 UTC.');
const gy1788WidenAt = '2026-10-14T05:03:05.438Z', gy1785AskedAt = '2026-10-14T06:32:05.988Z', gy1785RefusedAt = '2026-10-14T06:32:12.012Z', gy1785ObservedAt = '2026-10-14T06:33:44.634Z';
type Gy1788Base = { scopeRefusalFault: typeof scopeRefusalFault; transientScopeRefusal: typeof transientScopeRefusal };
let gy1788Base: Gy1788Base;
before(async () => {
  try { execFileSync('git', ['cat-file', '-e', `${gy1788BaseSha}^{commit}`], { cwd: process.cwd(), stdio: 'ignore' }); }
  catch { execFileSync('git', ['fetch', '--no-tags', '--depth=1', '--quiet', 'origin', gy1788BaseSha], { cwd: process.cwd() }); }
  const directory = await temporaryDirectory('gy1788-base');
  execFileSync('tar', ['-x', '-C', directory], { input: execFileSync('git', ['archive', '--format=tar', gy1788BaseSha, 'src'], { cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 }), maxBuffer: 256 * 1024 * 1024 });
  await fs.symlink(gy1706NodeModules, join(directory, 'node_modules'), 'dir');
  gy1788Base = await import(join(directory, 'src/daemon/cycle-scope.ts'));
});

test('manual:fault-class-scope — action:scope|GY-1773|2026-10-14T05:03:05.438Z and |2026-10-14T06:13:50.068Z: a transport refusal is stored for retry, never a scope instance, however many in a row', () => {
  const gh = gy1788Gh();
  assert.equal(gy1788Base.transientScopeRefusal(gh), 'the call failed in transport: a timeout, a network error or a gh rate limit', 'the base already read the outage as transport (GY-1757)');
  const transient = transientScopeRefusal(gh);
  assert.equal(transient, 'the call failed in transport: a timeout, a network error or a gh rate limit');
  // The run's first failure, as the action row stood when each instance was filed: failed, retrying on a fresh read.
  const previous = { state: 'failed', detail: `Could not widen GY-1773 on a review finding or a planned file's successor (${transient}, so it is retried next cycle on a fresh read): ${gh.message}` };
  // Against the base each instance reproduces: the run's second transport failure filed the counted action:scope.
  assert.equal(gy1788Base.scopeRefusalFault(transient, previous), undefined, 'the base files the second transport failure in a run as action:scope');
  // The candidate stores it for retry: the read judged nothing about GY-1773's scope, and a persistently
  // failing gh read surfaces under its own bound (github-budget), so the scope class counts only genuine faults.
  assert.equal(scopeRefusalFault(transient, undefined), null);
  assert.equal(scopeRefusalFault(transient, previous), null);
  // What the loop still counts as before: a judged refusal, whatever it refused…
  assert.equal(scopeRefusalFault(null, undefined), undefined);
  // …and any other transient: the first in a run is quiet, the second in a row is the fault (GY-1293).
  assert.equal(scopeRefusalFault('the control plane answered 5xx', undefined), null);
  assert.equal(scopeRefusalFault('the control plane answered 5xx', previous), undefined);
});

test(`manual:fault-class-scope — action:scope|GY-1773|${gy1788WidenAt} replayed through the loop: the outage's cycles store the widen for retry and open no scope instance`, async () => {
  // GY-1892: the rule now grants GY-1773's soak suites itself, so the outage is replayed on an ask only a finding grounds.
  const work = standing({ id: 'GY-1773', subject: 'GY-1773', observedAt: gy1788WidenAt, epoch: 2, requestedAt: '2026-10-14T04:59:06.260Z', refusedAt: '2026-10-14T04:59:28.010Z',
    paths: ['src/cli/master-status.ts'], plannedFiles: ['src/daemon/upgrade.ts', 'src/daemon/state.ts', baseline],
    settled: 'the ask was widened once the read answered' });
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [work], now: gy1788WidenAt }), closeSession: () => {}, dispatch: async () => {},
    requestProof: () => {}, observeDeployment: async () => ({ source: 'unavailable', sha: null, at: gy1788WidenAt, reason: 'replay', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    // The production loop that filed the instances had its approver route: the refused ask is the
    // route's to settle, so only the widening's own outcome is under test here.
    decide: async () => ({ id: 'decision-replay' }), approver: async () => ({ agentName: 'graphyard-approver-replay', pane: 'pane-replay' }),
    reviewFindings: async () => { throw gy1788Gh(); },
    basePaths: async (paths: string[]) => new Set(paths),
    widenScope: async () => { throw new Error('the findings read fails before any widening is posted'); },
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config());
  await runCycle(config(), state, effects, () => Date.parse(gy1788WidenAt));
  await runCycle(config(), state, effects, () => Date.parse(gy1788WidenAt) + minute);
  const widen = Object.values(state.actions).filter(action => action.kind === 'scope' && action.work === 'GY-1773');
  assert.equal(widen.length, 1, 'one action row, retried in place');
  assert.equal(widen[0]?.state, 'failed');
  assert.equal(widen[0]?.attempts, 2, 'the second cycle retried the read');
  assert.match(widen[0]?.detail ?? '', /so it is retried next cycle on a fresh read/);
  assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'scope'), [], 'the outage files no scope instance on the candidate');
});

test('manual:fault-class-scope — a widening the control plane refuses as judged still counts, so the class keeps its teeth for genuine faults', async () => {
  // Synthetic (not a listed instance): the same widen, refused as judged rather than failing in transport.
  const at = '2026-10-14T07:30:12.012Z';
  const work = standing({ id: 'GY-1773', subject: 'GY-1773', observedAt: at, epoch: 2, requestedAt: '2026-10-14T07:30:05.988Z', refusedAt: at,
    paths: ['src/daemon/cycle-dispatch.ts'], plannedFiles: ['src/daemon/cycle-scope.ts'], settled: 'refused as judged' });
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [work], now: at }), closeSession: () => {}, dispatch: async () => {},
    requestProof: () => {}, observeDeployment: async () => ({ source: 'unavailable', sha: null, at, reason: 'replay', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    decide: async () => ({ id: 'decision-replay' }), approver: async () => ({ agentName: 'graphyard-approver-replay', pane: 'pane-replay' }),
    reviewFindings: async () => [{ ground: 'review thread PRRT_replay', text: 'src/daemon/cycle-dispatch.ts:40 still dispatches the stale item' }],
    basePaths: async (paths: string[]) => new Set(paths),
    widenScope: async () => { throw new RefusedResponse('Graphyard refused work/GY-1773/requirements (403): the file is unrelated to every criterion', 403, { error: 'the file is unrelated to every criterion' }); },
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config());
  await runCycle(config(), state, effects, () => Date.parse(at));
  const instances = state.faults.instances.filter(instance => instance.kind === 'action:scope');
  assert.equal(instances.length, 1, 'a judged refusal is the action\'s own kind, action:scope, as before');
  assert.equal(instances[0]?.faultClass, 'scope');
});

test(`manual:fault-class-scope — scope-request|GY-1785|${gy1785ObservedAt}: the genuine refusal still stands where nothing routes it, and the window it tripped counts one against the candidate`, () => {
  const work = standing({ id: 'GY-1785', subject: 'GY-1785', observedAt: gy1785ObservedAt, epoch: 2, requestedAt: gy1785AskedAt, refusedAt: gy1785RefusedAt,
    paths: ['tests/locked-read.test.ts'], plannedFiles: ['README.md', 'tests/readme-preview-step.test.ts', baseline],
    settled: 'withdrawn by the worker at 06:39:19 once its own tests carried the point' });
  // The instance is genuine: the one-path refusal stood at once where no approver route judged it (GY-1757's dead end).
  assert.deepEqual(workFaults(work, Date.parse(gy1785ObservedAt), false).map(fault => fault.kind), ['scope-request']);
  // Where the route is there the product settles it: the routable ask is no fault (GY-1085's rule, unchanged).
  assert.deepEqual(workFaults(work, Date.parse(gy1785ObservedAt)).map(fault => fault.kind), []);
  // The candidate does not weaken the class: this genuine instance counts. What the window loses are the
  // two transport filings the replays above show quiet, so the count is one, below the threshold of three:
  // the loop files no class item off this window, and later genuine instances still link to one.
  const record: FaultRecord = { instances: [], open: {}, failing: {} };
  trackFaults(record, workFaults(work, Date.parse(gy1785ObservedAt), false), gy1785ObservedAt);
  const scopeCount = record.instances.filter(instance => instance.faultClass === 'scope').length;
  assert.equal(scopeCount, 1);
  assert.ok(scopeCount < faultClassPolicyDefaults.threshold, `the window's genuine count (${scopeCount}) no longer reaches the threshold (${faultClassPolicyDefaults.threshold})`);
});

// GY-1893 — three scope-class instances inside 24 hours on 17 October 2026, the first since the
// 14 October window. Shared causes, each product-side and each removed at the candidate:
//
//   - action:scope|GY-1384 (07:48:54.813Z) was the succession reader's base fetch losing a ref-lock
//     race to a concurrent fetch — git answered "cannot lock ref 'refs/remotes/origin/main': is at
//     7294e773… but expected 28e56336…" — so the re-plan step failed without judging anything about
//     GY-1384's scope, and because a git failure read as no transport failure the race counted as an
//     action:scope fault. The candidate retries the fetch in place (review-scope.ts fetchBase), so
//     the step sees the read land and files no instance; a race no retry survives still counts.
//   - scope-request|GY-1881 (09:29:12.213Z) stood refused on an ask the rule under-covers: an
//     existing test file that the failed required check on the item's own candidate named, a live
//     wall-clock bomb on the base the item could answer in one line outside its plannedFiles. The
//     candidate grounds exactly that ask (companionGround's failed-check ground): the item's own
//     record holds the red required check, and the ask's reason names the check and the file.
//   - scope-request|GY-1888 (09:37:00.242Z) stood refused the same way: a fault-class item's fix
//     lives in its own class's machinery, which the filing plans nothing of (GY-1706 plans the
//     proof test and its gates only). The candidate carries a machinery table beside the fault
//     catalogue (scope-companions.ts faultClassMachinery), granted through impliedScopes and
//     planned at filing, so the item the loop files never asks.
//
// Each instance is replayed from the item's own record at the stamps the loop recorded it, with
// GY-1384's error quoted verbatim. The base (main's tip when GY-1893 was claimed) still refuses
// both asks and counts the race; the candidate settles each inside its bound.
const gy1893BaseSha = '1fa5a2b96437c21db207ea86fd690a76f272fe2d';
type Gy1893Base = {
  review: { successionReader: typeof successionReader };
  scope: { decideScopeRequest: typeof decideScopeRequest };
  cycle: { transientScopeRefusal: typeof transientScopeRefusal };
};
let gy1893Base: Gy1893Base;
before(async () => {
  try { execFileSync('git', ['cat-file', '-e', `${gy1893BaseSha}^{commit}`], { cwd: process.cwd(), stdio: 'ignore' }); }
  catch { execFileSync('git', ['fetch', '--no-tags', '--depth=1', '--quiet', 'origin', gy1893BaseSha], { cwd: process.cwd() }); }
  const directory = await temporaryDirectory('gy1893-base');
  execFileSync('tar', ['-x', '-C', directory], { input: execFileSync('git', ['archive', '--format=tar', gy1893BaseSha, 'src'], { cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 }), maxBuffer: 256 * 1024 * 1024 });
  await fs.symlink(gy1706NodeModules, join(directory, 'node_modules'), 'dir');
  const [review, scope, cycle] = await Promise.all([
    import(join(directory, 'src/review-scope.ts')),
    import(join(directory, 'src/model/scope.ts')),
    import(join(directory, 'src/daemon/cycle-scope.ts')),
  ]);
  gy1893Base = { review, scope, cycle } as unknown as Gy1893Base;
});

// The instance's own record, quoted verbatim from GY-1893's filing; the ref the race left behind is
// the tip the fake git answers with, so the retry reads what the other fetch left.
const gy1384At = '2026-10-17T07:48:54.813Z';
const gy1893FetchError = () => new ChildProcessError('git', ['-C', '/home/vish/code/graphyard', 'fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
  { stdout: '', status: 128, signal: null, timedOut: false, stderr: `error: cannot lock ref 'refs/remotes/origin/main': is at 7294e773c81937da46dda6189dc3a5f0fda3914f but expected 28e56336dcc07b1b176c46da8cf14e30480c30e8` });
const gy1893Tip = '7294e773c81937da46dda6189dc3a5f0fda3914f';
/** The loop's git, as the race left it: the first `fetchFailures` fetches answer with the lock error, the rest read the base. */
const gy1893Git = (fetchFailures: number) => {
  let fetches = 0;
  const run = async (_command: string, args: string[]): Promise<string> => {
    const sub = args[0] === '-C' ? args[2] : args[0];
    if (sub === 'fetch') return fetches++ < fetchFailures ? Promise.reject(gy1893FetchError()) : '';
    if (sub === 'rev-parse' || sub === 'rev-list') return `${gy1893Tip}\n`;
    if (sub === 'log' || sub === 'ls-tree') return '';
    throw new Error(`the fake git does not answer ${args.join(' ')}`);
  };
  return { run, count: () => fetches };
};

test(`manual:fault-class-scope — action:scope|GY-1384|${gy1384At}: the succession reader answers a lost ref-lock race by retrying it, so the re-plan's fetch no longer fails`, async () => {
  const error = gy1893FetchError();
  assert.ok(refLockContention.test(error.message), `the instance's error is the race this change names`);
  // Against the base the instance reproduces: the reader loses the race on the first try and throws,
  // and the re-plan step counts such a failure as an action:scope fault (it judged nothing, but a
  // git failure read as no transport failure, and the step's teeth are kept that way).
  const baseReader = gy1893Base.review.successionReader(root, 'main', gy1893Git(1).run, () => 0);
  await assert.rejects(baseReader(gy1384At), /cannot lock ref/);
  assert.equal(gy1893Base.cycle.transientScopeRefusal(error), null);
  // The candidate retries the contended fetch in place: the read the loop asked for lands, the
  // fetches counted are the race and its retry, and no failure reaches the step at all.
  const contended = gy1893Git(1), read = await successionReader(root, 'main', contended.run, () => 0)(gy1384At);
  assert.equal(contended.count(), 2, 'the contended fetch was retried once, in place');
  assert.deepEqual(read.successions, []);
  // A race that loses every retry is still thrown, and still counts — the class keeps its teeth for
  // a base fetch that fails without judging anything, however it fails.
  await assert.rejects(successionReader(root, 'main', gy1893Git(baseFetchAttempts).run, () => 0)(gy1384At), /cannot lock ref/, 'a race every attempt loses is thrown for the step to count');
  assert.equal(transientScopeRefusal(gy1893FetchError()), null);
  assert.equal(scopeRefusalFault(null, undefined), undefined);
});

test(`manual:fault-class-scope — action:scope|GY-1384|${gy1384At} replayed through the loop: the reader's retry answers the race, and the step's teeth hold for one no retry survives`, async () => {
  const work = standing({ id: 'GY-1384', subject: 'GY-1384', observedAt: gy1384At, epoch: 2, requestedAt: gy1384At,
    paths: [], plannedFiles: ['src/daemon/decisions.ts'], settled: 'the reader retried the race and the read landed' });
  work.scopeRequest = null; work.blocker = null;
  const effects = (fetchFailures: number) => ({
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [work], now: gy1384At }), closeSession: () => {}, dispatch: async () => {},
    requestProof: () => {}, observeDeployment: async () => ({ source: 'unavailable', sha: null, at: gy1384At, reason: 'replay', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    basePaths: async (paths: string[]) => new Set(paths),
    // The production effect is the reader itself: a base fetch that loses the race once is retried
    // inside it, so the step sees the read land, exactly as the instance's single race now resolves.
    baseSuccessions: () => successionReader(root, 'main', gy1893Git(fetchFailures).run, () => Date.parse(gy1384At))(gy1384At),
    replan: async () => { throw new Error('the succession read fails before any re-plan is posted'); },
  }) as unknown as DaemonEffects;
  const answered = emptyDaemonState(config());
  await runCycle(config(), answered, effects(1), () => Date.parse(gy1384At));
  assert.deepEqual(Object.values(answered.actions).filter(action => action.kind === 'scope'), [], 'the race never reaches the re-plan step as a failure');
  assert.deepEqual(answered.faults.instances.filter(instance => instance.faultClass === 'scope'), [], `the instance's single race files no scope instance on the candidate`);
  // The same step, its reader having lost every retry: the failure stands recorded and counts, so a
  // base fetch that never answers is never silent (GY-1293's teeth, unchanged by the retry).
  const contended = emptyDaemonState(config());
  await runCycle(config(), contended, effects(baseFetchAttempts), () => Date.parse(gy1384At));
  const replan = Object.entries(contended.actions).filter(([key]) => key.startsWith('successors:')).map(([, row]) => row);
  assert.equal(replan.length, 1, 'the re-plan action stands, failed');
  assert.equal(replan[0]?.state, 'failed');
  assert.match(replan[0]?.detail ?? '', /Could not re-plan GY-1384 onto the successors of its planned files: [\s\S]*cannot lock ref/);
  assert.deepEqual(contended.faults.instances.filter(instance => instance.faultClass === 'scope').map(instance => instance.kind), ['action:scope'], 'and it counts, as any read that reaches the step failing does');
});

// The two scope-request instances, replayed from the ledger with each ask's own reason and refusal.
const gy1881At = '2026-10-17T09:29:12.213Z', gy1881AskedAt = '2026-10-17T09:14:01.170Z', gy1881RefusedAt = '2026-10-17T09:14:10.069Z';
const gy1881Reason = `CI point: the required test check failed on candidate 552d4fbeedff — test shard 6 fails at tests/pi-provider-limit-exhaustion.test.ts:199 ('the spent account is held until the UTC reset': actual undefined, expected 2026-10-17T08:27:35.000Z), again on rerun, and identically on base c30a233fdea2 with no diff applied. Root cause: the assertion calls observedExhaustions(config) without the file's fixed clock, so the hold's until (the provider reset 2026-10-17T08:27:35Z) is filtered against the real wall clock, and once real time passed 08:27:35Z today the hold expires and the assertion reads undefined — a live wall-clock time bomb independent of this PR's diff (the PR touches only the host executor installer). The one-line answer is observedExhaustions(config, now()) in that file, which lies outside plannedFiles, so the CI point cannot be answered inside the planned scope.`;
const gy1888At = '2026-10-17T09:37:00.242Z', gy1888AskedAt = '2026-10-17T09:21:58.272Z', gy1888RefusedAt = '2026-10-17T09:22:07.128Z';
const gy1888Ask = ['src/daemon/decision-text.ts', 'src/daemon/cycle-decisions.ts', 'src/daemon/cycle-approvers.ts'];
const gy1888Reason = `AC-1 removes the decision faults' shared cause in the loop's decision machinery: the put path must adopt an applied rework the item already holds instead of re-putting a request the control plane refuses every retry (the GY-1846 instance), and the approver launch path must recover a session name a leftover pane holds instead of repeating the refused launch (the GY-1884 instance, which also kept GY-1834's new-head decision standing past its bound). All three are src/daemon modules: decision-text.ts holds the refusal matchers beside standingNamedIn, cycle-decisions.ts is step 4c's request path, cycle-approvers.ts is the approver launch path.`;
const gy1888Origin: WorkOrigin = { faultClass: { class: 'decision', threshold: 3, windowHours: 24, count: 3, detectedAt: '2026-10-17T08:25:44.598Z', instances: [
  { id: 'owed-decision|GY-1834|2026-10-16T22:35:33.279Z', kind: 'owed-decision', subject: 'GY-1834', at: '2026-10-16T22:35:33.279Z' },
  { id: 'action:decision|GY-1846|2026-10-17T02:57:31.390Z', kind: 'action:decision', subject: 'GY-1846', at: '2026-10-17T02:57:31.390Z' },
  { id: 'action:decision|GY-1884|2026-10-17T08:25:26.339Z', kind: 'action:decision', subject: 'GY-1884', at: '2026-10-17T08:25:26.339Z' } ] } };
const gy1881Fixture = {
  id: `scope-request|GY-1881|${gy1881At}`, subject: 'GY-1881', observedAt: gy1881At, epoch: 2, requestedAt: gy1881AskedAt, refusedAt: gy1881RefusedAt,
  paths: ['tests/pi-provider-limit-exhaustion.test.ts'],
  plannedFiles: ['src/up.ts', 'src/repository-setup.ts', 'tests/up-host-executor-repair.test.ts', baseline, noWallClockGatePath],
  reason: gy1881Reason, settled: `the rule granted the failed check's own test file, with no approver`,
  criteria: [{ id: 'AC-1', text: 'In tests/up-host-executor-repair.test.ts, with a host layout whose executor unit template starts another Graphyard checkout, `up` runs the real installExecutorSupervision path (not a stubbed --install). A unit whose launcher is not a Graphyard executor at all is still refused with ForeignUnitRefusal. The repair lives in src/up.ts and src/repository-setup.ts', proofs: ['unit:up-host-executor-repair-real-installer'] }],
};
const gy1888Fixture = {
  id: `scope-request|GY-1888|${gy1888At}`, subject: 'GY-1888', observedAt: gy1888At, epoch: 2, requestedAt: gy1888AskedAt, refusedAt: gy1888RefusedAt,
  paths: gy1888Ask, plannedFiles: ['tests/fault-class-decision.test.ts', baseline, noWallClockGatePath],
  reason: gy1888Reason, settled: `the rule granted the decision class's own machinery, with no approver`,
  criteria: [{ id: 'AC-1', text: 'The shared cause of the recurring decision faults is found and removed at the candidate: each instance listed on this item is reproduced against the base and shown not to recur against the candidate, by a test the change adds', proofs: ['manual:fault-class-decision'] }],
  origin: gy1888Origin,
};
/** The instance's item as the loop held it: GY-1881 carries the failed required check run its candidate holds, its gate the refusal for it. */
const standing1893 = (entry: typeof gy1881Fixture | typeof gy1888Fixture) => {
  const work = standing(entry);
  if (entry === gy1881Fixture) {
    work.candidate = { sha: '552d4fbeedff', baseSha: 'c30a233fdea2', pr: 1247, branch: 'graphyard/gy-1881-1', author: 'graphyard-cursor-2' };
    work.observation = { checks: [{ name: 'test', result: 'failure', appId: 15368, id: 100 }], candidate: work.candidate } as Work['observation'];
    work.gates = [{ name: 'test', passed: false, reasons: [ciCheckRefusal('test')], ciAppIds: [15368] }];
  }
  return work;
};
/** The item as the applied widening leaves it: the ask answered, nothing standing to count. */
const settled1893 = (work: Work) => ({ ...work, scopeRequest: null, blocker: null, plannedFiles: [...(work.plannedFiles ?? []), ...(work.scopeRequest?.paths ?? [])] }) as Work;

test(`manual:fault-class-scope — scope-request|GY-1881|${gy1881At}: the failed required check's own test file is the item's to answer, with no approver`, () => {
  const work = standing1893(gy1881Fixture);
  // Against the base the ask reproduces: the rule refuses it and the standing refusal is the fault.
  assert.equal(gy1893Base.scope.decideScopeRequest(work, work.scopeRequest!).state, 'refused', 'the base refuses the ask');
  assert.deepEqual(scopeFaults(standing1893(gy1881Fixture), gy1881At).map(fault => fault.kind), ['scope-request']);
  // The candidate grounds it from the item's own record: a check run that failed on the current
  // candidate, its gate holding the refusal, and an ask naming that check and the failed file.
  const verdict = decideScopeRequest(work, work.scopeRequest!);
  assert.equal(verdict.state, 'approved', verdict.reason);
  assert.match(verdict.reason, /tests\/pi-provider-limit-exhaustion\.test\.ts is the test file the failed required check test on this item's current candidate names/);
  assert.deepEqual(scopeFaults(settled1893(work), gy1881At).map(fault => fault.kind), [], 'the granted ask never stands to become the fault');
  // What the rule still refuses: an item that has not run the check (the same refusal a fresh item
  // carries), a run read on another candidate, a same-head other-base observation, a superseded or
  // untrusted failure beside a trusted pending run, a run the gate does not hold, an ask that names
  // no file, a check the story does not name, a different check than the one held failed, a file
  // the failure site does not quote, and a path that is no test file.
  const unrun = standing1893(gy1881Fixture);
  unrun.candidate = null; unrun.observation = null;
  assert.equal(decideScopeRequest(unrun, unrun.scopeRequest!).state, 'refused', 'a red gate without a failing run is the no-candidate refusal, not a ground');
  const stale = standing1893(gy1881Fixture);
  stale.observation = { checks: [{ name: 'test', result: 'failure', appId: 15368, id: 100 }], candidate: { ...stale.candidate!, sha: 'older-sha' } } as Work['observation'];
  assert.equal(decideScopeRequest(stale, stale.scopeRequest!).state, 'refused', 'the ground is the run on the current candidate, not one an older observation read');
  // Same head SHA, different candidate base: the test gate's freshness check refuses it.
  const otherBase = standing1893(gy1881Fixture);
  otherBase.observation = { checks: [{ name: 'test', result: 'failure', appId: 15368, id: 100 }], candidate: { ...otherBase.candidate!, baseSha: 'other-base' } } as Work['observation'];
  assert.equal(decideScopeRequest(otherBase, otherBase.scopeRequest!).state, 'refused', 'a same-head other-base observation grants nothing');
  // An older trusted failure retained beside a newer trusted pending run: the gate stays red on the
  // pending run, but the counting run has not failed, so the ground must refuse.
  const superseded = standing1893(gy1881Fixture);
  superseded.observation = { checks: [
    { name: 'test', result: 'failure', appId: 15368, id: 100 },
    { name: 'test', result: 'pending', appId: 15368, id: 200 },
  ], candidate: superseded.candidate } as Work['observation'];
  assert.equal(decideScopeRequest(superseded, superseded.scopeRequest!).state, 'refused', 'a superseded failure beside a trusted pending run grants nothing');
  // An untrusted app's failure beside a trusted pending run: only the trusted run counts.
  const untrusted = standing1893(gy1881Fixture);
  untrusted.observation = { checks: [
    { name: 'test', result: 'failure', appId: 99999, id: 100 },
    { name: 'test', result: 'pending', appId: 15368, id: 200 },
  ], candidate: untrusted.candidate } as Work['observation'];
  assert.equal(decideScopeRequest(untrusted, untrusted.scopeRequest!).state, 'refused', 'an untrusted failure beside a trusted pending run grants nothing');
  const unheld = standing1893(gy1881Fixture);
  unheld.observation = { checks: [{ name: 'typecheck', result: 'failure', appId: 15368, id: 100 }], candidate: unheld.candidate } as Work['observation'];
  assert.equal(decideScopeRequest(unheld, unheld.scopeRequest!).state, 'refused', 'the ground is the run the gate holds, not any failing run');
  const unnamed = standing1893(gy1881Fixture);
  unnamed.scopeRequest = { ...unnamed.scopeRequest!, reason: 'The change reads better with this file refactored.' };
  assert.equal(decideScopeRequest(unnamed, unnamed.scopeRequest).state, 'refused');
  // The file and its failure site are in the reason, but the prose never names the held check — a
  // red `test` alone must not grant an arbitrary test file just because its path appears.
  const unnamedCheck = standing1893(gy1881Fixture);
  unnamedCheck.scopeRequest = { ...unnamedCheck.scopeRequest!, reason: `The assertion at tests/pi-provider-limit-exhaustion.test.ts:199 is flaky against the wall clock; stub Date there.` };
  assert.equal(decideScopeRequest(unnamedCheck, unnamedCheck.scopeRequest).state, 'refused', 'a check the story does not name grants nothing');
  // The reason names a different check than the one the gate holds failed.
  const otherCheck = standing1893(gy1881Fixture);
  otherCheck.scopeRequest = { ...otherCheck.scopeRequest!, reason: `CI point: the required typecheck check failed on candidate 552d4fbeedff — typecheck fails at tests/pi-provider-limit-exhaustion.test.ts:199. The one-line answer is a stub in that file.` };
  assert.equal(decideScopeRequest(otherCheck, otherCheck.scopeRequest).state, 'refused', 'a check the record does not hold as failed grants nothing');
  // The reason names the held check and the file, but never quotes a PATH:LINE failure site.
  const noSite = standing1893(gy1881Fixture);
  noSite.scopeRequest = { ...noSite.scopeRequest!, reason: `CI point: the required test check failed on candidate 552d4fbeedff. Root cause lives in tests/pi-provider-limit-exhaustion.test.ts; stub the clock there.` };
  assert.equal(decideScopeRequest(noSite, noSite.scopeRequest).state, 'refused', 'a file the failure site does not quote grants nothing');
  const source = standing1893(gy1881Fixture);
  source.scopeRequest = { ...source.scopeRequest!, paths: ['src/up.ts'] };
  assert.equal(decideScopeRequest(source, source.scopeRequest).state, 'refused', 'only a test file is granted: the item answers the check, it does not take new source scope');
  // A protection-bound, path-like check (`ci/unit`) the gate holds as failed: its name survives the
  // path masking, its bound app's run counts, and another app's failure for it grants nothing.
  const bound = standing1893(gy1881Fixture);
  bound.observation = { checks: [{ name: 'ci/unit', result: 'failure', appId: 777, id: 100 }], requiredChecks: [{ name: 'ci/unit', appId: 777 }], candidate: bound.candidate } as Work['observation'];
  bound.gates = [{ name: 'test', passed: false, reasons: [requiredCheckFailure('ci/unit')], ciAppIds: [15368] }];
  bound.scopeRequest = { ...bound.scopeRequest!, reason: `The required ci/unit check failed at tests/pi-provider-limit-exhaustion.test.ts:199; stub the clock there.` };
  const boundVerdict = decideScopeRequest(bound, bound.scopeRequest);
  assert.equal(boundVerdict.state, 'approved', boundVerdict.reason);
  const boundOtherApp = standing1893(gy1881Fixture);
  Object.assign(boundOtherApp, { gates: bound.gates, scopeRequest: bound.scopeRequest, observation: { ...bound.observation, checks: [{ name: 'ci/unit', result: 'failure', appId: 15368, id: 100 }] } });
  assert.equal(decideScopeRequest(boundOtherApp, boundOtherApp.scopeRequest!).state, 'refused', 'a protection-bound check counts only its bound app\'s run');
});

test(`manual:fault-class-scope — scope-request|GY-1888|${gy1888At}: a fault-class item's own machinery is implied scope, granted and planned at filing`, () => {
  const work = standing1893(gy1888Fixture);
  // Against the base the ask reproduces: the rule refuses it and the standing refusal is the fault.
  assert.equal(gy1893Base.scope.decideScopeRequest(work, work.scopeRequest!).state, 'refused', 'the base refuses the ask');
  assert.deepEqual(scopeFaults(standing1893(gy1888Fixture), gy1888At).map(fault => fault.kind), ['scope-request']);
  // The candidate implies the machinery of the item's own class, so the ask is granted…
  const verdict = decideScopeRequest(work, work.scopeRequest!);
  assert.equal(verdict.state, 'approved', verdict.reason);
  assert.match(verdict.reason, /is the decision fault class's machinery, where the shared cause AC-1 removes lives/);
  assert.deepEqual(scopeFaults(settled1893(work), gy1888At).map(fault => fault.kind), [], 'the granted ask never stands to become the fault');
  // …and the filing plans it up front, so the item the loop files never asks (GY-1085's shape).
  const tree = new Set(['tests/fault-class-decision.test.ts', baseline, noWallClockGatePath, ...gy1888Ask]);
  const derived = derivePlannedFiles({ plannedFiles: [], criteria: gy1888Fixture.criteria, origin: gy1888Origin, description: '' }, tree);
  for (const path of [...gy1888Ask, 'tests/fault-class-decision.test.ts', baseline, noWallClockGatePath])
    assert.ok(derived.plannedFiles.includes(path), `the filing plans ${path}`);
  // The grant stays bounded: a non-fault-class item, another class's machinery, and a module outside
  // the class's machinery are refused exactly as before.
  const untabled = standing({ id: 'GY-9998', subject: 'GY-9998', observedAt: gy1888At, epoch: 1, requestedAt: gy1888AskedAt, paths: gy1888Ask, plannedFiles: gy1888Fixture.plannedFiles, settled: 'untabled class' });
  assert.equal(decideScopeRequest(untabled, untabled.scopeRequest!).state, 'refused', 'a non-fault-class item implies no machinery');
  const other = standing({ ...gy1888Fixture, id: 'GY-9997', subject: 'GY-9997', origin: { faultClass: { ...gy1888Origin.faultClass!, class: 'scope' } } });
  assert.equal(decideScopeRequest(other, other.scopeRequest!).state, 'refused', 'a scope-class item implies the scope machinery, not the decision machinery');
  const outside = standing({ ...gy1888Fixture, id: 'GY-9996', subject: 'GY-9996' });
  outside.scopeRequest = { ...outside.scopeRequest!, paths: ['src/daemon/metrics.ts'] };
  assert.equal(decideScopeRequest(outside, outside.scopeRequest).state, 'refused', `a module outside the class's machinery is refused, so the table is the bound`);
});

test('manual:fault-class-scope — the fault-class machinery table names files the tree holds, and no class outside it grants anything', async () => {
  for (const [faultClass, files] of Object.entries(faultClassMachinery)) {
    assert.ok(files, `${faultClass} lists its machinery`);
    assert.ok(files.length >= 1, `${faultClass} lists its machinery`);
    for (const file of files) assert.ok(await readFile(file), `${faultClass} machinery ${file} exists in the tree`);
  }
  assert.deepEqual(machineryOf(undefined), [], 'no origin implies no machinery');
  assert.deepEqual(machineryOf({ faultClass: { class: 'loop', threshold: 3, windowHours: 24, count: 3, detectedAt: '2026-10-17T08:25:44.598Z', instances: [] } }), [], 'a class the table does not cover grants nothing');
  assert.deepEqual(machineryOf({ faultClass: { ...gy1888Origin.faultClass! } }), gy1888Ask, `the decision class's machinery is GY-1888's ask, in the table's own order`);
});
