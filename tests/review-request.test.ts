import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHub } from '../src/github.js';
import { diagnose } from '../src/coordination.js';
import { Refusal, SpeculativeConflict, placeInQueue, type Evidence, type Observation, type Work } from '../src/model.js';
import { reconcileAutoDispatch, reviewNeed } from '../src/model/dispatch.js';
import { assertReviewCandidate } from '../src/reviewer.js';
import { actorlessAttention, actorlessBoundMs, emptyDaemonState, routineDecision, runCycle, submittedItemActor, unresolvedBaseConflict, writeDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';

// GY-191, 2026-09-24 23:31Z: GY-166, GY-174, GY-176 and GY-181 sat in review with no review request
// and no producer. Each head was one merge behind main; review was withheld until the head
// contained the base tip, the worker's lease had ended at `complete`, nothing requested a rework,
// and the merge queue publishes a tip only for a proven candidate — so nothing ever moved them.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1'), B2 = sha40('b2');
const clock = Date.parse('2026-09-24T23:40:00.000Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const at = iso(0);

function observation(extra: Partial<Observation> = {}): Observation {
  return { candidate: { sha: H, baseSha: B, pr: 166, branch: 'graphyard/gy-166-1', author: 'implementer' }, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [], merged: false, mergeSha: null,
    mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: B, baseTree: sha40('7b'), baseTipContained: true, ...extra };
}
/** One merge behind main: the base branch advanced from B to B2 after the head was submitted. */
const behind = (extra: Partial<Observation> = {}) => observation({ baseTip: B2, baseTree: sha40('7c'), baseTipContained: false, baseTipAncestor: false, ...extra });
function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 166, branch: 'graphyard/gy-166-1', author: 'implementer' };
  return { id: 'work-166', key: 'GY-166', title: 'Behind main', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Unit', proofs: ['unit:gy-166'] }, { id: 'AC-2', text: 'Integration', proofs: ['integration:gy-166'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 12, policyRevision: 1, createdAt: iso(-60 * 60_000), updatedAt: at, stageEnteredAt: iso(-20 * 60_000),
    ready: true, epoch: 1, lease: null, containmentQuarantine: null, workspaces: [], candidate, submission: { epoch: 1, pr: 166 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: behind(), blocker: null, violations: [], autoDispatch: { review: null, producers: [], history: [] },
    // The control plane's one refresh of this head onto B2 is already recorded and republished nothing,
    // so no base refresh is pending: the state GY-166 and its peers sat in.
    baseRefresh: { from: { sha: H, baseSha: B }, base: B2, baseTree: sha40('7c'), policyRevision: 1, at: iso(-15 * 60_000), head: H, conflict: null, merge: null, carry: null },
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['A new independent GitHub approval is required'] }],
    ...overrides } as Work;
}
const evidence = (proof: string): Evidence => ({ id: `ev-${proof}`, proof, sha: H, baseSha: B, policyRevision: 1, producer: 'proof-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at });

test('unit:behind-base-still-reviewed — a submitted candidate one commit behind base that merges cleanly gets producer requests and a review request for its head', () => {
  const item = work();
  // Producers first: they are asked for the exact head, behind or not.
  reconcileAutoDispatch(item, [item], new Date(clock));
  assert.deepEqual(item.autoDispatch!.producers.map(request => [request.group, request.sha, request.state]), [['unit', H, 'requested'], ['integration', H, 'requested']]);
  assert.equal(reviewNeed(item, [item], new Date(clock)).state, 'proofs-pending', 'mechanical proofs precede judgment, as for any other candidate');
  // The proofs pass: the review request is raised for that head, bound to it and its base.
  item.evidence = [evidence('unit:gy-166'), evidence('integration:gy-166')];
  reconcileAutoDispatch(item, [item], new Date(clock + 1000));
  const review = item.autoDispatch!.review;
  assert.ok(review, 'a review request is raised although the head does not contain the base tip');
  assert.deepEqual([review.kind, review.sha, review.baseSha, review.state], ['review', H, B, 'requested']);
  assert.equal(reviewNeed(item, [item], new Date(clock + 1000)).state, 'required');
  // The launched reviewer accepts the head, and diagnose names no sync as owed.
  assert.deepEqual(assertReviewCandidate(item, iso(1000)).sha, H);
  const hint = diagnose(item, [item], clock + 1000).find(entry => entry.kind === 'base-behind');
  assert.match(hint!.next, /GitHub reports it mergeable, so it is reviewed and proven as it stands and the merge queue integrates and re-tests it/);
  assert.doesNotMatch(hint!.next, /No review is requested/);
  // Only a behind head GitHub does not report mergeable is withheld: conflicting, or not yet computed.
  for (const extra of [{ mergeable: false, mergeConflict: true }, { mergeable: false }]) {
    const withheld = work({ evidence: item.evidence, observation: behind(extra) });
    reconcileAutoDispatch(withheld, [withheld], new Date(clock));
    assert.equal(withheld.autoDispatch!.review, null);
    assert.equal(reviewNeed(withheld, [withheld], new Date(clock)).state, 'base-not-contained');
    assert.throws(() => assertReviewCandidate(withheld, at), /does not contain the base branch tip b2ffffffffff and GitHub does not report it mergeable/);
  }
});

/** The loop's effects with the server and runtime stubbed: what it decided and which approvers it launched. */
function loopEffects(item: Work, decided: { action: string; reason: string }[], approvers: string[]) {
  const id = '5d8a8b9e-0000-4000-8000-000000000191';
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [item], now: at, jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work: Work, action: string, reason: string) => { decided.push({ action, reason }); return { id }; },
    decisions: async () => ({ decisions: decided.map(entry => ({ id, action: entry.action, state: 'requested', input: { expectedRevision: item.revision }, approvedBy: null })) }),
    approver: async (_work: Work, decision: string) => { approvers.push(decision); return { agentName: 'graphyard-approver-gy-166', pane: 'pane-1' }; },
    persist: async () => {},
  } as unknown as DaemonEffects;
}
function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
}
async function reworkCycle(item: Work) {
  const decided: { action: string; reason: string }[] = [], approvers: string[] = [];
  const state = emptyDaemonState(config());
  await runCycle(config(), state, loopEffects(item, decided, approvers), () => clock);
  return { decided, approvers };
}

