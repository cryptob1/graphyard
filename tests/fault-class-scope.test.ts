import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Work } from '../src/model.js';
import type { WorkOrigin } from '../src/model/interventions.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { scopeRequestAttention } from '../src/cli/owed-report.js';
import { decideScopeRequest, followUpPaths, impliedScopes, namedPaths, plannedCompanions, scopeRefusalBlocker, type ScopeRequestState } from '../src/model/scope.js';
import { peerModuleGround, importingTestGround } from '../src/model/scope-companions.js';
import { automaticScopeGrounds } from '../src/daemon/cycle-scope.js';
import { derivePlannedFiles } from '../src/model/work.js';

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
// reproduces.

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
    paths: ['tests/soak.test.ts', 'tests/helpers/soak-world.ts', '.github/workflows/ci.yml'],
    plannedFiles: ['src/daemon/decisions.ts', 'src/merge-queue.ts', 'src/model/queue.ts', 'tests/speculative-failure-attribution.test.ts', 'src/github.ts', 'tests/helpers/timing-report.ts', 'docs/github.md', 'docs/glossary.md'],
    settled: 'rule refused 13:30:45, approver approved 13:33:18' },
  { id: 'scope-request|GY-521|2026-10-01T13:51:55.105Z', subject: 'GY-521', observedAt: '2026-10-01T13:51:55.105Z', epoch: 112, requestedAt: '2026-10-01T13:50:44.212Z', paths: [baseline],
    plannedFiles: ['src/model/next-action.ts', 'src/daemon/cycle-decisions.ts', 'docs/master-agent.md', 'tests/unproduced-manual-attestation.test.ts', 'src/model/unproduced-attestation.ts', 'tests/soak.test.ts'],
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
    plannedFiles: ['src/master/launch.ts', 'src/master/autonomy.ts', 'src/master/dispatch.ts', 'tests/runtime-screens.test.ts', 'tests/fixtures/', 'docs/master-agent-sessions.md', 'tests/soak.test.ts', baseline],
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
    ...(entry.refusedAt ? { decision: { state: 'refused' as const, reason, at: entry.refusedAt, decidedBy: 'graphyard', waitedMs: Date.parse(entry.refusedAt) - Date.parse(entry.requestedAt), paths: entry.paths, requestedBy: owner, requestedAt: entry.requestedAt, epoch: entry.epoch } } : {}) };
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
  // A refusal nothing will judge again — the independent approver's own — is a fault at once.
  const refused = standing(instances[8]);
  refused.scopeRequest!.decision = { ...refused.scopeRequest!.decision!, decidedBy: 'graphyard-approver-graphyard' };
  assert.deepEqual(scopeFaults(refused, instances[8].observedAt).map(fault => fault.kind), ['scope-request']);
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
