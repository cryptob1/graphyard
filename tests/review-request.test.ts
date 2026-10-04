import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { reconcileAutoDispatch, reviewNeed } from '../src/model/dispatch.js';
import { assertReviewCandidate } from '../src/reviewer.js';
import { emptyDaemonState, routineDecision, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { actorlessBoundMs, actorlessSubmissions } from '../src/cli/actorless-submissions.js';
import type { Evidence, Observation, Work } from '../src/model.js';
import { GitHub } from '../src/github.js';
import type { BaseRefresh } from '../src/merge-queue.js';
import { conflictRoute, docsOnlyConflict, docsSyncAdoption, docsSyncCarry, overlappingPaths } from '../src/model/docs-sync.js';
import { conflictHotspots, hotspotAttentionText, ledgerConflicts, type ConflictOccurrence } from '../src/model/conflict-hotspots.js';
import { docsSyncCheckout, docsSyncCheckoutRefusal, docsSyncPrompt, docsSyncSessionName, prepareDocsSyncCheckout, reclaimDocsSyncCheckouts, type DocsSyncPlan } from '../src/docs-sync.js';
import { coordinatorConfinement } from '../src/master/profiles.js';
import { prepareConfinedGitPaths } from '../src/master/launch.js';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionNameRefusal } from '../src/session-name.js';

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
const conflicting = (extra: Partial<Observation> = {}) => behind({ mergeable: false, conflicting: true, ...extra });

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
  // While the control plane's own test merge onto that tip is pending, it decides (GY-566): a
  // confirmed conflict is reworked on its record, or docs-synced when confined to docs pages.
  assert.equal(routineDecision(item({ evidence: proven(), observation: conflicting() }), { autoMerge: true }, clock), null);
  // GitHub's reading alone, with no test merge the control plane can run: containment is unknown.
  const work = item({ evidence: proven(), observation: conflicting({ baseTipContained: undefined }) });
  const decision = routineDecision(work, { autoMerge: true }, clock);
  assert.equal(decision?.action, 'rework');
  assert.equal(decision?.binding, `${H}:sync:${B2}`);
  assert.match(decision!.reason, new RegExp(`conflicts with base branch tip ${B2.slice(0, 12)}`));
  // Merely behind, and mergeable, is not a rework: it is reviewed as it stands.
  assert.equal(routineDecision(item({ evidence: proven() }), { autoMerge: true }, clock), null);
  // A live worker still holds it: the round is not asked for over its head.
  assert.equal(routineDecision(item({ observation: conflicting({ baseTipContained: undefined }), lease: { owner: 'implementer', epoch: 1, expiresAt: iso(60_000) } } as Partial<Work>), { autoMerge: true }, clock), null);

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

  // GY-252: the record's typed conflict flag decides, not the wording of its reason. A reworded
  // conflict is still reworked; a flagged non-conflict whose reason reads like one is not.
  const flagged = ejected({ queueEjection: { at: iso(-60_000), sequence: 12, reason: 'the tip could not be built', sha: H, policyRevision: 1, conflict: { base: B2 }, predecessors: [] } } as Partial<Work>);
  assert.equal(routineDecision(flagged, { autoMerge: true }, clock)?.binding, `${H}:queue-conflict:12:${B2}`);
  assert.equal(routineDecision(ejected({ queueEjection: { at: iso(-60_000), sequence: 12, reason, sha: H, policyRevision: 1, conflict: null } } as Partial<Work>), { autoMerge: true }, clock), null);
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

  // GY-252: a stalled observation is no named wait. When readings stop (the GitHub rate budget is
  // exhausted, say), the item is still named, rather than every submitted one counting as accounted for.
  const stale = actorlessSubmissions([item({ ...orphanFields(), observation: observation({ at: iso(-actorlessBoundMs - 30 * 60_000) }) })], now);
  assert.equal(stale.length, 1, 'an observation older than two minutes accounts for nothing');
  assert.match(stale[0].text, /missing a reviewer/);
});
function orphanFields(): Partial<Work> {
  return { evidence: proven(), observation: observation(), stageEnteredAt: iso(-actorlessBoundMs - 60_000) };
}

