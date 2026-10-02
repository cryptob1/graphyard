import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { scopeRequestAttention } from '../src/cli/owed-report.js';
import { decideScopeRequest, plannedCompanions, scopeRefusalBlocker, type ScopeRequestState } from '../src/model/scope.js';

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
// Each instance is replayed from the ledger (`graphyard events GY-N --kind scope,autoscope`) as the
// item stood at the instant the loop recorded it. Against the base each subtest fails: the instance
// reproduces.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const baseline = 'tests/helpers/timing-baseline.json';
const minute = 60_000;

interface Instance {
  id: string; subject: string; observedAt: string; epoch: number; requestedAt: string; paths: string[]; plannedFiles: string[];
  /** When the rule had refused the ask before the loop observed it: the instant of that refusal. */
  refusedAt?: string;
  /** How the product settled it afterwards, from the ledger. */
  settled: string;
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
];

/** The item as it stood when the loop observed it: the live attempt, its open request, and the rule's refusal when one had landed. */
function standing(entry: Instance, observedAt = entry.observedAt): Work {
  const owner = `worker-${entry.subject}`;
  const reason = 'outside what this item\'s own criteria and the repository\'s documentation rule imply';
  const request: ScopeRequestState = { epoch: entry.epoch, paths: entry.paths, reason: 'the change needs these files', requestedBy: owner, at: entry.requestedAt,
    ...(entry.refusedAt ? { decision: { state: 'refused' as const, reason, at: entry.refusedAt, decidedBy: 'graphyard', waitedMs: Date.parse(entry.refusedAt) - Date.parse(entry.requestedAt), paths: entry.paths, requestedBy: owner, requestedAt: entry.requestedAt, epoch: entry.epoch } } : {}) };
  return {
    id: `work-${entry.subject}`, key: entry.subject, title: entry.subject, description: '', type: 'feature', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The behaviour changes as described', proofs: ['unit:behaviour-changes'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: entry.plannedFiles, stage: 'implementation', revision: 1, policyRevision: 1,
    createdAt: entry.requestedAt, updatedAt: observedAt, stageEnteredAt: entry.requestedAt, ready: true, epoch: entry.epoch,
    lease: { owner, epoch: entry.epoch, expiresAt: new Date(Date.parse(observedAt) + 10 * minute).toISOString() }, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null,
    blocker: entry.refusedAt ? `${scopeRefusalBlocker}: ${reason}` : null, gates: [], violations: [], scopeRequest: request,
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
    assert.match(verdict.reason, /tests\/helpers\/timing-baseline\.json is the test-duration baseline a change to tests\/\S+ must keep covering/);
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
