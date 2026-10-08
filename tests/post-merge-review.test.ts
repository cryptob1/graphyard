import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { masterConfigSchema } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { deliveredByMergeWriter, owedPostMergeReviews, parseFinding, postMergeFollowUp, postMergeRequestId, postMergeReviewMark } from '../src/model/post-merge-review.js';
import { emptyDispatchCursor, filePostMergeFollowUps, postMergeRequest, postMergeWaitReason, reviewedAfterMerge, runDispatchTick, selectReviewerProfile, type DispatchEffects } from '../src/auto-dispatch.js';
import { controlPlaneRefusal, controlPlaneVerdict, staleReviewReason, type ReviewRecord } from '../src/reviewer.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1525 AC-4: a normal-risk delta the merge writer delivered owes one post-merge review of its
// merge delta; the loop launches it with the same binding mechanism, files one follow-up item per
// BLOCKING finding, keeps the rest in project memory, and never reopens the delivered item.

const H = 'a'.repeat(40), B = 'b'.repeat(40), M = 'c'.repeat(40), P = 'd'.repeat(40);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const hashOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const at = '2026-10-08T12:00:00.000Z';
const clock = Date.parse(at);

function delivered(key: string, fields: Record<string, unknown> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
  return { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true }, plannedFiles: ['src/feature.ts'],
    stage: 'done', revision: 9, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: 'graphyard/gy-7-1', epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'], postMergeReview: 'owed',
    delivery: { mergedAt: at, mergeSha: M, authorizationRevision: 8 },
    mergeLedger: { key, state: 'reconciled', head: H, baseTip: B, mergeSha: M, risk: 'normal', intentAt: at, pushedAt: at, observedTip: M, refusal: null, events: 3 },
    observation: { source: 'control-plane', at, candidate, checks: [], reviews: [], merged: true, mergeSha: M, mergedAt: at, mergeable: true, protected: false, files: ['src/feature.ts'], scopeFiles: [{ path: 'src/feature.ts', status: 'modified', sha: sha('f'), additions: 2, deletions: 1, binary: false }], baseTip: B, baseTipContained: true },
    ...fields } as unknown as Work;
}
const planeHead = (key: string, files: string[]) => {
  const candidate = { sha: H, baseSha: B, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
  return delivered(key, { stage: 'review', delivery: undefined, mergeLedger: undefined, postMergeReview: undefined, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }],
    observation: { source: 'control-plane', at, candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, files, scopeFiles: files.map(path => ({ path, status: 'modified', sha: sha(path), additions: 1, deletions: 0, binary: false })), baseTip: B, baseTipContained: true } });
};
const verdictBody = 'AC-1 unmet after merge.\nBLOCKING: src/feature.ts:12 — the flag is never read\nBLOCKING: src/other.ts — the retry loop never ends\n- Nit: naming of `x` is terse\n\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none';
const record = (work: Work, fields: Partial<ReviewRecord> = {}): ReviewRecord => ({ id: randomUUID(), key: work.key, pr: 7, sha: M, baseSha: P, policyRevision: 1, profile: 'reviewer-claude', agentName: 'review-claude-1', pane: 'pane-1', sessionDirectory: '/sessions/x',
  requestedAt: at, tokenExpiresAt: new Date(clock + 3_600_000).toISOString(), state: 'pending', requestId: postMergeRequestId(work.key, M), mode: 'control-plane', postMerge: true, launch: 'launch-1', verdictTokenHash: 'e'.repeat(64), ...fields });
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
  reviewers: [{ name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude' }], workers: [], producers: [] });
function stubEffects(items: () => Work[], log: string[], reviews: any[], overrides: Partial<DispatchEffects> = {}): DispatchEffects {
  return {
    snapshot: async () => ({ work: items(), now: new Date(clock).toISOString() }),
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: async (item, request) => { log.push(`review:${item.key}:${request.sha.slice(0, 4)}`); },
    launchProducer: async () => {},
    persist: async () => {},
    ...overrides,
  };
}

test('unit:post-merge-review-owed — owed reviews are the merge writer\'s deliveries with postMergeReview owed and no verdict for the merge commit; the dispatcher launches one session per merge commit, waits a normal-risk pre-merge request, and files follow-ups from the verdict once', async () => {
  const owed = delivered('GY-10');
  assert.equal(deliveredByMergeWriter(owed), true);
  assert.deepEqual(owedPostMergeReviews([owed]).map(item => item.key), ['GY-10']);
  assert.deepEqual(owedPostMergeReviews([delivered('GY-11', { postMergeReview: 'reviewed' }), delivered('GY-12', { postMergeReview: null }), delivered('GY-13', { stage: 'review' })]), [], 'reviewed, cleared and undelivered items owe nothing');
  assert.deepEqual(owedPostMergeReviews([delivered('GY-14', { mergeLedger: undefined, observation: { ...owed.observation, source: undefined } })]), [], 'a GitHub-merged item is not the merge writer\'s');
  assert.deepEqual(owedPostMergeReviews([delivered('GY-15', { reviewLaunch: { id: 'l', reviewer: 'r', requester: 'm', head: M, baseTip: P, tokenHash: 'e'.repeat(64), at, expiresAt: at, postMerge: true, verdict: { reviewer: 'r', sha: M, state: 'APPROVED', body: 'ok', submittedAt: at, source: 'control-plane', reviewId: 3 } } })]), [], 'a recorded verdict for the merge commit settles the debt');
  assert.deepEqual(postMergeReviewMark({ stage: 'review', postMergeReview: undefined }, 'normal', false), { postMergeReview: 'owed' });
  assert.deepEqual(postMergeReviewMark({ stage: 'review', postMergeReview: 'owed' }, 'sensitive', false), { postMergeReview: null });
  const request = postMergeRequest(owed);
  assert.deepEqual([request.id, request.kind, request.sha, request.provider, request.state, request.requestedAt], [postMergeRequestId('GY-10', M), 'review', M, 'github', 'requested', at]);
  // The finding form: path and line when the line starts with them.
  assert.deepEqual(parseFinding('src/feature.ts:12 — the flag is never read'), { text: 'src/feature.ts:12 — the flag is never read', path: 'src/feature.ts', line: 12 });
  assert.deepEqual(parseFinding('`src/other.ts` - the retry loop never ends').path, 'src/other.ts');
  assert.deepEqual(parseFinding('the retry loop never ends'), { text: 'the retry loop never ends', path: null, line: null });
  const followUp = postMergeFollowUp(owed, M, parseFinding('src/feature.ts:12 — the flag is never read'), 0);
  assert.deepEqual([followUp.type, followUp.priority, followUp.plannedFiles, followUp.policy, followUp.origin], ['bug', 1, ['src/feature.ts'], { checks: ['test'], review: true }, { reviewFollowUps: { parent: 'GY-10', findings: [{ path: 'src/feature.ts', text: 'src/feature.ts:12 — the flag is never read', ref: M }] } }]);
  assert.match(followUp.title, /^Post-merge review of GY-10 \(cccccccccccc\): src\/feature\.ts:12 — the flag is never read$/);
  assert.match(followUp.description, new RegExp(`delivered as merge commit ${M}`));
  // The ledger side: a post-merge record is stale only when its item is not delivered as that commit; its verdict and refusal are read from the launch.
  assert.equal(staleReviewReason(record(owed), [owed]), null);
  assert.match(staleReviewReason(record(owed, { sha: P }), [owed])!, /not delivered as dddddddddddd/);
  const launched = delivered('GY-10', { id: owed.id, reviewLaunch: { id: 'launch-1', reviewer: 'review-claude-1', requester: 'graphyard-master', head: M, baseTip: P, tokenHash: 'e'.repeat(64), at, expiresAt: at, postMerge: true, verdict: null } });
  assert.equal(controlPlaneVerdict(record(owed), [launched]), null);
  launched.reviewLaunch!.verdict = { reviewer: 'review-claude-1', sha: M, state: 'CHANGES_REQUESTED', body: verdictBody, submittedAt: at, source: 'control-plane', reviewId: 77 };
  assert.deepEqual(controlPlaneVerdict(record(owed), [launched]), { state: 'CHANGES_REQUESTED', reviewer: 'review-claude-1', reviewId: 77, submittedAt: at });
  assert.equal(controlPlaneVerdict(record(owed, { launch: 'other-launch' }), [launched]), null, 'another launch\'s verdict is not this record\'s');
  const refused = delivered('GY-10', { reviewLaunch: { ...launched.reviewLaunch!, verdict: null, refused: { at, reason: 'Reviewer review-claude-1 implemented GY-10' } } });
  assert.match(controlPlaneRefusal(record(owed), [refused])!, /refused the verdict: Reviewer review-claude-1 implemented GY-10/);
  // The dispatcher: one post-merge session per merge commit, without a reviewer App.
  assert.equal(selectReviewerProfile(config, 'control-plane').profile!.name, 'reviewer-claude');
  assert.match(selectReviewerProfile(config).reason!, /no reviewer identity is registered/, 'github mode still needs the App');
  const log: string[] = [], reviews: any[] = [], filed: unknown[] = [], settled: unknown[] = [], memory: string[][] = [];
  let items: Work[] = [owed];
  const effects = stubEffects(() => items, log, reviews, {
    launchPostMergeReview: async (item, request, profile) => { log.push(`post-merge:${item.key}:${request.sha.slice(0, 4)}:${profile.name}`); reviews.push(record(item, { requestId: request.id, state: 'pending', requestedAt: new Date(clock).toISOString() })); },
    createWork: async (body, requestId) => { filed.push({ body, requestId }); return { key: `GY-${100 + filed.length}` }; },
    recordFindings: async (_work, _record, findings) => { memory.push(findings); },
    settlePostMerge: async (entry, outcome) => { settled.push(outcome); entry.postMergeFollowUps = outcome; },
  });
  const cursor = emptyDispatchCursor(config);
  const first = await runDispatchTick(config, cursor, effects, () => clock);
  assert.deepEqual(log, ['post-merge:GY-10:cccc:reviewer-claude']);
  assert.deepEqual(first.launched.map(launch => [launch.kind, launch.work, launch.sha, launch.requestId, launch.reason]), [['review', 'GY-10', M, postMergeRequestId('GY-10', M), 'post-merge review of the delivered merge commit']]);
  const second = await runDispatchTick(config, cursor, effects, () => clock + 10_000);
  assert.equal(log.length, 1, 'the pending session answers the request; nothing launches twice');
  assert.equal(second.skipped, 1);
  // A normal-risk pre-merge request waits for the merge instead of launching a session.
  const pending = planeHead('GY-16', ['src/feature.ts']); reconcileAutoDispatch(pending, [pending], new Date(clock));
  assert.equal(reviewedAfterMerge(pending), true);
  items = [pending];
  const waited = await runDispatchTick(config, cursor, effects, () => clock + 20_000);
  assert.deepEqual(log, ['post-merge:GY-10:cccc:reviewer-claude'], 'no pre-merge session for a normal delta');
  assert.deepEqual(waited.waiting.map(entry => [entry.work, entry.reason]), [['GY-16', postMergeWaitReason]]);
  const sensitive = planeHead('GY-17', ['src/store/pools.ts']); reconcileAutoDispatch(sensitive, [sensitive], new Date(clock));
  assert.equal(reviewedAfterMerge(sensitive), false);
  items = [sensitive];
  await runDispatchTick(config, cursor, effects, () => clock + 30_000);
  assert.deepEqual(log.at(-1), 'review:GY-17:aaaa', 'a sensitive delta is reviewed before the merge');
  // The verdict lands: one follow-up per BLOCKING line, the nit to memory, recorded once on the ledger.
  reviews[0] = record(launched, { id: reviews[0].id, state: 'completed', verdict: { state: 'CHANGES_REQUESTED', reviewer: 'review-claude-1', reviewId: 77, submittedAt: at } });
  items = [launched];
  const third = await runDispatchTick(config, cursor, effects, () => clock + 40_000);
  assert.deepEqual(filed.map(entry => [(entry as { body: { plannedFiles: string[] } }).body.plannedFiles, (entry as { requestId: string }).requestId]), [[['src/feature.ts'], `post-merge-follow-up:GY-10:${M}:0`], [['src/other.ts'], `post-merge-follow-up:GY-10:${M}:1`]]);
  assert.deepEqual(memory, [['AC-1 unmet after merge.', '- Nit: naming of `x` is terse']], 'everything but the BLOCKING lines goes to memory');
  assert.deepEqual(settled, [{ at: new Date(clock + 40_000).toISOString(), filed: [{ key: 'GY-101', finding: 'src/feature.ts:12 — the flag is never read' }, { key: 'GY-102', finding: 'src/other.ts — the retry loop never ends' }], memory: 2 }]);
  assert.deepEqual(third.followUps, [{ work: 'GY-10', sha: M, filed: ['GY-101', 'GY-102'], memory: 2 }]);
  await runDispatchTick(config, cursor, effects, () => clock + 50_000);
  assert.equal(filed.length, 2, 'a settled record files nothing again');
  assert.equal(settled.length, 1);
  // A filing that fails is recorded with its reason and retried for what is not filed yet; nothing reopens the item.
  const failing = record(launched, { state: 'completed', verdict: { state: 'CHANGES_REQUESTED', reviewer: 'review-claude-1', reviewId: 77, submittedAt: at } });
  let calls = 0;
  const partial = await filePostMergeFollowUps(launched, failing, { createWork: async () => { if (++calls === 2) throw new Error('route down'); return { key: 'GY-201' }; } }, new Date(clock));
  assert.deepEqual(partial, { at, filed: [{ key: 'GY-201', finding: 'src/feature.ts:12 — the flag is never read' }], memory: 2, failure: 'filing the follow-up for "src/other.ts — the retry loop never ends" failed: route down' });
  const retried = await filePostMergeFollowUps(launched, { ...failing, postMergeFollowUps: partial! }, { createWork: async () => ({ key: 'GY-202' }) }, new Date(clock));
  assert.deepEqual(retried!.filed.map(entry => entry.key), ['GY-201', 'GY-202']);
  assert.equal(retried!.failure, undefined);
  assert.equal(launched.stage, 'done');
  assert.equal(await filePostMergeFollowUps(launched, record(launched), {}, new Date(clock)), null, 'no verdict, nothing to file');
});

// ——— Over a real control plane: the launch, the verdict, the follow-up items, the delivered item untouched. ———
const repository = 'owner/project';
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const principals = [admin, coordinator];
const credentials = principals.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const tokenOf = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let pg: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1526;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('post-merge-review-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('post_merge_review_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/post_merge_review_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });
async function request(credential: string, path: string, body?: unknown, key: string = randomUUID()) {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;

test('integration:post-merge-review-files-follow-ups — a delivered normal-risk item takes one post-merge launch on its merge commit; the verdict marks it reviewed without reopening it, and each BLOCKING finding becomes one priority-1 bug item whose origin names the delivered item and merge commit, planned on the finding\'s file', async () => {
  const work = delivered('GY-9101');
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  const token = randomBytes(32).toString('hex');
  const launch = { reviewer: 'review-claude-1', head: M, baseTip: P, tokenHash: hashOf(token), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), postMerge: true };
  assert.equal((await request(tokenOf(coordinator), `work/${work.id}/review-launch`, { ...launch, postMerge: false })).status, 409, 'a delivered item takes no pre-merge launch');
  assert.equal((await request(tokenOf(coordinator), `work/${work.id}/review-launch`, { ...launch, head: H })).status, 409, 'a post-merge launch names the merge commit');
  const registered = await request(tokenOf(coordinator), `work/${work.id}/review-launch`, launch);
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  assert.deepEqual([registered.body.postMerge, registered.body.head, registered.body.baseTip], [true, M, P]);
  const verdict = await request(token, `work/${work.id}/review-verdict`, { event: 'REQUEST_CHANGES', body: verdictBody, sha: M, token });
  assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
  assert.deepEqual([verdict.body.postMerge, verdict.body.state, verdict.body.stage], [true, 'CHANGES_REQUESTED', 'done']);
  const reviewed = await stored(work.id);
  assert.deepEqual([reviewed.stage, reviewed.postMergeReview, reviewed.delivery, reviewed.reviewLaunch!.verdict!.state, reviewed.reviewLaunch!.verdict!.body], ['done', 'reviewed', work.delivery, 'CHANGES_REQUESTED', verdictBody]);
  assert.equal(reviewed.observation!.reviews.length, 1, 'the verdict is on the observation too');
  assert.deepEqual(owedPostMergeReviews([reviewed]), [], 'nothing is owed once reviewed');
  assert.equal((await request(tokenOf(coordinator), `work/${work.id}/review-launch`, { ...launch, tokenHash: hashOf(randomBytes(32).toString('hex')) })).status, 409, 'a reviewed item takes no second post-merge launch');
  // The loop files the follow-ups through the API, as the identity that may create work.
  const ledgerRecord = record(reviewed, { launch: reviewed.reviewLaunch!.id, state: 'completed', verdict: { state: 'CHANGES_REQUESTED', reviewer: 'review-claude-1', reviewId: reviewed.reviewLaunch!.verdict!.reviewId, submittedAt: at } });
  const memory: string[][] = [];
  const createWork = async (body: unknown, requestId: string) => { const created = await request(tokenOf(admin), 'work', body, requestId); assert.equal(created.status, 200, JSON.stringify(created.body)); return { key: created.body.key as string }; };
  const outcome = await filePostMergeFollowUps(reviewed, ledgerRecord, { createWork, recordFindings: async (_work, _record, findings) => { memory.push(findings); } }, new Date());
  assert.deepEqual([outcome!.filed.length, outcome!.memory, outcome!.failure], [2, 2, undefined]);
  assert.deepEqual(memory, [['AC-1 unmet after merge.', '- Nit: naming of `x` is terse']]);
  for (const [index, entry] of outcome!.filed.entries()) {
    const followUp = (await store.pool.query('SELECT document FROM work_items WHERE document->>\'key\'=$1', [entry.key])).rows[0].document as Work;
    const finding = index === 0 ? { path: 'src/feature.ts', text: 'src/feature.ts:12 — the flag is never read' } : { path: 'src/other.ts', text: 'src/other.ts — the retry loop never ends' };
    assert.deepEqual([followUp.type, followUp.priority, followUp.plannedFiles, followUp.policy.review, followUp.stage], ['bug', 1, [finding.path], true, 'backlog']);
    assert.deepEqual(followUp.origin, { reviewFollowUps: { parent: 'GY-9101', findings: [{ ...finding, ref: M }] } });
    assert.match(followUp.title, /^Post-merge review of GY-9101 \(cccccccccccc\): /);
    assert.match(followUp.description, new RegExp(`delivered as merge commit ${M}`));
  }
  // The same filing again replays: the keys repeat and nothing new is created.
  const again = await filePostMergeFollowUps(reviewed, { ...ledgerRecord, postMergeFollowUps: { ...outcome!, filed: [] } }, { createWork }, new Date());
  assert.deepEqual(again!.filed.map(entry => entry.key), outcome!.filed.map(entry => entry.key));
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM work_items WHERE document->>\'title\' LIKE \'Post-merge review of GY-9101%\'')).rows[0].n, 2);
  // The delivered item was never reopened.
  const untouched = await stored(work.id);
  assert.deepEqual([untouched.stage, untouched.delivery, untouched.lease, untouched.postMergeReview], ['done', work.delivery, null, 'reviewed']);
});