// GY-566, in its own scope: its fixtures shadow this file's.
{

/**
 * GY-566. On 2026-09-26 thirteen queued items went back to a full worker rework in thirty minutes,
 * almost all for conflicts in the same few docs pages. A conflict confined to docs pages now goes
 * to a short docs-sync session and keeps its approval when the change outside docs/ is unchanged;
 * master status and Insights name the paths that keep conflicting.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000;
const reviewed = 'a'.repeat(40), bound = 'b'.repeat(40), tip = 'c'.repeat(40), synced = 'd'.repeat(40);

function docsConfig(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}

/** A submitted, approved item whose base refresh confirmed a conflict with base tip `tip` on `paths`. */
function conflicted(paths: string[] | null, observedAt = iso(-30_000)): Work {
  const candidate = { sha: reviewed, baseSha: bound, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, baseTip: tip, baseTipContained: false, conflicting: true,
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'independent-reviewer', sha: reviewed, state: 'APPROVED', submittedAt: iso(-60 * minute) }],
    protected: true, mergeable: false, merged: false, mergeSha: null, files: ['src/loop.ts', 'docs/master-agent.md'], scopeFiles: [], at: observedAt, prState: 'open', draft: false,
  } as unknown as Observation;
  const baseRefresh: BaseRefresh = { from: { sha: reviewed, baseSha: bound }, base: tip, baseTree: 'e'.repeat(40), policyRevision: 1, at: iso(-minute), head: null,
    conflict: `Candidate ${reviewed.slice(0, 12)} cannot be brought onto base branch tip ${tip.slice(0, 12)} without resolving a conflict`, merge: null, carry: null, trigger: 'conflict confirmed', conflictPaths: paths };
  return {
    id: 'work-42', key: 'GY-42', title: 'A change that documents itself', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts', 'docs/master-agent.md'], stage: 'merge', revision: 5, policyRevision: 1, createdAt: iso(-4 * 60 * minute), updatedAt: iso(0),
    stageEnteredAt: iso(-30 * minute), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 42 },
    candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, baseRefresh, blocker: null, violations: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'merge', passed: false, reasons: ['Pull request is not mergeable against the current base'] }],
  } as Work;
}

function loop(work: () => Work, record: { decided: string[]; synced: DocsSyncPlan[]; agents: string[] }, local?: string[] | null): DaemonEffects {
  return {
    agents: () => [], herdr: () => ({ agents: record.agents.map((name, index) => ({ name, pane_id: `pane-${index}`, agent_status: 'working' })), available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work: [work()], now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work, action) => { record.decided.push(action); return { id: '5d8a8b9e-0000-4000-8000-000000000001' }; },
    decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'graphyard-approver-gy-42', pane: 'pane-a' }),
    docsSync: async (_item, plan) => { record.synced.push(plan); record.agents.push(`graphyard-docs-sync-gy-42-${plan.head.slice(0, 7)}`); return { agentName: record.agents.at(-1)!, pane: 'pane-s', account: 'reviewer-a', runtime: 'claude', session: null }; },
    ...(local === undefined ? {} : { conflictPaths: async () => local }),
    persist: async () => {},
  };
}