test('unit:conflicting-candidate-reworked — a conflicting behind-base candidate with no lease is sent back through a rework decision naming the base tip, with an approver launched, in one cycle', async () => {
  const item = work({ observation: behind({ mergeable: false, mergeConflict: true }) });
  assert.equal(item.lease, null);
  const conflict = unresolvedBaseConflict(item);
  assert.equal(conflict?.baseTip, B2);
  const decision = routineDecision(item, { autoMerge: true }, clock);
  assert.equal(decision?.action, 'rework');
  assert.equal(decision?.binding, `${H}:conflict`);
  assert.match(decision!.reason, /GitHub reports a1ffffffffff conflicting with base branch tip b2ffffffffff/);
  assert.match(decision!.reason, /graphyard sync GY-166 onto b2ffffffffff/);
  assert.match(decision!.reason, /The previous worker is stopped/);

  const { decided, approvers } = await reworkCycle(item);
  assert.deepEqual(decided.map(entry => entry.action), ['rework'], 'the rework decision is requested within one cycle');
  assert.match(decided[0].reason, /base branch tip b2ffffffffff/);
  assert.deepEqual(approvers, ['5d8a8b9e-0000-4000-8000-000000000191'], 'an independent approver is launched for it');

  // A behind head that merges cleanly, or whose mergeability GitHub is still computing, is not reworked.
  for (const extra of [{}, { mergeable: false }]) assert.equal(routineDecision(work({ observation: behind(extra) }), { autoMerge: true }, clock), null);
  // A live worker still owns its head: nothing is asked while it holds the lease.
  assert.equal(routineDecision(work({ observation: behind({ mergeable: false, mergeConflict: true }), lease: { owner: 'graphyard-claude-1', epoch: 1, expiresAt: iso(60_000) } } as Partial<Work>), { autoMerge: true }, clock), null);
});

