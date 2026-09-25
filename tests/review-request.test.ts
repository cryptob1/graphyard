import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { reconcileAutoDispatch, reviewNeed } from '../src/model/dispatch.js';
import { assertReviewCandidate } from '../src/reviewer.js';
import { emptyDaemonState, routineDecision, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { actorlessBoundMs, actorlessSubmissions } from '../src/cli/actorless-submissions.js';
import type { Evidence, Observation, Work } from '../src/model.js';

// GY-191, 2026-09-24: four submitted candidates sat in review for hours. Each was one merge behind
// main, so no review request was raised for its head (dispatch withheld it until the head contained
// the tip), nothing refreshed it, and nothing sent it back: main moves on every merge, so under load
// every candidate stalled. Being behind alone now withholds nothing; a head that does not merge
// cleanly goes back to a worker through the ordinary rework path; and a submitted item nobody is
// acting for is named in master status.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1'), B2 = sha40('b2');
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();

function observation(extra: Partial<Observation> = {}): Observation {
  return { candidate: { sha: H, baseSha: B, pr: 191, branch: 'graphyard/gy-191-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: iso(-10_000), prState: 'open', draft: false, baseTip: B, baseTree: sha40('7b'), baseTipContained: true, ...extra };
}
/** One commit behind base: the tip moved from B to B2, and the head's bound base is still B. */
const behind = (extra: Partial<Observation> = {}) => observation({ baseTip: B2, baseTipContained: false, ...extra });
const conflicting = () => behind({ mergeable: false, conflicting: true });

function item(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 191, branch: 'graphyard/gy-191-1', author: 'implementer' };
  return { id: 'work-191', key: 'GY-191', title: 'Behind base', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Reviewed', proofs: ['unit:behind-base-still-reviewed', 'integration:behind-base'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(-10_000), stageEnteredAt: iso(-30 * 60_000),
    ready: true, epoch: 1, lease: null, workspaces: [{ host: 'h', path: '/w/gy-191', branch: 'graphyard/gy-191-1', epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: 191 },
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: behind(), blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}
const evidence = (proof: string, id: string): Evidence => ({ id, proof, sha: H, baseSha: B, policyRevision: 1, producer: 'proof-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at: iso(-60_000) });
const proven = () => [evidence('unit:behind-base-still-reviewed', 'e1'), evidence('integration:behind-base', 'e2')];

test('unit:behind-base-still-reviewed — a mergeable candidate one commit behind base gets producer requests and then a review request for its head', () => {
  // Unproven: one producer request per proof group, bound to the head as it stands.
  const unproven = item();
  reconcileAutoDispatch(unproven, [unproven], new Date(clock));
  assert.deepEqual(unproven.autoDispatch!.producers.map(request => [request.group, request.sha, request.baseSha, request.state]), [['unit', H, B, 'requested'], ['integration', H, B, 'requested']]);

  // Proven: the review request is raised for the same head, bound to head, base and policy.
  const work = item({ evidence: proven() });
  const transitions = reconcileAutoDispatch(work, [work], new Date(clock));
  assert.deepEqual(transitions.map(entry => entry.event), ['dispatch.requested']);
  const review = work.autoDispatch!.review!;
  assert.deepEqual([review.kind, review.sha, review.baseSha, review.policyRevision, review.state], ['review', H, B, 1, 'requested']);
  assert.equal(reviewNeed(work, [work], new Date(clock)).state, 'required');
  // The launcher accepts it: a reviewer session is started for the head behind the base.
  assert.equal(assertReviewCandidate(work, iso(0)).sha, H);

  // A head GitHub reports conflicting with the base is still withheld, and says why.
  const conflict = item({ evidence: proven(), observation: conflicting() });
  reconcileAutoDispatch(conflict, [conflict], new Date(clock));
  assert.equal(conflict.autoDispatch!.review, null);
  assert.equal(reviewNeed(conflict, [conflict], new Date(clock)).state, 'base-not-contained');
  assert.throws(() => assertReviewCandidate(conflict, iso(0)), /merge conflict/);
});

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}
const decisionId = '5d8a8b9e-0000-4000-8000-000000000191';
function loopEffects(work: Work, decided: { action: string; reason: string }[], approvers: string[]) {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [work], now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work: Work, action: string, reason: string) => { decided.push({ action, reason }); return { id: decisionId }; },
    decisions: async () => ({ decisions: decided.map(entry => ({ id: decisionId, action: entry.action, state: 'requested', input: { expectedRevision: work.revision }, approvedBy: null })) }),
    approver: async (_work: Work, decision: string) => { approvers.push(decision); return { agentName: 'graphyard-approver-gy-191', pane: 'pane-1' }; },
    persist: async () => {},
  } as unknown as DaemonEffects;
}

test('unit:conflicting-candidate-reworked — a behind-base candidate GitHub reports conflicting, with no lease, is sent back through a rework decision and an approver', async () => {
  const work = item({ evidence: proven(), observation: conflicting() });
  const decision = routineDecision(work, { autoMerge: true }, clock);
  assert.equal(decision?.action, 'rework');
  assert.equal(decision?.binding, `${H}:sync:${B2}`);
  assert.match(decision!.reason, new RegExp(`conflicts with base branch tip ${B2.slice(0, 12)}`));
  // Merely behind, and mergeable, is not a rework: it is reviewed as it stands.
  assert.equal(routineDecision(item({ evidence: proven() }), { autoMerge: true }, clock), null);
  // A live worker still holds it: the round is not asked for over its head.
  assert.equal(routineDecision(item({ observation: conflicting(), lease: { owner: 'implementer', epoch: 1, expiresAt: iso(60_000) } } as Partial<Work>), { autoMerge: true }, clock), null);

  const decided: { action: string; reason: string }[] = [], approvers: string[] = [];
  const state = emptyDaemonState(config());
  await runCycle(config(), state, loopEffects(work, decided, approvers), () => clock);
  assert.deepEqual(decided.map(entry => entry.action), ['rework']);
  assert.match(decided[0].reason, new RegExp(`base branch tip ${B2.slice(0, 12)}`), 'the request names the conflicting base tip');
  assert.deepEqual(approvers, [decisionId], 'an independent approver is launched for it within the cycle');
});

test('unit:queue-ejection-reworked — a candidate the merge queue ejected on a conflicting speculative merge is sent back through a rework decision and an approver', async () => {
  // As `advanceQueue` records it when `publishSpeculativeTip` raises SpeculativeConflict.
  const reason = `Speculative merge of ${H.slice(0, 12)} into main conflicts and cannot be resolved by Graphyard`;
  const ejected = (extra: Partial<Work> = {}) => item({ evidence: proven(), observation: observation({ baseTip: B2 }), queue: null,
    queueEjection: { at: iso(-60_000), sequence: 12, reason, sha: H, policyRevision: 1 }, ...extra } as Partial<Work>);
  const work = ejected();
  const decision = routineDecision(work, { autoMerge: true }, clock);
  assert.equal(decision?.action, 'rework');
  assert.equal(decision?.binding, `${H}:queue-conflict:12:${B2}`);
  assert.match(decision!.reason, /merge queue ejected candidate .*conflicts/);
  // An ejection for another reason, or for an earlier head, is not a conflict on this one.
  assert.equal(routineDecision(ejected({ queueEjection: { at: iso(-60_000), sequence: 12, reason: `Required CI check test did not pass on speculative tip ${H.slice(0, 12)}`, sha: H, policyRevision: 1 } } as Partial<Work>), { autoMerge: true }, clock), null);
  assert.equal(routineDecision(ejected({ queueEjection: { at: iso(-60_000), sequence: 12, reason, sha: sha40('a9'), policyRevision: 1 } } as Partial<Work>), { autoMerge: true }, clock), null);

  const decided: { action: string; reason: string }[] = [], approvers: string[] = [];
  await runCycle(config(), emptyDaemonState(config()), loopEffects(work, decided, approvers), () => clock);
  assert.deepEqual(decided.map(entry => entry.action), ['rework']);
  assert.match(decided[0].reason, new RegExp(`base branch tip ${B2.slice(0, 12)}`));
  assert.deepEqual(approvers, [decisionId]);
});

test('unit:no-actor-item-surfaced — a submitted item with no review, producer or rework request and no named wait is named in master status after five minutes', () => {
  const now = new Date(clock);
  // Proven, with no dispatch record: the review request a reviewer answers was never raised.
  const orphan = item({ evidence: proven(), observation: observation(), stageEnteredAt: iso(-actorlessBoundMs - 60_000) });
  const [named] = actorlessSubmissions([orphan], now);
  assert.equal(named.subject, 'GY-191');
  assert.match(named.text, /GY-191 candidate a1ffffffffff has been submitted for 6m with no review request, no producer request, no rework request and no named wait; missing a reviewer/);
  assert.equal(named.role, 'master');
  assert.equal(named.next, 'graphyard master review GY-191');

  // Inside the bound, it is not yet named.
  assert.deepEqual(actorlessSubmissions([item({ evidence: proven(), observation: observation(), stageEnteredAt: iso(-60_000) })], now), []);
  // Each actor, and each named wait, accounts for it.
  const requested = item({ evidence: proven(), observation: observation(), stageEnteredAt: iso(-actorlessBoundMs - 60_000) });
  reconcileAutoDispatch(requested, [requested], new Date(clock - actorlessBoundMs - 30_000));
  assert.equal(requested.autoDispatch!.review!.state, 'requested');
  assert.deepEqual(actorlessSubmissions([requested], now), [], 'a live review request');
  const producing = item({ observation: observation(), stageEnteredAt: iso(-actorlessBoundMs - 60_000) });
  reconcileAutoDispatch(producing, [producing], new Date(clock - actorlessBoundMs - 30_000));
  assert.deepEqual(actorlessSubmissions([producing], now), [], 'a live producer request');
  assert.deepEqual(actorlessSubmissions([item({ ...orphanFields(), reworkRequested: true })], now), [], 'a rework request');
  assert.deepEqual(actorlessSubmissions([orphan], now, new Set(['GY-191'])), [], 'a rework decision with its approver');
  assert.deepEqual(actorlessSubmissions([item({ ...orphanFields(), blocker: 'waiting on the vendor' })], now), [], 'a blocker');
  assert.deepEqual(actorlessSubmissions([item({ ...orphanFields(), stage: 'done' })], now), [], 'delivered');

  // A conflicting head nobody sent back names the sync rework it is missing.
  const stuck = actorlessSubmissions([item({ ...orphanFields(), observation: conflicting(), baseRefresh: { from: { sha: H }, base: B2, policyRevision: 1, at: iso(-actorlessBoundMs - 60_000), head: H, conflict: null, merge: null, carry: null } } as Partial<Work>)], now);
  assert.equal(stuck.length, 1);
  assert.match(stuck[0].text, /missing a sync rework/);
});
function orphanFields(): Partial<Work> {
  return { evidence: proven(), observation: observation(), stageEnteredAt: iso(-actorlessBoundMs - 60_000) };
}