test('unit:docs-only-conflict-synced — a docs-only conflict leads to a docs-sync session and no rework decision; a conflict touching src/ still goes to rework; the approval is kept when the non-docs patch is unchanged', async () => {
  // The routing rule: docs/**/*.md only, and a known, non-empty set.
  assert.equal(docsOnlyConflict(['docs/master-agent.md', 'docs/guides/onboarding.md']), true);
  assert.equal(docsOnlyConflict(['docs/master-agent.md', 'src/cli/master-status.ts']), false);
  assert.equal(docsOnlyConflict(['README.md']), false, 'only pages under docs/ are the docs-sync\'s');
  assert.equal(docsOnlyConflict([]), false); assert.equal(docsOnlyConflict(null), false);
  assert.equal(conflictRoute(['docs/onboarding.md', 'src/cli/master-status.ts']).route, 'rework');
  assert.match(conflictRoute(['docs/onboarding.md', 'src/cli/master-status.ts']).reason, /src\/cli\/master-status\.ts/);
  assert.deepEqual(overlappingPaths(['docs/a.md', 'src/x.ts', 'docs/b.md'], ['docs/b.md', 'docs/a.md', 'src/y.ts']), ['docs/a.md', 'docs/b.md']);
  assert.equal(overlappingPaths(null, ['docs/a.md']), null, 'an unlisted side is unknown, never clean');

  // 1. A docs-only conflict: the loop launches one docs-sync session and requests no rework.
  const docs = { decided: [] as string[], synced: [] as DocsSyncPlan[], agents: [] as string[] };
  let item = conflicted(['docs/master-agent.md', 'docs/onboarding.md']);
  const state = emptyDaemonState(docsConfig());
  const first = await runCycle(docsConfig(), state, loop(() => item, docs), () => clock);
  assert.deepEqual(docs.decided, [], 'no rework decision is requested for a docs-only conflict');
  assert.equal(docs.synced.length, 1, 'one docs-sync session is launched');
  assert.deepEqual(docs.synced[0], { key: 'GY-42', pr: 42, branch: 'graphyard/gy-42-1', baseBranch: 'main', head: reviewed, base: tip, paths: ['docs/master-agent.md', 'docs/onboarding.md'] });
  assert.ok(first.actions.some(action => action.work === 'GY-42' && /^Launched docs-sync session .* no rework decision is requested/.test(action.detail)), 'the cycle reports the launch');
  assert.ok(first.actions.some(action => action.work === 'GY-42' && /both sides changed only docs pages/.test(action.detail)), 'the refresh report names the docs-sync route, not a worker');
  assert.deepEqual(state.conflicts.map(entry => [entry.work, entry.route, entry.paths]), [['GY-42', 'docs-sync', ['docs/master-agent.md', 'docs/onboarding.md']]]);
  // The session's instruction is narrow: merge the base, keep both meanings, stay in budget, touch only the conflicted paragraphs, rerun the checks.
  const prompt = docsSyncPrompt(docsConfig(), docs.synced[0], '/repo');
  for (const phrase of [`git merge --no-ff ${tip}`, 'both sides\' meaning', 'word budget', 'Touch only the conflicted paragraphs', 'tests/docs-budget.test.ts tests/docs-obligation.test.ts', 'never forced', 'Do not run graphyard complete'])
    assert.ok(prompt.includes(phrase), `the prompt says: ${phrase}`);

  assert.equal(sessionNameRefusal(docsSyncSessionName({ key: 'GY-1234', head: reviewed })), null, 'the session name is one every runtime accepts');
  // While the session runs, nothing more happens; a second cycle neither relaunches nor reworks.
  await runCycle(docsConfig(), state, loop(() => item, docs), () => clock);
  assert.deepEqual(docs.decided, []); assert.equal(docs.synced.length, 1);

  // The session ends without moving the head: once an observation taken after that still shows
  // the reviewed head, the conflict goes back to a worker as before.
  docs.agents.length = 0;
  await runCycle(docsConfig(), state, loop(() => item, docs), () => clock);
  assert.deepEqual(docs.decided, [], 'a push not yet observed is waited for');
  item = conflicted(['docs/master-agent.md', 'docs/onboarding.md'], iso(1_000));
  await runCycle(docsConfig(), state, loop(() => item, docs), () => clock + 2_000);
  assert.deepEqual(docs.decided, ['rework'], 'a docs-sync that gave up is followed by rework');
  assert.equal(state.conflicts[0].route, 'rework', 'and the conflict is counted as sent back');

  // 2. A conflict touching src/ goes to rework, and no docs-sync is launched — the loop's own
  // merge of the head and the base decides over the paths both sides changed.
  const code = { decided: [] as string[], synced: [] as DocsSyncPlan[], agents: [] as string[] };
  const mixed = conflicted(['docs/onboarding.md']);
  await runCycle(docsConfig(), emptyDaemonState(docsConfig()), loop(() => mixed, code, ['docs/onboarding.md', 'src/cli/master-status.ts']), () => clock);
  assert.deepEqual(code.decided, ['rework']); assert.deepEqual(code.synced, []);
  const unknown = { decided: [] as string[], synced: [] as DocsSyncPlan[], agents: [] as string[] };
  await runCycle(docsConfig(), emptyDaemonState(docsConfig()), loop(() => conflicted(null), unknown), () => clock);
  assert.deepEqual(unknown.decided, ['rework'], 'unknown conflicted paths go to a worker'); assert.deepEqual(unknown.synced, []);

  // 3. The synced head is recorded as the refresh's outcome, and the approval is kept only when
  // the diff outside docs/ has the same patch-id on both sides.
  const approved = conflicted(['docs/master-agent.md']);
  const observed = { candidate: { sha: synced, baseSha: tip, pr: 42 }, merged: false, prState: 'open' };
  const adoption = docsSyncAdoption(approved, observed)!;
  assert.deepEqual(adoption, { from: { sha: reviewed, baseSha: bound }, base: tip, head: synced, to: { sha: synced, baseSha: tip }, paths: ['docs/master-agent.md'] });
  assert.equal(docsSyncAdoption({ ...approved, reworkRequested: true }, observed), null, 'a worker\'s own sync after a rework is a new submission');
  assert.equal(docsSyncAdoption(approved, { ...observed, candidate: { ...observed.candidate, sha: reviewed } }), null, 'the reviewed head itself is no docs-sync');

  // GitHub describes the merge and both diffs; the docs hunk differs, the code hunk does not.
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'unused' });
  const code1 = { filename: 'src/loop.ts', status: 'modified', changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' };
  const compare: Record<string, any[]> = {
    [`${bound}...${reviewed}`]: [code1, { filename: 'docs/master-agent.md', status: 'modified', changes: 1, patch: '@@ -3 +3 @@\n-a\n+item text' }],
    [`${tip}...${synced}`]: [code1, { filename: 'docs/master-agent.md', status: 'modified', changes: 2, patch: '@@ -7 +7 @@\n-b\n+base text and item text' }],
    [`${bound}...${tip}`]: [{ filename: 'docs/master-agent.md', status: 'modified', changes: 1, patch: '@@ -3 +3 @@\n-a\n+base text' }],
  };
  (github as any).controlPlaneLogin = async () => 'graphyard-app[bot]';
  (github as any).request = async (path: string) => {
    if (path === `/commits/${synced}`) return { parents: [{ sha: reviewed }, { sha: tip }], author: { login: 'docs-sync-account' }, commit: { author: { email: 'sync@example.com' } } };
    if (path === `/commits/${tip}`) return { commit: { tree: { sha: 'f'.repeat(40) } } };
    const range = path.replace(/^\/compare\//, '');
    if (compare[range]) return { status: 'ahead', files: compare[range] };
    throw new Error(`unexpected request ${path}`);
  };
  const refresh = await github.docsSyncRefresh(approved, adoption);
  assert.equal(refresh.head, synced); assert.equal(refresh.trigger, 'docs sync'); assert.equal(refresh.conflict, null);
  assert.ok(refresh.docsSync!.reviewed && refresh.docsSync!.reviewed === refresh.docsSync!.synced, 'the diff outside docs/ has one patch-id on both sides');
  const approval = { provider: 'github' as const, reviewer: 'independent-reviewer', sha: reviewed };
  const carry = (docsSync = refresh.docsSync!, merge = refresh.merge!) => docsSyncCarry({ from: refresh.from, base: tip, at: iso(0), policyRevision: 1, merge, docsSync, reviewedFiles: ['src/loop.ts'], approval, proofs: [{ proof: 'unit:loop', evidence: undefined }] });
  const kept = carry();
  assert.equal(kept.approval.carried, true, 'the approval is kept on the docs-sync head');
  assert.match(kept.approval.reason, /diff outside docs\/ is unchanged/);
  assert.deepEqual(kept.to, { sha: synced, baseSha: tip });
  assert.equal(kept.evidence[0].carried, false, 'the proofs run again on the synced head');

  // The docs-sync also touched code: the approval is required again (still no rework round).
  compare[`${tip}...${synced}`] = [{ ...code1, patch: '@@ -1 +1 @@\n-old\n+newer' }];
  const touched = await github.docsSyncRefresh(approved, adoption);
  assert.notEqual(touched.docsSync!.reviewed, touched.docsSync!.synced);
  const required = carry(touched.docsSync!, touched.merge!);
  assert.equal(required.approval.carried, false);
  assert.match(required.approval.reason, /changed the diff outside docs\//);
  // A head that is not exactly the reviewed head merged with the conflicting tip carries nothing.
  assert.equal(carry(refresh.docsSync!, { ...refresh.merge!, parents: [reviewed, 'f'.repeat(40)] }).approval.carried, false);
});

test('unit:conflict-hotspots-reported — master status and Insights report the paths most often conflicting in the last 24 hours with counts and the items they sent back, and raise attention at 5 conflicts on one path', () => {
  const at = (hoursAgo: number) => iso(-hoursAgo * 3_600_000);
  const occurrences: ConflictOccurrence[] = [
    { work: 'GY-268', at: at(1), paths: ['docs/master-agent.md', 'docs/onboarding.md'], route: 'rework' },
    { work: 'GY-303', at: at(2), paths: ['docs/master-agent.md'], route: 'docs-sync' },
    { work: 'GY-316', at: at(3), paths: ['docs/master-agent.md', 'src/cli/master-status.ts'], route: 'rework' },
    { work: 'GY-401', at: at(5), paths: ['docs/master-agent.md'], route: 'docs-sync' },
    { work: 'GY-404', at: at(8), paths: ['docs/master-agent.md', 'docs/master-agent.md'], route: 'docs-sync' },
    { work: 'GY-417', at: at(9), paths: ['docs/onboarding.md'], route: 'docs-sync' },
    // Older than the window: not counted.
    { work: 'GY-100', at: at(30), paths: ['docs/master-agent.md'], route: 'rework' },
  ];
  const report = conflictHotspots(occurrences, clock);
  assert.equal(report.windowHours, 24); assert.equal(report.threshold, 5);
  assert.equal(report.conflicts, 6); assert.equal(report.sentBack, 2); assert.equal(report.docsSynced, 4);
  assert.deepEqual(report.hotspots[0], { path: 'docs/master-agent.md', conflicts: 5, items: ['GY-268', 'GY-303', 'GY-316', 'GY-401', 'GY-404'], sentBack: ['GY-268', 'GY-316'] });
  assert.deepEqual(report.hotspots.slice(1).map(entry => [entry.path, entry.conflicts]), [['docs/onboarding.md', 2], ['src/cli/master-status.ts', 1]]);
  assert.deepEqual(report.attention.map(entry => entry.path), ['docs/master-agent.md'], 'one path causing 5 conflicts in 24 hours is raised');
  const text = hotspotAttentionText(report.attention[0], report.windowHours);
  assert.match(text, /docs\/master-agent\.md caused 5 merge conflicts in the last 24 hours/);
  assert.match(text, /GY-268, GY-303, GY-316, GY-401, GY-404; 2 sent back to a worker/);
  assert.equal(conflictHotspots(occurrences.slice(1), clock).attention.length, 0, 'four is below the threshold');

  // Insights reads the same from the ledger: each confirmed conflict with its recorded paths,
  // docs-synced when a docs-sync refresh adopted a head for the same reviewed head.
  const rows = [
    { key: 'GY-268', kind: 'base.conflict', at: at(1), details: { from: { sha: 'h1' }, conflictPaths: ['docs/master-agent.md'] } },
    { key: 'GY-303', kind: 'base.conflict', at: at(2), details: { from: { sha: 'h2' }, conflictPaths: ['docs/master-agent.md'] } },
    { key: 'GY-303', kind: 'base.refreshed', at: at(1.5), details: { from: { sha: 'h2' }, trigger: 'docs sync' } },
    { key: 'GY-316', kind: 'base.conflict', at: at(3), details: { from: { sha: 'h3' }, conflict: 'recorded before GY-566' } },
  ];
  assert.deepEqual(ledgerConflicts(rows), [
    { work: 'GY-268', at: at(1), paths: ['docs/master-agent.md'], route: 'rework' },
    { work: 'GY-303', at: at(2), paths: ['docs/master-agent.md'], route: 'docs-sync' },
  ]);
  assert.deepEqual(conflictHotspots(ledgerConflicts(rows), clock).hotspots, [{ path: 'docs/master-agent.md', conflicts: 2, items: ['GY-268', 'GY-303'], sentBack: ['GY-268'] }]);
});

/**
 * GY-1205. Every session runs with the coordinator checkout bind-mounted read-only (GY-888), and
 * the docs-sync session was told to create its own worktree under it: on 2026-10-04 every one
 * reported `.graphyard/docs-sync` read-only and sat idle until docsSyncMaxMs. The launcher now
 * creates the worktree and starts the session in it, re-exposed writable.
 */
function docsSyncRepository() {
  const base = mkdtempSync(join(tmpdir(), 'graphyard-docs-sync-'));
  const root = join(base, 'coordinator');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'page.md'), '# Page\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  git('config', 'user.email', 'graphyard@localhost'); git('config', 'user.name', 'Graphyard');
  git('add', '.'); git('commit', '-m', 'main');
  return { base, root, head: git('rev-parse', 'HEAD') };
}

