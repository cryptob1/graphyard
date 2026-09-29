import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { GitHub, processJob } from '../src/github.js';
import { dismissedApproval, predictQueue, queueRef, reviewDismissal, type QueuePlacement, type QueueSpeculation } from '../src/merge-queue.js';
import { carriedApproval, type Observation, type Principal, type Work } from '../src/model.js';
import { buildMasterStatus } from '../src/master.js';

// Each test is named for the proof it produces, so acceptance evidence maps to one executed case
// per required proof: unit:unobserved-approval-carried-on-republish (GY-519 AC-1),
// unit:self-dismissed-approval-restored (GY-519 AC-2) and unit:approval-carry-recorded (GY-519 AC-3).
//
// The republication flow reproduces the GY-446 sequence: a queued candidate is validated and
// enqueued, a requirement-review baseline then excludes that approval (the recorded refusal was
// "a new independent GitHub approval after the requirement-review baseline is required"), the
// queue publishes speculative tip A whose carry therefore carries no approval, the reviewer
// approves A on GitHub, and the item's stored observation never sees it before a head ejection
// makes the queue republish the tip as B and then as C. Each republication force-push dismisses
// the approval it replaces; without the fresh pre-push review read, every ejection would cost the
// item — and every entry behind it — a review round.

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);
const MAIN1 = sha40('e1'), MAIN2 = sha40('e2'), MAIN3 = sha40('e3');
const H = sha40('1a'), P = sha40('1b'), A = sha40('2a'), B = sha40('2b'), C = sha40('2c');
const reviewer = 'graphyard-reviewer[bot]';
const X0 = 1001, X1 = 1002;
const at = '2026-09-26T08:00:00.000Z';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:queue', 'integration:docs'] };

let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TIP_REPUBLISH_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 450);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-tip-republish-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind).reverse();
const gate = (work: Work, name: string) => work.gates.find(entry => entry.name === name)!;
const onlyJob = async (work: Work) => {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
};

// The live GitHub state the stub transport serves: each pull request's head, the base branch tip,
// the merge result per candidate branch, and each pull request's review list.
const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
github.controlPlaneLogin = async () => 'graphyard[bot]';
const state = {
  heads: {} as Record<number, string>, branches: {} as Record<number, string>, mainTip: MAIN1, requests: [] as string[],
  reviews: {} as Record<number, any[]>, nextMerge: {} as Record<string, string | null>,
  commits: {} as Record<string, { parents: string[]; message?: string; bot?: boolean }>,
};
const transport = (async (path: string, method = 'GET', body?: any) => {
  state.requests.push(`${method} ${path}`);
  const pr = /^\/pulls\/(\d+)$/.exec(path);
  if (pr) return { number: Number(pr[1]), head: { sha: state.heads[Number(pr[1])], ref: state.branches[Number(pr[1])], repo: { full_name: 'owner/project' } },
    base: { sha: MAIN1, ref: 'main', repo: { full_name: 'owner/project' } }, user: { login: 'implementer' }, state: 'open', draft: false, merged: false, mergeable: true, merge_commit_sha: null };
  if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: state.mainTip } };
  if (path.startsWith('/commits/')) {
    const sha = path.slice(9);
    const commit = state.commits[sha] ?? { parents: [] };
    return { sha, commit: { tree: { sha: treeOf(sha) }, ...(commit.message ? { message: commit.message } : {}), author: { email: '1+graphyard[bot]@users.noreply.github.com' } },
      parents: commit.parents.map(parent => ({ sha: parent })), ...(commit.bot ? { author: { login: 'graphyard[bot]', type: 'Bot' } } : { author: null }) };
  }
  if (path.startsWith('/compare/')) {
    const [from, to] = path.slice(9).split('?')[0].split('...');
    if (from === to) return { status: 'identical', files: [] };
    return { status: 'ahead', files: [{ filename: 'src/tip.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1 +1 @@\n+const tip = true;' }] };
  }
  if (path === '/merges' && method === 'POST') return state.nextMerge[body.base] === undefined ? null : { sha: state.nextMerge[body.base] };
  const reviews = /^\/pulls\/(\d+)\/reviews/.exec(path);
  if (reviews) return state.reviews[Number(reviews[1])] ?? [];
  if (method !== 'GET') return {};
  throw new Error(`Unexpected request ${method} ${path}`);
}) as typeof github.request;
github.request = transport;
for (const [sha, base, message] of [[H, MAIN1, 'Worker head H'], [P, MAIN1, 'Worker head P']] as const) state.commits[sha] = { parents: [base], message };
for (const sha of [MAIN1, MAIN2, MAIN3]) state.commits[sha] = { parents: [], message: 'main' };
state.commits[MAIN2] = { parents: [MAIN1], message: 'main' };
state.commits[MAIN3] = { parents: [MAIN2], message: 'main' };
for (const [sha, base] of [[A, P], [B, MAIN2], [C, MAIN3]] as const) state.commits[sha] = { parents: [H, base], message: 'Graphyard speculative tip', bot: true };

