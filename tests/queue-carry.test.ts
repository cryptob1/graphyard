import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { processJob, type GitHub } from '../src/github.js';
import { predictQueue, queueRef, type QueuePlacement, type QueueSpeculation } from '../src/merge-queue.js';
import { carriedApproval, carryRefusal, currentCarry, decideCarry, describeQueueBinding, evaluate, evidenceBindsCandidate, type CarryInput, type Evidence, type Observation, type Principal, type TipMerge, type Work } from '../src/model.js';
import { assertReviewCandidate } from '../src/reviewer.js';
import { diagnose } from '../src/coordination.js';
import { buildMasterStatus, refuseStaleCarry, repostCarriedApproval, StaleCarriedApprovalError, type MasterConfig } from '../src/master.js';
import { mergeStep, repeatedMergeRefusalMs } from '../src/daemon/cycle-delivery.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { neededDecision } from '../src/daemon/decisions.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { refreshedCarriedApproval } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Each test is named for the proof it produces, so acceptance evidence maps to one executed
// case per required proof.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1'), P = sha40('c1'), TIP = sha40('d1');
const at = '2026-09-19T08:00:00.000Z';
const authored = (overrides: Partial<TipMerge> = {}): TipMerge => ({ from: H, parents: [H, P], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/other.ts', 'docs/other.md'], ...overrides });
const evidenceRecord = (proof: string, overrides: Partial<Evidence> = {}): Evidence => ({ id: `ev-${proof}`, proof, sha: H, baseSha: B, policyRevision: 1, producer: 'ci-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at, ...overrides });
function input(overrides: Partial<CarryInput> = {}): CarryInput {
  return { from: { sha: H, baseSha: B }, to: { sha: TIP, baseSha: P }, policyRevision: 1, at, merge: authored(), predecessor: { key: 'GY-1', validated: true },
    reviewedFiles: ['src/queue.ts', 'tests/queue.test.ts'], approval: { provider: 'github', reviewer: 'reviewer[bot]', sha: H, reviewId: 900 },
    proofs: [{ proof: 'unit:queue', evidence: evidenceRecord('unit:queue', { scopeFiles: ['src/queue.ts', 'tests/'] }) }, { proof: 'integration:docs', evidence: evidenceRecord('integration:docs', { id: 'ev-docs', scopeFiles: ['docs/'] }) }, { proof: 'manual:unscoped', evidence: evidenceRecord('manual:unscoped', { id: 'ev-manual' }) }, { proof: 'e2e:missing', evidence: undefined }],
    app: 'graphyard', ...overrides };
}
const states = (carry: ReturnType<typeof decideCarry>) => [carry.approval.carried, ...carry.evidence.map(entry => entry.carried)];

test('unit:queue-authored-tip-carry — approval and scope-disjoint evidence carry to a Graphyard-authored two-parent tip over the approved head and a validated predecessor', () => {
  const carry = decideCarry(input());
  assert.equal(carry.approval.carried, true);
  assert.deepEqual({ ...carry.approval, reason: undefined }, { carried: true, provider: 'github', reviewer: 'reviewer[bot]', sha: H, reviewId: 900, originalSha: H, reason: undefined });
  assert.match(carry.approval.reason, /GY-1 changed none of the 2 reviewed files/);
  assert.deepEqual(carry.evidence.map(entry => [entry.proof, entry.carried]), [['unit:queue', true], ['integration:docs', false], ['manual:unscoped', false], ['e2e:missing', false]]);
  assert.equal(carry.evidence[0].evidenceId, 'ev-unit:queue');
  assert.match(carry.evidence[1].reason, /changed docs\/other\.md inside the scope of evidence ev-docs; fresh evidence/);
  assert.match(carry.evidence[2].reason, /declares no scopeFiles, so its independence .* cannot be shown/);
  assert.match(carry.evidence[3].reason, /no trusted evidence was bound to the replaced head/);
  assert.deepEqual([carry.from, carry.to, carry.predecessor, carry.changedFiles], [{ sha: H, baseSha: B }, { sha: TIP, baseSha: P }, 'GY-1', ['src/other.ts', 'docs/other.md']]);
  // A predecessor that changed nothing relative to the bound base leaves the tested tree untouched.
  const untouched = decideCarry(input({ merge: authored({ baseChanges: [] }) }));
  assert.deepEqual(states(untouched), [true, true, true, true, false]);
  // The base branch itself is a validated predecessor.
  assert.equal(decideCarry(input({ predecessor: { key: null, validated: true } })).approval.carried, true);
});

test('unit:queue-authored-tip-carry — every refusal case requires fresh review and evidence, with the reason recorded', () => {
  const refused = (overrides: Partial<CarryInput>, pattern: RegExp) => {
    const carry = decideCarry(input(overrides));
    assert.deepEqual(states(carry), [false, false, false, false, false], pattern.source);
    assert.match(carry.approval.reason, pattern); for (const entry of carry.evidence) assert.match(entry.reason, pattern);
    assert.match(carryRefusal(input(overrides))!, pattern);
  };
  refused({ merge: null }, /was not produced by Graphyard's merge of the approved head/);
  refused({ merge: authored({ from: sha40('a9') }) }, /was not produced by Graphyard's merge of the approved head/);
  refused({ merge: authored({ parents: [H, P, sha40('e1')] }) }, /carries commits Graphyard did not produce/);
  refused({ merge: authored({ parents: [sha40('a9'), P] }) }, /rather than exactly the approved head/);
  refused({ merge: authored({ parents: [H] }) }, /carries commits Graphyard did not produce/);
  refused({ merge: authored({ authoredByApp: false, author: 'worker' }) }, /authored by worker, not by the graphyard App/);
  refused({ merge: authored({ conflicts: true }) }, /needed conflict resolution/);
  refused({ predecessor: { key: 'GY-1', validated: false } }, /predecessor GY-1 is not fully validated/);
  refused({ merge: authored({ baseChanges: null }) }, /could not be listed completely/);
  assert.equal(carryRefusal(input()), null);
  // Scope intersection is decided per binding: a touched reviewed file requires a fresh approval
  // while a disjoint proof still carries, and the other way round.
  const reviewed = decideCarry(input({ merge: authored({ baseChanges: ['src/queue.ts'] }) }));
  assert.equal(reviewed.approval.carried, false); assert.match(reviewed.approval.reason, /GY-1 changed reviewed files src\/queue\.ts; a fresh independent approval/);
  assert.deepEqual(reviewed.evidence.map(entry => entry.carried), [false, true, false, false], 'the proof scoped to the touched file is re-required; the docs proof carries');
  const unapproved = decideCarry(input({ approval: null }));
  assert.equal(unapproved.approval.carried, false); assert.match(unapproved.approval.reason, /no approval was bound to the replaced head/);
  assert.equal(unapproved.evidence[0].carried, true);
});

test('unit:queue-authored-tip-carry — a carried binding applies only to the exact tip and policy it was decided for, and only for the policy\'s provider', () => {
  const carry = decideCarry(input());
  const speculation: QueueSpeculation = { ref: queueRef('GY-2'), tip: TIP, base: P, baseTree: sha40('7e'), predecessors: ['GY-1'], policyRevision: 1, publishedAt: at, merge: authored(), carry };
  const work = { candidate: { sha: TIP, baseSha: P, pr: 2, branch: 'graphyard/gy-2-1', author: 'worker' }, policyRevision: 1, policy: { checks: ['test'], review: true }, queue: { sequence: 2, enqueuedAt: at, policyRevision: 1, speculation } } as unknown as Work;
  assert.equal(currentCarry(work), carry);
  assert.equal(carriedApproval(work)?.reviewer, 'reviewer[bot]');
  assert.equal(evidenceBindsCandidate(work, evidenceRecord('unit:queue')), true, 'the carried record binds the tip');
  assert.equal(evidenceBindsCandidate(work, evidenceRecord('integration:docs', { id: 'ev-docs' })), false, 'a re-required record does not');
  assert.equal(evidenceBindsCandidate(work, evidenceRecord('unit:queue', { id: 'ev-later' })), false, 'only the exact record the decision named');
  assert.equal(evidenceBindsCandidate(work, evidenceRecord('unit:queue', { sha: TIP, baseSha: P })), true, 'an exact binding always applies');
  assert.equal(currentCarry({ ...work, policyRevision: 2 }), null, 'a policy revision invalidates the carry');
  assert.equal(currentCarry({ ...work, candidate: { ...work.candidate!, sha: sha40('e9') } }), null, 'another head is not the tip');
  assert.equal(carriedApproval({ ...work, policy: { ...work.policy, reviewProvider: 'codex' } }), null, 'a GitHub approval is not a Codex verdict');
  const agent = { ...work, policy: { checks: ['test'], review: true, reviewProvider: 'agent', reviewerProfiles: [{ name: 'claude', runtime: 'claude', reviewerApp: 'claude-app', timeoutSeconds: 1800 }] },
    queue: { ...work.queue!, speculation: { ...speculation, carry: { ...carry, approval: { ...carry.approval, provider: 'agent', reviewerApp: 'claude-app' } } } } } as unknown as Work;
  assert.equal(carriedApproval(agent)?.reviewerApp, 'claude-app');
  assert.equal(carriedApproval({ ...agent, policy: { ...agent.policy, reviewerProfiles: [{ name: 'cursor', runtime: 'cursor', reviewerApp: 'cursor-app', timeoutSeconds: 1800 }] } } as Work), null, 'an agent approval carries only for the profile still dispatched');
});

test('unit:queue-real-base-tip — the review launcher refuses a candidate behind the real base tip that does not merge cleanly, and diagnose reports it', () => {
  const candidate = { sha: H, baseSha: B, pr: 7, branch: 'graphyard/gy-7-1', author: 'worker' };
  // GY-191: behind and mergeable is reviewed as it stands; only a head GitHub reports conflicting is refused.
  const mergeable = { key: 'GY-7', policy: { checks: [], review: true }, submission: { epoch: 1, pr: 7 }, candidate, reworkRequested: false,
    observation: { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], at, prState: 'open', draft: false, baseTip: sha40('b2'), baseTree: sha40('7b'), baseTipContained: false } } as unknown as Work;
  assert.equal(assertReviewCandidate(mergeable, at).sha, H, 'a mergeable head behind the base is reviewed');
  const observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: false, conflicting: true, protected: true, files: [], scopeFiles: [], at, prState: 'open', draft: false, baseTip: sha40('b2'), baseTree: sha40('7b'), baseTipContained: false } as Observation;
  const work = { key: 'GY-7', policy: { checks: [], review: true }, submission: { epoch: 1, pr: 7 }, candidate, observation, reworkRequested: false, ready: true, dependencies: [], workspaces: [], criteria: [], evidence: [], gates: [], violations: [], plannedFiles: [], scenarioRequirements: [] } as unknown as Work;
  assert.throws(() => assertReviewCandidate(work, at), new RegExp(`GY-7 candidate ${H.slice(0, 12)} does not contain the base branch tip ${sha40('b2').slice(0, 12)}; .* Run graphyard sync GY-7`));
  const behind = diagnose(work, [work], Date.parse(at)).find(entry => entry.kind === 'base-behind')!;
  assert.match(behind.message, new RegExp(`does not contain the base branch tip ${sha40('b2').slice(0, 12)}`));
  // Bringing the head onto the moved tip is the control plane's work now, not a worker sync round.
  assert.match(behind.next, /the reconciliation job merges the base into this branch/);
  work.observation = { ...observation, baseTipContained: true };
  assert.equal(assertReviewCandidate(work, at).sha, H);
  assert.equal(diagnose(work, [work], Date.parse(at)).some(entry => entry.kind === 'base-behind'), false);
});

const reviewerConfig = { repository: 'owner/project', reviewer: { slug: 'graphyard-reviewer', appId: 77, installationId: 78, credentialFile: '/nonexistent/reviewer.json', boundAt: at } } as MasterConfig;
test('unit:queue-authored-tip-carry — a carried GitHub approval is re-posted only through the reviewer App that gave it, bound to the tip, and never over a changed verdict', async () => {
  const work = { key: 'GY-2', candidate: { sha: TIP, baseSha: P, pr: 2, branch: 'graphyard/gy-2-1', author: 'worker' } } as Work;
  const carried = { carried: true as const, provider: 'github' as const, reviewer: 'graphyard-reviewer[bot]', sha: H, reviewId: 900, originalSha: H, reason: 'carried' };
  let reviews: any[] = [{ id: 900, user: { login: 'graphyard-reviewer[bot]' }, commit_id: H, state: 'DISMISSED' }];
  const posted: any[] = [];
  const fetcher = (async (_url: string, init: any) => { const body = JSON.parse(init.body); posted.push(body); return new Response(JSON.stringify({ id: 901, state: 'APPROVED', commit_id: body.commit_id, user: { login: 'graphyard-reviewer[bot]' } })); }) as unknown as typeof fetch;
  const dependencies = { run: () => JSON.stringify(reviews), mint: async () => ({ token: 'reviewer-token' }), fetcher };
  const result = await repostCarriedApproval(reviewerConfig, work, carried, dependencies);
  assert.deepEqual([result.posted, result.reviewId], [true, 901]);
  assert.deepEqual(posted, [{ commit_id: TIP, event: 'APPROVE', body: posted[0].body }]); assert.match(posted[0].body, new RegExp(`carried this identity's approval of ${H} \\(review 900\\) to Graphyard-authored merge-queue tip ${TIP}`));
  reviews = [...reviews, { id: 901, user: { login: 'graphyard-reviewer[bot]' }, commit_id: TIP, state: 'APPROVED' }];
  assert.equal((await repostCarriedApproval(reviewerConfig, work, carried, dependencies)).posted, false, 'already approved on the tip');
  reviews = [reviews[0], { id: 902, user: { login: 'graphyard-reviewer[bot]' }, commit_id: TIP, state: 'CHANGES_REQUESTED' }];
  await assert.rejects(repostCarriedApproval(reviewerConfig, work, carried, dependencies), /requested changes after approving/);
  reviews = [];
  await assert.rejects(repostCarriedApproval(reviewerConfig, work, carried, dependencies), /is no longer on the pull request/);
  const human = await repostCarriedApproval(reviewerConfig, work, { ...carried, reviewer: 'alice' }, dependencies);
  assert.equal(human.posted, false); assert.match(human.reason, /posted by alice, not by the bound reviewer App graphyard-reviewer\[bot\]/);
  assert.equal((await repostCarriedApproval(reviewerConfig, work, { ...carried, provider: 'codex' }, dependencies)).posted, false);
  assert.equal(posted.length, 1, 'exactly one review was ever posted');
});

// ---- Engine integration: a real Postgres, a stubbed provider -----------------------------------

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:queue', 'unit:docs'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 500;
before(async () => {
  const port = Number(process.env.GRAPHYARD_QUEUE_CARRY_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 16);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('queue-carry'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const input2 = { title: 'Queue carry', plannedFiles: ['src/queue.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:queue', 'unit:docs'] }] };
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
/** Ledger entries of one kind, oldest first. */
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind).reverse();
/** The tree a commit holds in these scenarios; a merge commit's tree is set where the scenario makes it. */
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);
const gate = (work: Work, name: string) => work.gates.find(entry => entry.name === name)!;
async function submitted(title = 'Queue carry') {
  let work = await engine.execute(operator, 'create', null, { ...input2, title }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/carry/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr: ++pr }, randomUUID());
}
function tip(work: Work, candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true,
    files: ['src/queue.ts', 'tests/queue.test.ts'], scopeFiles: [], at: new Date().toISOString(), ...extra };
}
/** A candidate approved and proven on its own head, with every proof declaring its scope. */
async function validated(work: Work, candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}) {
  let observed = await engine.observe(work.id, work.revision, tip(work, candidate, extra));
  observed = await engine.execute(producer, 'evidence', observed.id, { proof: 'unit:queue', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/queue.ts', 'tests/'] }, randomUUID());
  return engine.execute(producer, 'evidence', observed.id, { proof: 'unit:docs', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, result: 'pass', executed: 2, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['docs/'] }, randomUUID());
}
async function onlyJob(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
}
function adapter(observation: (work: Work) => Observation, speculation: ((work: Work, placement: QueuePlacement) => QueueSpeculation) | null) {
  const seen: { key: string; base: string | null }[] = [], requested: string[] = [];
  return { seen, requested, github: {
    observe: async (work: Work) => observation(work),
    publishSpeculativeTip: async (work: Work, placement: QueuePlacement) => {
      if (!speculation) throw new Error(`${work.key} must not republish its tip`);
      seen.push({ key: work.key, base: placement.predictedBase }); return speculation(work, placement);
    },
    requestCodex: async (work: Work) => { requested.push(work.candidate!.sha); throw new Error('no review request expected'); },
    publish: async () => {},
  } as unknown as GitHub };
}
const published = (work: Work, placement: QueuePlacement, tipSha: string, merge: TipMerge | null): QueueSpeculation =>
  ({ ref: queueRef(work.key), tip: tipSha, base: placement.predictedBase!, baseTree: treeOf(placement.predictedBase!), predecessors: placement.predecessors, policyRevision: work.policyRevision, publishedAt: new Date().toISOString(), merge });
async function placementOf(work: Work) { return predictQueue(await store.list(), Date.now()).find(entry => entry.id === work.id)!; }
async function clearQueue() { await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE document->>'stage'<>'done'"); }
/** The head lands through the broker exactly as the master does it, and Graphyard observes the merge. */
async function mergeHead(work: Work, candidate: { sha: string; baseSha: string }, mergeSha: string) {
  const current = await reload(work);
  const committed = await engine.requestEnqueue(coordinator, current.id, { enqueue: true, expectedRevision: current.revision, sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: current.policyRevision }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  return engine.observe(current.id, committed.revision, tip(current, candidate, { merged: true, mergeSha, mergedAt }));
}

test('integration:queue-follower-no-rebind — a follower whose predicted base changes to a tree-identical commit keeps its tip and every binding, and the ledger records the carried base', async () => {
  await clearQueue();
  const main = sha40('11'), mainTree = sha40('7111'), headA = sha40('12'), headB = sha40('13'), tipB = sha40('14'), mergedA = sha40('15');
  let first = await submitted('Carry head'), second = await submitted('Carry follower');
  first = await validated(first, { sha: headA, baseSha: main }); second = await validated(second, { sha: headB, baseSha: main });
  // The head publishes its own head as the tip; the follower's tip is Graphyard's merge over it.
  await onlyJob(first);
  await processJob(engine, adapter(work => tip(work, { sha: headA, baseSha: main }), (work, placement) => published(work, placement, headA, null)).github);
  await onlyJob(second);
  const follower = adapter(work => tip(work, { sha: headB, baseSha: main }), (work, placement) => published(work, placement, tipB, { from: headB, parents: [headB, headA], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/head.ts'] }));
  await processJob(engine, follower.github);
  assert.deepEqual(follower.seen, [{ key: second.key, base: headA }]);
  second = await engine.observe(second.id, (await reload(second)).revision, tip(second, { sha: tipB, baseSha: headA }, { baseTip: main, baseTree: mainTree, reviews: [] }));
  assert.ok(second.gates.filter(entry => entry.name !== 'merge').every(entry => entry.passed), second.gates.flatMap(entry => entry.reasons).join('; '));
  const bindingsBefore = { evidence: second.evidence.map(entry => entry.id), speculation: second.queue!.speculation!.tip, candidate: second.candidate };
  // The head merges with merge_method=merge: main becomes a new commit whose tree is the head's validated tree.
  first = await mergeHead(first, { sha: headA, baseSha: main }, mergedA);
  assert.equal(first.stage, 'done');
  await onlyJob(second);
  const settled = adapter(work => tip(work, { sha: tipB, baseSha: headA }, { baseTip: mergedA, baseTree: treeOf(headA), reviews: [] }), null);
  await processJob(engine, settled.github);
  second = await reload(second);
  assert.deepEqual(settled.seen, [], 'nothing was republished');
  const placement = await placementOf(second);
  assert.deepEqual([placement.position, placement.current, placement.binding, placement.predictedBase, placement.tip], [0, true, 'tree-equivalent', mergedA, tipB]);
  assert.equal(second.queue!.speculation!.tip, bindingsBefore.speculation, 'the published tip is kept');
  assert.deepEqual(second.candidate, bindingsBefore.candidate, 'the candidate binding is kept');
  assert.deepEqual(second.evidence.map(entry => entry.id), bindingsBefore.evidence, 'no evidence was added or required');
  assert.ok(second.gates.every(entry => entry.passed), second.gates.flatMap(entry => entry.reasons).join('; '));
  assert.deepEqual(second.queue!.speculation!.carriedBase && { sha: second.queue!.speculation!.carriedBase.sha, tree: second.queue!.speculation!.carriedBase.tree }, { sha: mergedA, tree: treeOf(headA) });
  const carriedBase = await events(second, 'queue.base-carried');
  assert.equal(carriedBase.length, 1);
  assert.deepEqual({ ...carriedBase[0].payload.details, at: undefined }, { tip: tipB, boundBase: headA, baseTree: treeOf(headA), baseTip: mergedA, at: undefined });
  assert.equal(second.mergeAuthorization!.baseSha, headA, 'the authorization names the validated base; the landing is checked by tree');
  assert.equal(describeQueueBinding(second, await store.list(), new Date())!.base.carriedTo!.sha, mergedA);
});

test('integration:queue-carry-refusals — a foreign author, extra parents, an unvalidated predecessor and a scope intersection each require fresh review or evidence for exactly what they touch', async () => {
  await clearQueue();
  const main = sha40('21'), headA = sha40('22'), headB = sha40('23'), tipB = sha40('24');
  let first = await submitted('Refusal head'), second = await submitted('Refusal follower');
  first = await validated(first, { sha: headA, baseSha: main }); second = await validated(second, { sha: headB, baseSha: main });
  await onlyJob(first);
  await processJob(engine, adapter(work => tip(work, { sha: headA, baseSha: main }), (work, placement) => published(work, placement, headA, null)).github);
  const graphyard = { from: headB, parents: [headB, headA], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/head.ts'] };
  const attempt = async (merge: TipMerge | null, invalidate = false) => {
    if (invalidate) await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{gates}',$2::jsonb) WHERE id=$1", [first.id, JSON.stringify([{ name: 'test', passed: false, reasons: ['Required CI check test has not passed on the current candidate'] }])]);
    await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE id=$1", [second.id]);
    second = await engine.observe(second.id, (await reload(second)).revision, tip(second, { sha: headB, baseSha: main }));
    await onlyJob(second);
    await processJob(engine, adapter(work => tip(work, { sha: headB, baseSha: main }), (work, placement) => published(work, placement, tipB, merge)).github);
    if (invalidate) await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{gates}',$2::jsonb) WHERE id=$1", [first.id, JSON.stringify((await reload(first)).gates.filter(entry => entry.name !== 'test'))]);
    second = await engine.observe(second.id, (await reload(second)).revision, tip(second, { sha: tipB, baseSha: headA }, { baseTip: main, reviews: [] }));
    const carry = second.queue!.speculation!.carry!;
    return { carry, review: gate(second, 'review').passed, acceptance: gate(second, 'acceptance'), binding: describeQueueBinding(second, await store.list(), new Date())! };
  };
  const foreign = await attempt({ ...graphyard, author: 'worker', authoredByApp: false });
  assert.deepEqual([foreign.carry.approval.carried, ...foreign.carry.evidence.map(entry => entry.carried)], [false, false, false]);
  assert.match(foreign.carry.approval.reason, /authored by worker, not by the control-plane \(App 1234\) App/);
  assert.equal(foreign.review, false); assert.equal(foreign.acceptance.passed, false);
  assert.deepEqual([foreign.binding.approval.state, ...foreign.binding.evidence.map(entry => entry.state)], ['required', 'required', 'required']);
  const extra = await attempt({ ...graphyard, parents: [headB, headA, sha40('29')] });
  assert.match(extra.carry.approval.reason, /carries commits Graphyard did not produce/); assert.equal(extra.review, false);
  const unvalidated = await attempt(graphyard, true);
  assert.match(unvalidated.carry.approval.reason, new RegExp(`predecessor ${first.key} is not fully validated`)); assert.equal(unvalidated.review, false);
  const intersecting = await attempt({ ...graphyard, baseChanges: ['docs/queue.md'] });
  assert.equal(intersecting.carry.approval.carried, true, 'the predecessor touched no reviewed file');
  assert.deepEqual(intersecting.carry.evidence.map(entry => [entry.proof, entry.carried]), [['unit:queue', true], ['unit:docs', false]]);
  assert.equal(intersecting.review, true); assert.equal(intersecting.acceptance.passed, false);
  assert.deepEqual(intersecting.acceptance.reasons, ['AC-1: unit:docs needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy']);
  assert.deepEqual([intersecting.binding.approval.state, ...intersecting.binding.evidence.map(entry => [entry.proof, entry.state])], ['carried', ['unit:queue', 'carried'], ['unit:docs', 'required']]);
  assert.match(intersecting.binding.evidence[1].reason, /changed docs\/queue\.md inside the scope of evidence/);
  const reviewed = await attempt({ ...graphyard, baseChanges: ['tests/queue.test.ts'] });
  assert.equal(reviewed.carry.approval.carried, false); assert.match(reviewed.carry.approval.reason, /changed reviewed files tests\/queue\.test\.ts; a fresh independent approval/);
  assert.equal(reviewed.review, false);
  assert.deepEqual(reviewed.carry.evidence.map(entry => entry.carried), [false, true], 'the proof scoped to tests/ is re-required; the docs proof carries');
  // Every decision is in the ledger, and diagnose names each required binding with its reason.
  const decisions = await events(second, 'queue.carry');
  assert.equal(decisions.length, 5);
  assert.deepEqual(decisions.map(event => event.payload.details.approval.carried), [false, false, false, true, false]);
  const diagnostics = diagnose(second, await store.list(), Date.now());
  assert.match(diagnostics.find(entry => entry.kind === 'queue-binding-required')!.message, /Approval is required afresh for tip .*: .* changed reviewed files/);
  assert.ok(diagnostics.some(entry => entry.kind === 'queue-binding-carried' && /Proof unit:docs carried/.test(entry.message)));
});

test('integration:queue-follower-merges-once — a follower behind a merged predecessor merges with no additional review or proof round', async () => {
  await clearQueue();
  const main = sha40('31'), headA = sha40('32'), headB = sha40('33'), tipB = sha40('34'), mergedA = sha40('35'), mergedB = sha40('36');
  let first = await submitted('Once head'), second = await submitted('Once follower');
  first = await validated(first, { sha: headA, baseSha: main }); second = await validated(second, { sha: headB, baseSha: main });
  await onlyJob(first);
  await processJob(engine, adapter(work => tip(work, { sha: headA, baseSha: main }), (work, placement) => published(work, placement, headA, null)).github);
  await onlyJob(second);
  const follower = adapter(work => tip(work, { sha: headB, baseSha: main }), (work, placement) => published(work, placement, tipB, { from: headB, parents: [headB, headA], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/head.ts'] }));
  await processJob(engine, follower.github);
  const evidenceCount = (await reload(second)).evidence.length;
  // GitHub dismissed the approval on Graphyard's own push; the required checks ran on the tip.
  await onlyJob(second);
  const onTip = adapter(work => tip(work, { sha: tipB, baseSha: headA }, { baseTip: main, reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: headB, state: 'DISMISSED' }] }), null);
  await processJob(engine, onTip.github);
  second = await reload(second);
  assert.deepEqual(onTip.requested, [], 'no review was requested for the tip');
  assert.equal(second.evidence.length, evidenceCount, 'no proof was requested or produced for the tip');
  assert.equal(gate(second, 'review').passed, true); assert.equal(gate(second, 'acceptance').passed, true); assert.equal(gate(second, 'test').passed, true);
  assert.match(gate(second, 'merge').reasons.join(' '), /position 2 of 2/, 'the follower waits only for its turn');
  const carry = second.queue!.speculation!.carry!;
  assert.deepEqual([carry.approval.carried, ...carry.evidence.map(entry => entry.carried)], [true, true, true]);
  first = await mergeHead(first, { sha: headA, baseSha: main }, mergedA);
  assert.equal(first.stage, 'done');
  second = await engine.observe(second.id, (await reload(second)).revision, tip(second, { sha: tipB, baseSha: headA }, { baseTip: mergedA, baseTree: treeOf(headA), reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: headB, state: 'DISMISSED' }] }));
  assert.ok(second.gates.every(entry => entry.passed), second.gates.flatMap(entry => entry.reasons).join('; '));
  assert.deepEqual([second.mergeAuthorization!.sha, second.mergeAuthorization!.baseSha], [tipB, headA]);
  // manual:queue-carry-status — master status shows the binding was carried and why.
  const status = buildMasterStatus(await store.workSnapshot(), [], []);
  const row = status.queue.find(entry => entry.key === second.key)!;
  assert.deepEqual([row.position, row.validated, row.binding!.base.binding, row.binding!.base.carriedTo!.sha], [1, true, 'tree-equivalent', mergedA]);
  assert.deepEqual([row.binding!.approval.state, row.binding!.approval.reviewer, row.binding!.approval.originalSha], ['carried', 'graphyard-reviewer[bot]', headB]);
  assert.deepEqual(row.binding!.evidence.map(entry => [entry.proof, entry.state]), [['unit:queue', 'carried'], ['unit:docs', 'carried']]);
  assert.match(row.binding!.approval.reason, /carried to Graphyard-authored tip/);
  const diagnostics = diagnose(second, await store.list(), Date.now());
  assert.equal(diagnostics.filter(entry => entry.kind === 'queue-binding-carried').length, 3);
  assert.equal(diagnostics.some(entry => entry.kind === 'queue-binding-required'), false);
  assert.equal(diagnostics.some(entry => entry.kind === 'queue-base-carried'), true);
  second = await mergeHead(second, { sha: tipB, baseSha: headA }, mergedB);
  assert.equal(second.stage, 'done'); assert.deepEqual(second.violations, []);
  assert.equal(second.evidence.length, evidenceCount, 'the whole landing took one review and one proof round');
  assert.deepEqual((await events(second, 'queue.predicted')).at(-1)!.payload.details.carry, { approval: 'carried', evidence: { 'unit:queue': 'carried', 'unit:docs': 'carried' } });
});

test('integration:queue-carry-refusals — a revoked original proof withdraws its carried binding and ejects the tip; a fresh proof on the tip stands on its own', async () => {
  await clearQueue();
  const main = sha40('41'), headA = sha40('42'), headB = sha40('43'), tipB = sha40('44');
  let first = await submitted('Revoke head'), second = await submitted('Revoke follower');
  first = await validated(first, { sha: headA, baseSha: main }); second = await validated(second, { sha: headB, baseSha: main });
  await onlyJob(first);
  await processJob(engine, adapter(work => tip(work, { sha: headA, baseSha: main }), (work, placement) => published(work, placement, headA, null)).github);
  await onlyJob(second);
  await processJob(engine, adapter(work => tip(work, { sha: headB, baseSha: main }), (work, placement) => published(work, placement, tipB, { from: headB, parents: [headB, headA], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/head.ts'] })).github);
  second = await engine.observe(second.id, (await reload(second)).revision, tip(second, { sha: tipB, baseSha: headA }, { baseTip: main, reviews: [] }));
  assert.equal(gate(second, 'acceptance').passed, true);
  second = await engine.execute(operator, 'revoke', second.id, { proof: 'unit:queue', sha: headB, baseSha: main, policyRevision: 1, reason: 'the run was misattributed' }, randomUUID());
  assert.equal(gate(second, 'acceptance').passed, false);
  assert.match(gate(second, 'acceptance').reasons[0], /unit:queue needs trusted passing evidence.*previously accepted evidence was revoked/);
  assert.equal(second.queue, null, 'a withdrawn proof is an adverse conclusion about the tip it was carried to');
  assert.match(second.queueEjection!.reason, /Proof unit:queue was revoked on speculative tip/);
  assert.equal(evaluate(second, [second], new Date(), [15368]).queue, null, 'the ejected tip cannot re-enter');
});

// ---- GY-831: a queue head whose carried approval is stale is re-reviewed or re-bound ----------

/** A queued tip over reviewed head H whose carried approval names review 800 of an earlier pull request's commit. */
const OLD = sha40('0d1');
function staleCarry(reviews: Observation['reviews'] = []) {
  const carry = decideCarry(input());
  carry.approval = { carried: true, provider: 'github', reviewer: 'graphyard-reviewer[bot]', sha: OLD, reviewId: 800, originalSha: OLD, reason: 'carried from the earlier pull request' };
  const speculation: QueueSpeculation = { ref: queueRef('GY-470'), tip: TIP, base: P, baseTree: sha40('7e'), predecessors: ['GY-1'], policyRevision: 1, publishedAt: at, merge: authored(), reviewedHead: H, carry };
  const candidate = { sha: TIP, baseSha: P, pr: 371, branch: 'graphyard/gy-470-2', author: 'worker' };
  return { key: 'GY-470', candidate, policyRevision: 1, policy: { checks: ['test'], review: true }, queue: { sequence: 1, enqueuedAt: at, policyRevision: 1, speculation },
    observation: { candidate, reviews, checks: [], merged: false, mergeSha: null, protected: true, mergeable: true, files: [], scopeFiles: [], at, prState: 'open', draft: false } } as unknown as Work;
}

test('unit:carried-approval-rebinds — a carried binding from an earlier pull request is re-posted as the bound reviewer\'s current approval of the head the tip was built from, and a newer approval of that head refreshes the binding', async () => {
  const work = staleCarry(), carried = carriedApproval(work)!;
  assert.equal(carried.originalSha, OLD);
  // GitHub holds no review 800 on this pull request: only the reviewer's approval of the reviewed head H.
  let reviews: any[] = [{ id: 5327788286, user: { login: 'graphyard-reviewer[bot]' }, commit_id: H, state: 'APPROVED' }];
  const posted: any[] = [];
  const fetcher = (async (_url: string, init: any) => { const body = JSON.parse(init.body); posted.push(body); return new Response(JSON.stringify({ id: 5327788300, state: 'APPROVED', commit_id: body.commit_id, user: { login: 'graphyard-reviewer[bot]' } })); }) as unknown as typeof fetch;
  const dependencies = { run: () => JSON.stringify(reviews), mint: async () => ({ token: 'reviewer-token' }), fetcher };
  const result = await repostCarriedApproval(reviewerConfig, work, carried, dependencies);
  assert.deepEqual([result.posted, result.reviewId], [true, 5327788300]);
  assert.match(result.reason, new RegExp(`re-posted the carried approval of ${H.slice(0, 12)} \\(review 5327788286, re-bound from the reviewed head\\)`));
  assert.deepEqual([posted.length, posted[0].commit_id, posted[0].event], [1, TIP, 'APPROVE'], 'the approval is re-posted on the tip');
  assert.match(posted[0].body, new RegExp(`approval of ${H} \\(review 5327788286\\) to Graphyard-authored merge-queue tip ${TIP}`));
  assert.doesNotMatch(posted[0].body, new RegExp(`approval of ${OLD}`), 'the stale binding is not what is re-posted');
  // An approval of another commit is not the reviewed head's: nothing may be re-posted, and the refusal is typed as stale.
  reviews = [{ id: 5327788286, user: { login: 'graphyard-reviewer[bot]' }, commit_id: sha40('0e1'), state: 'APPROVED' }];
  await assert.rejects(repostCarriedApproval(reviewerConfig, work, carried, dependencies), (error: Error) => error instanceof StaleCarriedApprovalError && /is no longer on the pull request, and graphyard-reviewer\[bot\] has not approved the reviewed head/.test(error.message));
  // A changed verdict is never replaced.
  reviews = [{ id: 5327788286, user: { login: 'graphyard-reviewer[bot]' }, commit_id: H, state: 'APPROVED' }, { id: 5327788290, user: { login: 'graphyard-reviewer[bot]' }, commit_id: H, state: 'CHANGES_REQUESTED' }];
  await assert.rejects(repostCarriedApproval(reviewerConfig, work, carried, dependencies), /requested changes after approving/);
  assert.equal(posted.length, 1);

  // The record refreshes the binding as soon as an observation shows the newer approval of H,
  // dismissed by GitHub on the tip push or not; a later change request refreshes nothing.
  const dismissed = staleCarry([{ id: 5327788286, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'DISMISSED', dismissal: { verdict: 'approved', mergeBase: true } } as Observation['reviews'][number]]);
  const refreshed = refreshedCarriedApproval(dismissed)!;
  assert.deepEqual([refreshed.carried, refreshed.reviewer, refreshed.reviewId, refreshed.originalSha, refreshed.sha], [true, 'graphyard-reviewer[bot]', 5327788286, H, H]);
  assert.match(refreshed.reason, new RegExp(`approval of ${H.slice(0, 12)} by graphyard-reviewer\\[bot\\] \\(review 5327788286\\), the head tip ${TIP.slice(0, 12)} was built from, replaces the carried approval of ${OLD.slice(0, 12)}`));
  // A dismissal that is not from mergeBase (manually dismissed) does not refresh the binding.
  assert.equal(refreshedCarriedApproval(staleCarry([{ id: 5327788286, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'DISMISSED', dismissal: { verdict: 'approved', mergeBase: false } } as Observation['reviews'][number]])), null, 'a deliberately dismissed approval does not re-bind');
  assert.equal(refreshedCarriedApproval(staleCarry([{ id: 5327788286, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'APPROVED' }, { id: 5327788290, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'CHANGES_REQUESTED' }])), null);
  assert.equal(refreshedCarriedApproval(staleCarry([{ id: 700, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'APPROVED' }])), null, 'an older approval is not newer than the binding');
  assert.equal(refreshedCarriedApproval(staleCarry([{ id: 5327788286, reviewer: 'someone-else', sha: H, state: 'APPROVED' }])), null, 'only the carried reviewer re-binds its own approval');
  // Once refreshed, the re-post finds the binding's own review and needs no fallback.
  const bound = { ...carried, ...refreshed };
  reviews = [{ id: 5327788286, user: { login: 'graphyard-reviewer[bot]' }, commit_id: H, state: 'DISMISSED' }];
  const again = await repostCarriedApproval(reviewerConfig, work, bound, dependencies);
  assert.equal(again.posted, true); assert.match(posted[1].body, new RegExp(`approval of ${H} \\(review 5327788286\\)`));
});

test('unit:stale-carried-approval-rereviewed — one refused re-post clears the carried approval, the review gate requests a fresh review of the tip, and the next entry heads the queue', async () => {
  await clearQueue();
  const main = sha40('51'), headA = sha40('52'), headB = sha40('53'), tipB = sha40('54'), mergedA = sha40('55'), headC = sha40('56'), tipC = sha40('57');
  let first = await submitted('Stale head'), second = await submitted('Stale carried'), third = await submitted('Stale follower');
  first = await validated(first, { sha: headA, baseSha: main }); second = await validated(second, { sha: headB, baseSha: main }); third = await validated(third, { sha: headC, baseSha: main });
  await onlyJob(first);
  await processJob(engine, adapter(work => tip(work, { sha: headA, baseSha: main }), (work, placement) => published(work, placement, headA, null)).github);
  await onlyJob(second);
  await processJob(engine, adapter(work => tip(work, { sha: headB, baseSha: main }), (work, placement) => published(work, placement, tipB, { from: headB, parents: [headB, headA], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/head.ts'] })).github);
  const dismissed = [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: headB, state: 'DISMISSED' }];
  second = await engine.observe(second.id, (await reload(second)).revision, tip(second, { sha: tipB, baseSha: headA }, { baseTip: main, reviews: dismissed }));
  first = await mergeHead(first, { sha: headA, baseSha: main }, mergedA);
  assert.equal(first.stage, 'done');
  second = await engine.observe(second.id, (await reload(second)).revision, tip(second, { sha: tipB, baseSha: headA }, { baseTip: mergedA, baseTree: treeOf(headA), reviews: dismissed }));
  assert.ok(second.gates.every(entry => entry.passed), second.gates.flatMap(entry => entry.reasons).join('; '));
  assert.equal(carriedApproval(second)?.reviewId, 41, 'the head stands on a carried approval');
  await onlyJob(third);
  await processJob(engine, adapter(work => tip(work, { sha: headC, baseSha: main }), (work, placement) => published(work, placement, tipC, { from: headC, parents: [headC, tipB], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/head.ts'] })).github);
  assert.equal((await placementOf(second)).position, 0, 'the carried item heads the queue');
  assert.equal((await placementOf(third)).position, 1, 'the next entry waits behind it');

  // The re-post finds neither the carried review nor an approval of the reviewed head on the pull request.
  second = await reload(second);
  const failure = await repostCarriedApproval(reviewerConfig, second, carriedApproval(second)!, { run: () => '[]', mint: async () => ({ token: 'reviewer-token' }), fetcher: (async () => { throw new Error('nothing may be posted'); }) as unknown as typeof fetch }).catch(error => error);
  assert.ok(failure instanceof StaleCarriedApprovalError, String(failure));
  const reported: string[] = [];
  const mutation = async (path: string, data: unknown, requestId?: string) => { reported.push(path); return engine.execute(coordinator, 'mergerefused', second.id, data, requestId ?? randomUUID()); };
  await assert.rejects(refuseStaleCarry(second, failure, mutation, (item, step) => `${item.id}:${step}`), /Graphyard cleared the carried approval: the review gate requests a fresh review of tip .*, and the next queue entry heads the queue meanwhile/);
  assert.deepEqual(reported, [`work/${second.id}/mergerefused`], 'one refused re-post is reported once');

  second = await reload(second);
  assert.equal(carriedApproval(second), null, 'the carried approval is cleared');
  assert.deepEqual(second.mergeRefusal?.approval, { reviewer: 'graphyard-reviewer[bot]', reviewId: 41, originalSha: headB }, 'the refusal names the review it could not re-post');
  assert.equal(gate(second, 'review').passed, false);
  assert.deepEqual([second.autoDispatch?.review?.state, second.autoDispatch?.review?.sha], ['requested', tipB], 'the review gate requests a fresh review of the tip at once');
  assert.deepEqual([second.mergeRefusal?.action, second.mergeRefusal?.sha], ['rereview', tipB]);
  assert.equal(second.queue, null, 'the refused item leaves the queue head');
  assert.equal((await placementOf(third)).position, 0, 'the next entry heads the queue');
  // The same dismissed review is not restored over the refusal on the next observation.
  second = await engine.observe(second.id, second.revision, tip(second, { sha: tipB, baseSha: headA }, { baseTip: mergedA, baseTree: treeOf(headA), reviews: dismissed }));
  assert.equal(carriedApproval(second), null);
  assert.equal(second.queue, null, 'and the entry stays out of the queue');
  // A fresh approval of the tip answers the refusal: the entry re-enters, behind the new head.
  second = await engine.observe(second.id, second.revision, tip(second, { sha: tipB, baseSha: headA }, { baseTip: mergedA, baseTree: treeOf(headA), reviews: [...dismissed, { id: 99, reviewer: 'graphyard-reviewer[bot]', sha: tipB, state: 'APPROVED' }] }));
  assert.equal(gate(second, 'review').passed, true);
  assert.ok(second.queue, 'the answered entry re-enters the queue');
  assert.ok(second.queue!.sequence > (await reload(third)).queue!.sequence, 'at the back, behind the entry that took the head');
  // Nor is a merge refusal reported for a candidate that has since moved.
  await assert.rejects(engine.execute(coordinator, 'mergerefused', second.id, { sha: headB, baseSha: main, policyRevision: 1, reason: 'stale' }, randomUUID()), /candidate changed since the refused merge/);
});

test('unit:repeated-merge-refusal-acted — a guarded merge refused for the same reason past ten minutes raises attention naming the reason and the next step, and the loop acts on it once', async () => {
  await clearQueue();
  const main = sha40('61'), headA = sha40('62');
  let item = await submitted('Repeated refusal');
  item = await validated(item, { sha: headA, baseSha: main });
  // The loop's view: every gate passes, so the guarded merge is retried on its short pause.
  const view = (work: Work) => ({ ...work, stage: 'merge', gates: work.gates.map(entry => ({ ...entry, passed: true, reasons: [] })), violations: [] }) as Work;
  let clock = Date.parse('2031-03-01T09:00:00Z');
  const master = { url: 'https://graphyard.example', repository: 'owner/project', autoMerge: true } as MasterConfig;
  const state = emptyDaemonState(master);
  const reported: { reason: string; since: string }[] = [];
  let reason = 'the base branch main advanced outside the merge queue';
  const effects = {
    snapshot: async () => ({ work: [view(await reload(item))], now: new Date(clock).toISOString() }),
    persist: async () => {},
    merge: async () => { throw new Error(`${item.key} merge refused: ${reason}`); },
    refuseMerge: async (work: Work, text: string, since: string) => { reported.push({ reason: text, since }); return engine.execute(coordinator, 'mergerefused', work.id, { sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision, reason: text, since }, randomUUID()); },
  };
  const cycle = async () => {
    state.cycle++;
    const open = [view(await reload(item))], performed: Cycle['performed'] = [];
    await mergeStep({ config: master, state, effects, now: () => clock, performed, open, isolate: async (_kind: unknown, _item: unknown, _name: unknown, body: () => Promise<unknown>) => body() } as unknown as Cycle);
    return performed;
  };
  const repeated = () => Object.entries(state.actions).filter(([key]) => key.includes(':repeated')).map(([, action]) => action);
  const start = clock;
  // A changed reason restarts the count.
  await cycle(); clock += 61_000; reason = 'the pull request changed on GitHub before merge'; const restart = clock;
  while (clock - restart < repeatedMergeRefusalMs - 61_000) { await cycle(); clock += 61_000; }
  assert.deepEqual([reported.length, repeated().length], [0, 0], 'nothing is acted on inside ten minutes of the same reason');
  assert.ok(clock - start >= repeatedMergeRefusalMs, 'though the refusals together have run past ten minutes');
  while (!reported.length && clock - restart < 2 * repeatedMergeRefusalMs) { await cycle(); clock += 61_000; }
  assert.equal(reported.length, 1, 'the loop acts without a hand action');
  assert.match(reported[0].reason, /merge refused: the pull request changed on GitHub before merge/);
  assert.equal(reported[0].since, new Date(restart).toISOString(), 'the refusal is dated from the first attempt that gave this reason');
  const [attention] = repeated();
  assert.equal(attention.kind, 'escalation'); assert.equal(attention.state, 'done');
  assert.match(attention.detail, new RegExp(`${item.key}: the guarded merge has refused candidate ${headA.slice(0, 12)} on every attempt for 1\\d minutes with the same reason: .*changed on GitHub before merge\\. Next step: Graphyard marks candidate ${headA.slice(0, 12)} for a rework decision the approver judges, and the next queue entry heads the queue meanwhile\\.`));
  // The control plane recorded it, and the loop's own decision step now asks for the rework.
  item = await reload(item);
  assert.deepEqual([item.mergeRefusal?.action, item.mergeRefusal?.sha, item.mergeRefusal?.since], ['rework', headA, new Date(restart).toISOString()]);
  const decision = neededDecision(item, { autoMerge: true });
  assert.deepEqual([decision?.action, decision?.binding], ['rework', `${headA}:merge-refused`]);
  assert.match(decision!.reason, /refused candidate .* on every attempt since .* with the same reason: .*changed on GitHub before merge/);
  // Acted on once per candidate and reason.
  for (let pass = 0; pass < 3; pass++) { await cycle(); clock += 61_000; }
  assert.equal(reported.length, 1);
});

test('unit:repeated-merge-refusal-acted — a rereview that a fresh approval answers re-arms the same refusal, and the loop then takes the rework action', async () => {
  await clearQueue();
  const main = sha40('71'), headA = sha40('72'), headB = sha40('73'), tipB = sha40('74'), mergedA = sha40('75');
  let first = await submitted('Re-arm first'), item = await submitted('Re-arm carried');
  first = await validated(first, { sha: headA, baseSha: main }); item = await validated(item, { sha: headB, baseSha: main });
  await onlyJob(first);
  await processJob(engine, adapter(work => tip(work, { sha: headA, baseSha: main }), (work, placement) => published(work, placement, headA, null)).github);
  await onlyJob(item);
  await processJob(engine, adapter(work => tip(work, { sha: headB, baseSha: main }), (work, placement) => published(work, placement, tipB, { from: headB, parents: [headB, headA], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/head.ts'] })).github);
  const dismissed = [{ id: 42, reviewer: 'graphyard-reviewer[bot]', sha: headB, state: 'DISMISSED' }];
  item = await engine.observe(item.id, (await reload(item)).revision, tip(item, { sha: tipB, baseSha: headA }, { baseTip: main, reviews: dismissed }));
  first = await mergeHead(first, { sha: headA, baseSha: main }, mergedA);
  item = await engine.observe(item.id, (await reload(item)).revision, tip(item, { sha: tipB, baseSha: headA }, { baseTip: mergedA, baseTree: treeOf(headA), reviews: dismissed }));
  assert.ok(item.gates.every(entry => entry.passed), item.gates.flatMap(entry => entry.reasons).join('; '));
  assert.equal(carriedApproval(item)?.reviewId, 41, 'the candidate stands on a carried approval');

  // The loop's view: every gate passes, so the guarded merge is retried on its short pause, and
  // refuses with one unchanged reason.
  const view = (work: Work) => ({ ...work, stage: 'merge', gates: work.gates.map(entry => ({ ...entry, passed: true, reasons: [] })), violations: [] }) as Work;
  let clock = Date.parse('2031-04-01T09:00:00Z');
  const master = { url: 'https://graphyard.example', repository: 'owner/project', autoMerge: true } as MasterConfig;
  const state = emptyDaemonState(master);
  const reported: { reason: string; since: string }[] = [];
  const reason = `${item.key} merge refused: the pull request changed on GitHub before merge`;
  const effects = {
    snapshot: async () => ({ work: [view(await reload(item))], now: new Date(clock).toISOString() }),
    persist: async () => {},
    merge: async () => { throw new Error(reason); },
    refuseMerge: async (work: Work, text: string, since: string) => { reported.push({ reason: text, since }); return engine.execute(coordinator, 'mergerefused', work.id, { sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision, reason: text, since }, randomUUID()); },
  };
  const cycle = async () => {
    state.cycle++;
    const open = [view(await reload(item))], performed: Cycle['performed'] = [];
    await mergeStep({ config: master, state, effects, now: () => clock, performed, open, isolate: async (_kind: unknown, _item: unknown, _name: unknown, body: () => Promise<unknown>) => body() } as unknown as Cycle);
    return performed;
  };
  const repeated = () => Object.entries(state.actions).filter(([key]) => key.includes(':repeated')).map(([key, action]) => [key, action] as const);
  const start = clock;
  // Phase one: the refusal runs past ten minutes and the loop clears the carried approval.
  while (!reported.length && clock - start < 3 * repeatedMergeRefusalMs) { await cycle(); clock += 61_000; }
  assert.equal(reported.length, 1, 'the loop acts on the repeated refusal without a hand action');
  item = await reload(item);
  assert.deepEqual([item.mergeRefusal?.action, item.mergeRefusal?.sha], ['rereview', tipB], 'the first action is the rereview');
  assert.equal(carriedApproval(item), null, 'the carried approval is cleared');
  assert.equal(repeated().length, 1, 'one phase marker stands');
  assert.match(repeated()[0][1].detail, /clears the carried approval/);

  // The rereview is answered: a fresh approval of the same candidate arrives. The refusal
  // persists, its since is preserved — and the handling re-arms: the next action is the rework
  // the first phase's done marker must not absorb.
  item = await engine.observe(item.id, item.revision, tip(item, { sha: tipB, baseSha: headA }, { baseTip: mergedA, baseTree: treeOf(headA), reviews: [...dismissed, { id: 99, reviewer: 'graphyard-reviewer[bot]', sha: tipB, state: 'APPROVED' }] }));
  assert.equal(gate(item, 'review').passed, true, 'the fresh approval answers the rereview');
  while (reported.length < 2 && clock - start < 6 * repeatedMergeRefusalMs) { await cycle(); clock += 61_000; }
  assert.equal(reported.length, 2, 'the loop re-arms and takes the rework action');
  assert.equal(reported[1].since, reported[0].since, 'the refusal has stood since the first attempt that gave this reason');
  item = await reload(item);
  assert.deepEqual([item.mergeRefusal?.action, item.mergeRefusal?.sha, item.mergeRefusal?.since], ['rework', tipB, new Date(start).toISOString()]);
  assert.equal(repeated().length, 2, 'one phase marker per action');
  assert.match(repeated().find(([, action]) => action.detail.includes('rework decision'))![1].detail, /marks candidate .* for a rework decision the approver judges/);
  const decision = neededDecision(item, { autoMerge: true });
  assert.deepEqual([decision?.action, decision?.binding], ['rework', `${tipB}:merge-refused`]);
  // And the rework phase, too, is acted on once for this candidate and reason.
  for (let pass = 0; pass < 3; pass++) { await cycle(); clock += 61_000; }
  assert.equal(reported.length, 2);
});