test('unit:docs-sync-checkout-writable-under-confinement — the docs-sync worktree is created by the launcher, the session starts in it, and a confined claude launch binds it and the shared Git directory writable after the read-only coordinator bind', async () => {
  const { base, root, head } = docsSyncRepository();
  try {
    const plan: DocsSyncPlan = { key: 'GY-42', pr: 42, branch: 'graphyard/gy-42-1', baseBranch: 'main', head, base: head, paths: ['docs/page.md'] };
    mkdirSync(join(root, '.graphyard', 'docs-sync'), { recursive: true });
    const checkout = prepareDocsSyncCheckout(root, plan);
    assert.equal(checkout, docsSyncCheckout(root, plan));
    assert.ok(existsSync(join(checkout, 'docs', 'page.md')), 'the launcher created the detached worktree of the reviewed head');
    assert.ok(docsSyncPrompt(docsConfig(), plan, root).includes(`You start in ${checkout}`), 'the session is told it starts in that worktree');
    assert.ok(!docsSyncPrompt(docsConfig(), plan, root).includes('worktree add'), 'the session no longer creates a worktree under the read-only checkout');

    prepareConfinedGitPaths(root);
    const confinement = await coordinatorConfinement({ kind: 'claude', args: [], coordinatorRoot: root, sessionDirectory: checkout, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap' });
    assert.equal(confinement?.mechanism, 'read-only-mount');
    const words = [...confinement!.wrapper];
    const at = (flag: string, path: string) => words.findIndex((word, index) => word === flag && words[index + 1] === path && words[index + 2] === path);
    const readOnly = at('--ro-bind', root);
    assert.ok(readOnly > 0, 'the coordinator checkout is bound read-only');
    assert.ok(at('--bind', checkout) > readOnly, 'the docs-sync checkout is bound writable after it');
    for (const shared of [join(root, '.git', 'objects'), join(root, '.git', 'worktrees', 'GY-42-' + head.slice(0, 7)), join(root, '.git', 'refs', 'remotes')])
      assert.ok(at('--bind', shared) > readOnly, `the shared Git path ${shared} is bound writable after it`);
    assert.equal(await docsSyncCheckoutRefusal(checkout, confinement), null, 'the launch is not refused');

    // A finished session's checkout is reclaimed; a live one's is kept.
    assert.deepEqual(await reclaimDocsSyncCheckouts(root, [docsSyncSessionName(plan)]), []);
    assert.deepEqual(await reclaimDocsSyncCheckouts(root, []), [checkout]);
    assert.ok(!existsSync(checkout));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('unit:docs-sync-unwritable-checkout-refused — a docs-sync launch whose checkout cannot be written is refused before the session starts, naming the path, and the conflict goes to rework in the same cycle', async () => {
  const base = mkdtempSync(join(tmpdir(), 'graphyard-docs-sync-'));
  const checkout = join(base, 'GY-42-aaaaaaa');
  mkdirSync(checkout);
  try {
    // Under a confinement that leaves it behind the read-only coordinator bind, it is refused too.
    const hidden = { mechanism: 'read-only-mount' as const, detail: '', wrapper: ['bwrap', '--dev-bind', '/', '/', '--ro-bind', base, base, '--bind', join(base, 'other'), join(base, 'other'), '--'] };
    assert.match((await docsSyncCheckoutRefusal(checkout, hidden))!, new RegExp(`${checkout}.*under the session's confinement`));
    chmodSync(checkout, 0o555);
    const refusal = await docsSyncCheckoutRefusal(checkout, null);
    assert.ok(refusal?.includes(`The docs-sync checkout ${checkout} is not writable`), `the refusal names the path: ${refusal}`);

    const docs = { decided: [] as string[], synced: [] as DocsSyncPlan[], agents: [] as string[] };
    const item = conflicted(['docs/master-agent.md']);
    const state = emptyDaemonState(docsConfig());
    const effects = loop(() => item, docs);
    let started = false;
    effects.docsSync = async () => { const why = await docsSyncCheckoutRefusal(checkout, null); if (why) throw new Error(why); started = true; return { agentName: 'never', pane: null, account: null, runtime: 'claude', session: null }; };
    const cycle = await runCycle(docsConfig(), state, effects, () => clock);
    assert.equal(started, false, 'no session is started');
    assert.deepEqual(docs.decided, ['rework'], 'the conflict is routed to rework in the same cycle');
    assert.equal(state.conflicts[0].route, 'rework');
    assert.ok(cycle.actions.some(action => action.work === 'GY-42' && action.detail.includes(`The docs-sync checkout ${checkout} is not writable`)), 'the cycle report names the unwritable path');
  } finally { chmodSync(checkout, 0o755); rmSync(base, { recursive: true, force: true }); }
});
}