/** The item's own record as the reconciliation job sees it; only this adapter observes, the real publisher publishes. */
function adapter(observationOf: (work: Work) => Observation) {
  return {
    observe: async (work: Work) => observationOf(work),
    publishSpeculativeTip: async (work: Work, placement: QueuePlacement, beforeWrite: () => Promise<void>) => github.publishSpeculativeTip(work, placement, beforeWrite),
    requestCodex: async (work: Work) => { throw new Error(`no review request expected for ${work.key}`); },
    publish: async () => {},
  } as unknown as GitHub;
}

function observation(work: Work, candidate: { sha: string; baseSha: string }, overrides: Partial<Observation> = {}): Observation {
  const base: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, prState: 'open', draft: false,
    baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true, files: ['src/tip.ts'], scopeFiles: [], at: new Date().toISOString(), ...overrides };
  const reviews = base.reviews ?? [];
  if (reviews.every(entry => Number.isSafeInteger(entry.id) && entry.id! > 0)) base.reviewIds = reviews.map(entry => entry.id as number);
  return base;
}

const input = { title: 'Tip republish approval', plannedFiles: ['src/tip.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:queue', 'integration:docs'] }] };
let pr = 700;
async function submitted(title: string, head = H) {
  let work = await engine.execute(operator, 'create', null, { ...input, title }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/republish/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: 1, pr: ++pr }, randomUUID());
  state.heads[pr] = head;
  state.branches[pr] = work.workspaces[0].branch;
  state.reviews[pr] = [];
  return work;
}
async function validated(work: Work, candidate: { sha: string; baseSha: string }, reviewId: number) {
  const observed = await engine.observe(work.id, work.revision, observation(work, candidate, {
    reviews: [{ id: reviewId, reviewer, sha: candidate.sha, state: 'APPROVED', submittedAt: at }],
  }));
  await engine.execute(producer, 'evidence', observed.id, { proof: 'unit:queue', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/tip.ts'] }, randomUUID());
  await engine.execute(producer, 'evidence', observed.id, { proof: 'integration:docs', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, result: 'pass', executed: 2, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['docs/'] }, randomUUID());
  return observed;
}
/** Opens the merge queue entry of an already validated item, as an earlier evaluation would have. */
async function enqueue(work: Work, sequence: number) {
  await store.pool.query('UPDATE work_items SET document=document||$2::jsonb WHERE id=$1',
    [work.id, JSON.stringify({ queue: { sequence, enqueuedAt: at, policyRevision: 1, speculation: null } })]);
}
/** Flags the requirement-review reset, exactly as a mid-flight requirements revision does. */
const requireFreshApproval = (work: Work) => store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{formalReviewResetRequired}','true') WHERE id=$1", [work.id]);
/** Drops every queue entry a previous test left behind and rewinds the stub's provider state. */
async function reset() {
  await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE document->>'queue' IS NOT NULL");
  state.mainTip = MAIN1; state.nextMerge = {}; state.requests = [];
}
const approved = (id: number, sha: string, stateName = 'APPROVED') => ({ id, user: { login: reviewer }, commit_id: sha, state: stateName, submitted_at: at });
const observedReview = (id: number, sha: string, stateName = 'APPROVED') => ({ id, reviewer, sha, state: stateName, submittedAt: at });

test('unit:unobserved-approval-carried-on-republish — a republication reads the reviews before its force-push and carries the replaced tip\'s unobserved approval onto tips B and C, so neither pays a review round', async () => {
  await reset();
  // Two validated candidates enter the queue; the predecessor heads it and publishes its own head as its tip.
  let ahead = await validated(await submitted('Republish predecessor', P), { sha: P, baseSha: MAIN1 }, 2001);
  let mine = await validated(await submitted('Republish follower'), { sha: H, baseSha: MAIN1 }, X0);
  const branch = mine.workspaces[0].branch;
  await onlyJob(ahead);
  await processJob(engine, adapter(work => observation(work, { sha: P, baseSha: MAIN1 }, { reviews: [observedReview(2001, P)] })));
  ahead = await reload(ahead);
  assert.equal(ahead.queue!.speculation!.tip, P, 'the predecessor published its own head as its tip');
  // The follower's queue entry predates the reset, as in production: a requirement-review baseline
  // now excludes its approval (the recorded GY-446 refusal was exactly that), and the observation
  // that records the baseline predates any approval of the tip to come.
  await enqueue(mine, 2);
  await requireFreshApproval(mine);
  state.nextMerge[branch] = A;
  await onlyJob(mine);
  await processJob(engine, adapter(work => observation(work, { sha: H, baseSha: MAIN1 }, { baseTip: MAIN1, reviews: [observedReview(X0, H)] })));
  mine = await reload(mine);
  if (!mine.queue?.speculation || mine.queue.speculation.tip !== A) {
    console.error('DEBUG spec', JSON.stringify(mine.queue?.speculation));
    console.error('DEBUG candidate', JSON.stringify(mine.candidate));
  }
  assert.equal(mine.queue!.speculation!.tip, A, 'tip A was published behind the predecessor');
  assert.equal(mine.queue!.speculation!.carry!.approval.carried, false, 'the baseline excluded the approval, so tip A carries none');
  assert.match(mine.queue!.speculation!.carry!.approval.reason, /no approval was bound to the replaced head/);
  assert.equal(mine.queue!.speculation!.observedApproval ?? null, null, 'the pre-push read found only the baseline-excluded approval');
  // The reviewer approves tip A on GitHub; every push of a new tip dismisses the approval it
  // replaces. The item's own observation keeps lagging behind and never records the approval.
  state.reviews[mine.submission!.pr] = [approved(X0, H, 'DISMISSED'), approved(X1, A)];
  state.heads[mine.submission!.pr] = A;
  // GY-446's head ejection: the predecessor's tip fails CI and leaves the queue, so the follower's
  // predicted base moves to the base branch tip and its tip must be republished.
  await onlyJob(ahead);
  await processJob(engine, adapter(work => observation(work, { sha: P, baseSha: MAIN1 }, {
    baseTip: MAIN1, checks: [{ name: 'test', result: 'failure', appId: 15368 }], reviews: [observedReview(2001, P)],
  })));
  ahead = await reload(ahead);
  assert.equal(ahead.queue, null, 'the predecessor was ejected');
  state.mainTip = MAIN2;
  state.nextMerge[branch] = B;
  const beforePublish = state.requests.length;
  await onlyJob(mine);
  await processJob(engine, adapter(work => observation(work, { sha: A, baseSha: P }, {
    baseTip: MAIN2, baseTree: treeOf(MAIN2), baseTipContained: false, reviews: [observedReview(X0, H, 'DISMISSED')],
  })));
  mine = await reload(mine);
  // The fresh read happened outside any coordination transaction, before the force-push it informed.
  const round = state.requests.slice(beforePublish);
  const read = round.findIndex(entry => entry.startsWith(`GET /pulls/${mine.submission!.pr}/reviews`));
  const pushed = round.findIndex(entry => entry === 'POST /merges');
  assert.ok(read >= 0 && pushed > read, 'the reviews were read before the tip was force-pushed');
  // Tip B: the unobserved approval of A was carried, not dropped.
  assert.equal(mine.queue!.speculation!.tip, B);
  const carryB = mine.queue!.speculation!.carry!.approval as unknown as { carried: boolean; reviewer: string; reviewId: number; originalSha: string; reason: string };
  assert.equal(carryB.carried, true);
  assert.deepEqual({ reviewer: carryB.reviewer, reviewId: carryB.reviewId, originalSha: carryB.originalSha }, { reviewer, reviewId: X1, originalSha: A }, 'the carried identity names the approval of A');
  assert.ok(carryB.reason.includes(`approval of ${A.slice(0, 12)} by ${reviewer} (review ${X1}) carried to Graphyard-authored tip ${B.slice(0, 12)}`), carryB.reason);
  // The observation of tip B: the approval of A is already dismissed again, yet the review gate
  // passes on the carried identity, and no review request is opened for the tip.
  state.heads[mine.submission!.pr] = B;
  await onlyJob(mine);
  await processJob(engine, adapter(work => observation(work, { sha: B, baseSha: MAIN2 }, {
    reviews: [observedReview(X0, H, 'DISMISSED'), observedReview(X1, A, 'DISMISSED')],
  })));
  mine = await reload(mine);
  assert.equal(gate(mine, 'review').passed, true, 'the review gate passes on tip B');
  assert.equal(mine.autoDispatch?.review ?? null, null);
  const requestedSoFar = await events(mine, 'dispatch.requested');
  assert.ok(requestedSoFar.length > 0 && requestedSoFar.every(entry => entry.payload.details.sha !== B), 'no review request was opened for tip B');
  // A second base advance republishes the tip as C. No approval exists on B anywhere — the fresh
  // read finds none — so the carry chains from B's recorded decision and still names approval of A.
  state.mainTip = MAIN3;
  state.nextMerge[branch] = C;
  await onlyJob(mine);
  await processJob(engine, adapter(work => observation(work, { sha: B, baseSha: MAIN2 }, {
    baseTip: MAIN3, baseTree: treeOf(MAIN3), baseTipContained: false, reviews: [observedReview(X0, H, 'DISMISSED'), observedReview(X1, A, 'DISMISSED')],
  })));
  mine = await reload(mine);
  assert.equal(mine.queue!.speculation!.tip, C, 'tip C was published behind the new base');
  const carryC = mine.queue!.speculation!.carry!.approval as unknown as { carried: boolean; reviewer: string; reviewId: number; originalSha: string };
  assert.equal(carryC.carried, true);
  assert.deepEqual({ reviewer: carryC.reviewer, reviewId: carryC.reviewId, originalSha: carryC.originalSha }, { reviewer, reviewId: X1, originalSha: A }, 'the identity carried to C is still the approval of A');
  state.heads[mine.submission!.pr] = C;
  await onlyJob(mine);
  await processJob(engine, adapter(work => observation(work, { sha: C, baseSha: MAIN3 }, {
    reviews: [observedReview(X0, H, 'DISMISSED'), observedReview(X1, A, 'DISMISSED')],
  })));
  mine = await reload(mine);
  assert.equal(gate(mine, 'review').passed, true, 'the review gate passes on tip C');
  assert.equal(mine.autoDispatch?.review ?? null, null);
  assert.ok((await events(mine, 'dispatch.requested')).every(entry => entry.payload.details.sha !== C), 'no review request was opened for tip C');
});

test('unit:self-dismissed-approval-restored — a dismissal the control plane\'s own republication made is restored across the head change, and never for a moved author head, a changed patch, or anyone else\'s dismissal or push', async () => {
  await reset();
  // The timeline facts the observation collects: GitHub's merge-base dismissals and the force-pushes, each named as the App's or not.
  github.request = (async (path: string) => {
    if (/^\/issues\/\d+\/timeline/.test(path)) return [
      { event: 'review_dismissed', actor: { login: 'graphyard[bot]' }, created_at: at, dismissed_review: { review_id: X1, dismissal_message: 'The merge-base changed after approval.', state: 'approved', dismissal_commit_id: B } },
      { event: 'head_ref_force_pushed', actor: { login: 'graphyard[bot]' }, created_at: at, before: A, after: B },
      { event: 'review_dismissed', actor: { login: 'alice' }, created_at: at, dismissed_review: { review_id: 2003, dismissal_message: 'The merge-base changed after approval.', state: 'approved', dismissal_commit_id: B } },
      { event: 'head_ref_force_pushed', actor: { login: 'alice' }, created_at: at, before: B, after: C },
    ];
    throw new Error(`Unexpected request ${path}`);
  }) as typeof github.request;
  const dismissals = await github.reviewDismissals(700);
  assert.equal(dismissals.unread, null);
  assert.equal(dismissals.read.get(X1)?.mergeBase, true);
  assert.equal(dismissals.read.get(X1)?.byApp, true, 'the App\'s own dismissal is named as its own');
  assert.equal(dismissals.read.get(2003)?.byApp, false, 'a person\'s dismissal is not the App\'s');
  assert.deepEqual(dismissals.forcePushes.map(entry => [entry.before, entry.after, entry.byApp]), [[A, B, true], [B, C, false]]);
  github.request = transport;

  // The republication race: the approval of tip A landed between the pre-push read and the
  // force-push, so tip B's carry carries none of it; the first observation that sees the dismissed
  // approval restores it as the binding one, carried from A to B.
  const mine = await submitted('Self dismissed');
  const speculation: QueueSpeculation = { ref: queueRef(mine.key), tip: B, tipTree: treeOf(B), base: MAIN2, baseTree: treeOf(MAIN2), predecessors: [], policyRevision: 1, publishedAt: at, reviewedHead: H,
    merge: { from: H, parents: [H, MAIN2], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['docs/other.md'], diff: { reviewed: 'patch-1', tip: 'patch-1' } },
    carry: { from: { sha: H, baseSha: MAIN1 }, to: { sha: B, baseSha: MAIN2 }, policyRevision: 1, at, predecessor: 'base branch', changedFiles: ['docs/other.md'], reviewedFiles: ['src/tip.ts'],
      approval: { carried: false, reason: 'no approval was bound to the replaced head' }, evidence: [], ground: { rule: 'diff unchanged', patchId: 'patch-1', tipPatchId: 'patch-1' } } };
  await store.pool.query('UPDATE work_items SET document=document||$2::jsonb WHERE id=$1', [mine.id, JSON.stringify({
    candidate: { sha: B, baseSha: MAIN2, pr: mine.submission!.pr, branch: mine.workspaces[0].branch, author: 'implementer' },
    queue: { sequence: 9, enqueuedAt: at, policyRevision: 1, speculation },
    queueHistory: [{ at, event: 'predicted', sequence: 9, tip: A, predecessors: [], from: H }, { at, event: 'predicted', sequence: 9, tip: B, predecessors: [], from: H }],
  })]);
  const dismissedReview = { id: X1, reviewer, sha: A, state: 'DISMISSED', submittedAt: at,
    dismissal: { reason: 'The merge-base changed after approval.', mergeBase: true, verdict: 'approved' as const, commit: B, at, by: 'graphyard[bot]', byApp: true } };
  const observed = await engine.observe(mine.id, (await reload(mine)).revision, observation(mine, { sha: B, baseSha: MAIN2 }, {
    reviews: [dismissedReview], headForcePushes: [{ at, by: 'graphyard[bot]', byApp: true, before: A, after: B }],
  }));
  assert.equal(gate(observed, 'review').passed, true, 'the dismissed approval binds tip B again');
  const restored = (await events(mine, 'review.restored')).at(-1)!.payload.details;
  assert.deepEqual({ reviewer: restored.reviewer, reviewId: restored.reviewId, sha: restored.sha, originalSha: restored.originalSha }, { reviewer, reviewId: X1, sha: B, originalSha: A }, 'the record names the approval id, the tip it approved and the tip it was carried to');
  assert.equal(carriedApproval(observed)!.originalSha, A);
  assert.match(carriedApproval(observed)!.reason, /restored and carried to tip/);
  assert.equal(observed.queue!.speculation!.restoredApproval ?? null, null, 'the unchanged-head status record belongs to the unchanged-head restore only');

  // Each negative: restore is refused when the author head moved, the patch changed, the push or
  // the dismissal was not the App's, or no App push chain leads from the approved tip.
  const candidate = { sha: B, baseSha: MAIN2, pr: 700, branch: 'graphyard/gy-9-1', author: 'implementer' };
  const shaped = (overrides: { historyFrom?: string; ground?: 'diff unchanged' | 'diff changed'; pushes?: { byApp: boolean; before: string; after: string }[]; dismissalByApp?: boolean }): Work => ({
    key: 'GY-9', policy: { checks: ['test'], review: true, reviewProvider: 'github' }, policyRevision: 1, submission: { epoch: 1, pr: 700 }, reworkRequested: false, candidate,
    queue: { sequence: 9, enqueuedAt: at, policyRevision: 1, speculation: { ...speculation,
      carry: { ...speculation.carry!, ground: { rule: overrides.ground ?? 'diff unchanged', patchId: 'patch-1', tipPatchId: 'patch-1' } } } },
    queueHistory: [{ at, event: 'predicted' as const, sequence: 9, tip: A, predecessors: [], from: overrides.historyFrom ?? H }, { at, event: 'predicted' as const, sequence: 9, tip: B, predecessors: [], from: H }],
    observation: { ...observation({ submission: { epoch: 1, pr: 700 }, workspaces: [{ host: 'h', path: '/w', branch: 'graphyard/gy-9-1', epoch: 1, owner: 'w' }] } as Work, candidate),
      reviews: [{ ...dismissedReview, dismissal: { ...dismissedReview.dismissal, byApp: overrides.dismissalByApp ?? true } }] as unknown as NonNullable<Work['observation']>['reviews'],
      headForcePushes: (overrides.pushes ?? [{ byApp: true, before: A, after: B }]).map(entry => ({ at, by: entry.byApp ? 'graphyard[bot]' : 'alice', byApp: entry.byApp, before: entry.before, after: entry.after })) },
  } as unknown as Work);
  assert.ok(dismissedApproval(shaped({}))!.originalSha === A, 'sanity: the positive shape restores');
  assert.equal(dismissedApproval(shaped({ historyFrom: sha40('h9') })), null, 'the author head moved under the approved tip: nothing restores');
  assert.equal(dismissedApproval(shaped({ ground: 'diff changed' })), null, 'the patch changed since the approval: nothing restores');
  assert.equal(dismissedApproval(shaped({ dismissalByApp: false })), null, 'a person dismissed the approval: nothing restores');
  assert.equal(dismissedApproval(shaped({ pushes: [{ byApp: false, before: A, after: B }] })), null, 'a person force-pushed the tip away: nothing restores');
  assert.equal(dismissedApproval(shaped({ pushes: [] })), null, 'no App push chain leads from the approved tip: nothing restores');
  // The unchanged-head restore keeps its own shape: the approval of the head itself, no originalSha.
  const unchanged = dismissedApproval({ ...shaped({ dismissalByApp: false }), observation: { ...observation({ submission: { epoch: 1, pr: 700 }, workspaces: [{ host: 'h', path: '/w', branch: 'graphyard/gy-9-1', epoch: 1, owner: 'w' }] } as Work, candidate), reviews: [{ ...dismissedReview, sha: B, dismissal: { ...dismissedReview.dismissal, byApp: false } }] as unknown as NonNullable<Work['observation']>['reviews'] } } as unknown as Work)!;
  assert.deepEqual({ reviewer: unchanged.reviewer, reviewId: unchanged.reviewId, sha: unchanged.sha, originalSha: unchanged.originalSha ?? null }, { reviewer, reviewId: X1, sha: B, originalSha: null });
});

test('unit:approval-carry-recorded — master status and the item history record each carried or restored approval with its id, the tip it approved and the tip it was carried to', async () => {
  await reset();
  // A carried approval: the same republication as above, then the ledger and master status views.
  let ahead = await validated(await submitted('Record predecessor', P), { sha: P, baseSha: MAIN1 }, 2001);
  let mine = await validated(await submitted('Record follower'), { sha: H, baseSha: MAIN1 }, X0);
  const branch = mine.workspaces[0].branch;
  await onlyJob(ahead);
  await processJob(engine, adapter(work => observation(work, { sha: P, baseSha: MAIN1 }, { reviews: [observedReview(2001, P)] })));
  await enqueue(mine, 4);
  await requireFreshApproval(mine);
  state.nextMerge[branch] = A;
  await onlyJob(mine);
  await processJob(engine, adapter(work => observation(work, { sha: H, baseSha: MAIN1 }, { baseTip: MAIN1, reviews: [observedReview(X0, H)] })));
  state.reviews[mine.submission!.pr] = [approved(X0, H, 'DISMISSED'), approved(X1, A)];
  state.heads[mine.submission!.pr] = A;
  await onlyJob(ahead);
  await processJob(engine, adapter(work => observation(work, { sha: P, baseSha: MAIN1 }, {
    baseTip: MAIN1, checks: [{ name: 'test', result: 'failure', appId: 15368 }], reviews: [observedReview(2001, P)],
  })));
  state.mainTip = MAIN2;
  state.nextMerge[branch] = B;
  await onlyJob(mine);
  await processJob(engine, adapter(work => observation(work, { sha: A, baseSha: P }, {
    baseTip: MAIN2, baseTree: treeOf(MAIN2), baseTipContained: false, reviews: [observedReview(X0, H, 'DISMISSED')],
  })));
  mine = await reload(mine);
  // The item history: the carry decision names the approval id, the tip it approved and the tip it was carried to.
  const carries = await events(mine, 'queue.carry');
  assert.equal(carries.length, 2, 'both tip publications recorded their carry decision');
  // The observation of tip B binds it as the candidate, exactly as the reconciliation would.
  state.heads[mine.submission!.pr] = B;
  await onlyJob(mine);
  await processJob(engine, adapter(work => observation(work, { sha: B, baseSha: MAIN2 }, {
    reviews: [observedReview(X0, H, 'DISMISSED'), observedReview(X1, A, 'DISMISSED')],
  })));
  mine = await reload(mine);
  const last = carries.at(-1)!.payload.details;
  assert.deepEqual({ carried: last.approval.carried, reviewId: last.approval.reviewId, originalSha: last.approval.originalSha, approved: last.from.sha, carriedTo: last.to.sha },
    { carried: true, reviewId: X1, originalSha: A, approved: H, carriedTo: B });
  assert.equal(last.approval.provider, 'github');
  // Master status: the queue binding names the same three facts.
  const status = buildMasterStatus(await store.workSnapshot(), [], []);
  const row = status.queue.find(entry => entry.key === mine.key)!;
  assert.deepEqual([row.binding!.approval.state, row.binding!.approval.reviewer, row.binding!.approval.originalSha], ['carried', reviewer, A]);
  assert.match(row.binding!.approval.reason, new RegExp(`\\(review ${X1}\\)`));
  assert.match(row.binding!.approval.reason, new RegExp(`approval of ${A.slice(0, 12)}`));
  assert.match(row.binding!.approval.reason, new RegExp(`carried to Graphyard-authored tip ${B.slice(0, 12)}`));

  // A restored approval: the same race as above, then the ledger and master status views.
  const raced = await submitted('Record restored');
  const speculation: QueueSpeculation = { ref: queueRef(raced.key), tip: B, tipTree: treeOf(B), base: MAIN2, baseTree: treeOf(MAIN2), predecessors: [], policyRevision: 1, publishedAt: at, reviewedHead: H,
    merge: { from: H, parents: [H, MAIN2], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['docs/other.md'], diff: { reviewed: 'patch-1', tip: 'patch-1' } },
    carry: { from: { sha: H, baseSha: MAIN1 }, to: { sha: B, baseSha: MAIN2 }, policyRevision: 1, at, predecessor: 'base branch', changedFiles: ['docs/other.md'], reviewedFiles: ['src/tip.ts'],
      approval: { carried: false, reason: 'no approval was bound to the replaced head' }, evidence: [], ground: { rule: 'diff unchanged', patchId: 'patch-1', tipPatchId: 'patch-1' } } };
  await store.pool.query('UPDATE work_items SET document=document||$2::jsonb WHERE id=$1', [raced.id, JSON.stringify({
    candidate: { sha: B, baseSha: MAIN2, pr: raced.submission!.pr, branch: raced.workspaces[0].branch, author: 'implementer' },
    queue: { sequence: 10, enqueuedAt: at, policyRevision: 1, speculation },
    queueHistory: [{ at, event: 'predicted', sequence: 10, tip: A, predecessors: [], from: H }, { at, event: 'predicted', sequence: 10, tip: B, predecessors: [], from: H }],
  })]);
  const dismissedReview = { id: X1, reviewer, sha: A, state: 'DISMISSED', submittedAt: at,
    dismissal: { reason: 'The merge-base changed after approval.', mergeBase: true, verdict: 'approved' as const, commit: B, at, by: 'graphyard[bot]', byApp: true } };
  const observed = await engine.observe(raced.id, (await reload(raced)).revision, observation(raced, { sha: B, baseSha: MAIN2 }, {
    reviews: [dismissedReview], headForcePushes: [{ at, by: 'graphyard[bot]', byApp: true, before: A, after: B }],
  }));
  const restored = (await events(raced, 'review.restored')).at(-1)!.payload.details;
  assert.deepEqual({ reviewId: restored.reviewId, originalSha: restored.originalSha, sha: restored.sha }, { reviewId: X1, originalSha: A, sha: B }, 'the history names the approval id, the tip it approved and the tip it was carried to');
  const after = buildMasterStatus(await store.workSnapshot(), [], []);
  const restoredRow = after.queue.find(entry => entry.key === raced.key)!;
  assert.deepEqual([restoredRow.binding!.approval.state, restoredRow.binding!.approval.originalSha], ['carried', A]);
  assert.match(restoredRow.binding!.approval.reason, new RegExp(`\\(review ${X1}\\)`));
  assert.match(restoredRow.binding!.approval.reason, new RegExp(`restored and carried to tip ${B.slice(0, 12)}`));
  assert.equal(reviewDismissal(observed.observation!.reviews[0]!)?.byApp, true);
});