test('unit:no-actor-item-surfaced — a submitted candidate with no review, producer or rework request and no named wait is a master status attention item naming it and the missing actor', async () => {
  // Behind, and GitHub has not reported whether it merges cleanly: no review, and no rework either.
  const stranded = work({ observation: behind({ mergeable: false }) });
  assert.equal(submittedItemActor(stranded, [stranded], clock), null);
  const [item] = actorlessAttention({ work: [stranded], now: at });
  assert.equal(item.subject, 'GY-166');
  assert.match(item.text, /^GY-166 is submitted \(PR #166, head a1ffffffffff\) with no review request, no producer request, no rework request and no named external wait; missing actor: a worker to sync it/);
  assert.equal(item.role, 'master'); assert.equal(item.human, false);
  assert.ok(actorlessBoundMs <= 5 * 60_000, 'raised within five minutes');
  assert.deepEqual(actorlessAttention({ work: [work({ observation: behind({ mergeable: false }), stageEnteredAt: iso(-30_000) })], now: at }), [], 'not before the bound');
  // Each actor, and each named wait, accounts for the item.
  const actors: [string, Partial<Work>][] = [
    ['review request', { autoDispatch: { review: { id: 'r1', kind: 'review', provider: 'github', sha: H, baseSha: B, policyRevision: 1, pr: 166, reason: 'x', requestedAt: at, state: 'requested' }, producers: [], history: [] } } as Partial<Work>],
    ['producer request', { autoDispatch: { review: null, producers: [{ id: 'p1', kind: 'producer', group: 'unit', proofs: ['unit:gy-166'], sha: H, baseSha: B, policyRevision: 1, pr: 166, reason: 'x', requestedAt: at, state: 'requested' }], history: [] } } as Partial<Work>],
    ['rework round', { reworkRequested: true }],
    ['rework decision', { observation: behind({ mergeable: false, mergeConflict: true }) }],
    ['worker', { lease: { owner: 'graphyard-claude-1', epoch: 1, expiresAt: iso(60_000) } } as Partial<Work>],
    ['blocker', { blocker: 'waiting on a credential' }],
    ['GitHub observation', { observation: behind({ mergeable: false, at: iso(-10 * 60_000) }) }],
    ['CI', { observation: behind({ mergeable: false, checks: [{ name: 'test', result: 'in_progress', appId: 15368 }] }) }],
  ];
  for (const [actor, overrides] of actors) {
    const accounted = work({ observation: behind({ mergeable: false }), ...overrides });
    assert.match(submittedItemActor(accounted, [accounted], clock) ?? 'none', new RegExp(actor), actor);
    assert.deepEqual(actorlessAttention({ work: [accounted], now: at }), [], actor);
  }

  // And `master status` raises it, counted with the attention.
  const root = await mkdtemp(join(tmpdir(), 'graphyard-actorless-'));
  try {
    const credential = join(root, 'coordinator.token');
    await writeFile(credential, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const master: MasterConfig = { ...config(), credentialFile: credential };
    await writeDaemonState(master, emptyDaemonState(master));
    // Status reads the wall clock, so the item is observed now and submitted twenty minutes ago.
    const now = Date.now(), current = work({ observation: behind({ mergeable: false, at: new Date(now).toISOString() }), stageEnteredAt: new Date(now - 20 * 60_000).toISOString() });
    const masterApi = async (path: string) => path === 'work-snapshot' ? { work: [current], now: new Date(now).toISOString() } : { decisions: [] };
    const report = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: null });
    const raised = report.attentionItems.filter(entry => entry.subject === 'GY-166' && /no review request, no producer request, no rework request and no named external wait/.test(entry.text));
    assert.equal(raised.length, 1, JSON.stringify(report.attentionItems.map(entry => entry.text)));
    assert.match(raised[0].text, /missing actor: /);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:queue-ejection-reworked — a queued candidate ejected because its speculative merge conflicts is sent back through a rework decision naming the base tip, with an approver launched, in one cycle', async () => {
  const queued = work({ stage: 'merge', observation: observation(), queue: { sequence: 7, enqueuedAt: iso(-5 * 60_000), policyRevision: 1, speculation: null }, queueSequence: 7 } as Partial<Work>);
  assert.equal(routineDecision(queued, { autoMerge: true }, clock), null, 'a queued entry is the merge queue\'s');
  // The queue merges the predicted base into the branch; GitHub refuses the conflicting merge.
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used' });
  github.request = async (path: string, method = 'GET') => {
    if (path === '/merges' && method === 'POST') throw new Refusal('GitHub POST /merges failed (409): Merge conflict');
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const conflict = await github.mergeBranch('graphyard/gy-166-1', B2, 'Graphyard speculative tip for GY-166 behind main').catch(error => error);
  assert.ok(conflict instanceof SpeculativeConflict);
  // Ejected exactly as the engine ejects it (Engine.ejectFromQueue).
  const ejected = { ...queued, queue: null, queueEjection: { at, sequence: 7, reason: conflict.message, sha: H, policyRevision: 1 } } as Work;
  assert.equal(placeInQueue(ejected, [ejected], new Date(clock), [], true).queue, null, 'the same head never re-enters the queue');
  assert.equal(ejected.reworkRequested, false);

  const decision = routineDecision(ejected, { autoMerge: true }, clock);
  assert.equal(decision?.action, 'rework');
  assert.match(decision!.reason, /the merge queue ejected a1ffffffffff because its speculative merge onto base tip b2ffffffffff conflicts/);
  const { decided, approvers } = await reworkCycle(ejected);
  assert.deepEqual(decided.map(entry => entry.action), ['rework'], 'the rework decision is requested within one cycle');
  assert.match(decided[0].reason, /base tip b2ffffffffff/);
  assert.deepEqual(approvers, ['5d8a8b9e-0000-4000-8000-000000000191'], 'an independent approver is launched for it');

  // An ejection for another reason is not a conflict, and a new head is a new candidate.
  assert.equal(unresolvedBaseConflict({ ...ejected, queueEjection: { ...ejected.queueEjection!, reason: 'Pull request was closed without merging' } } as Work), null);
  assert.equal(unresolvedBaseConflict({ ...ejected, queueEjection: { ...ejected.queueEjection!, sha: sha40('c3') } } as Work), null);
});
