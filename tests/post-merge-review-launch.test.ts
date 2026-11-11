import { after, before } from 'node:test';
import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { dispatchFailureLimit, emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { unknownParent } from '../src/dispatch/post-merge.js';
import { type DispatchEffects } from '../src/dispatch/effects.js';
import { owedPostMergeReviews, postMergeRequestId, postMergeRefusalProbeMs } from '../src/model/post-merge-review.js';
import { launchReview, readReviewLedger, saveReviewerProfile, reviewRetryPrompt } from '../src/reviewer.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { readReviewBinding } from '../src/review-post.js';
import { startedAtOnce, expandTypedCommand, requestOf } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { registryFixture } from './helpers/registry-fixture.js';
// Every instant this file holds is derived from the run's own clock (GY-1694): a base reading taken
// at load and offsets from it. No calendar literal is constructed, so no wall-clock reading here is
// judged against a fixed date.

// GY-2075: a post-merge review request for a control-plane merge with no pull request — the merge
// writer's delivery, where `postMergeRequest` reads pr 0 — launches its reviewer through the real
// launch path and the real review-launch route, records the session, and takes its verdict; and a
// request the loop stopped relaunching after repeated launch refusals is probed again one hour after
// its last refusal, so it launches once the refusal's cause is gone.

const H = 'a'.repeat(40), B = 'b'.repeat(40), M = 'c'.repeat(40);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const base = new Date();
const at = (offsetMs = 0) => new Date(base.getTime() + offsetMs).toISOString();

/** A delivered control-plane merge with no pull request anywhere: the candidate and submission carry no pr, so the post-merge request reads pr 0. */
function deliveredPrLess(key: string): Work {
  const candidate = { sha: H, baseSha: B, branch: `graphyard/${key.toLowerCase()}-1`, author: 'graphyard-opencode-1' };
  return { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true },
    stage: 'done', revision: 9, policyRevision: 1, createdAt: at(), updatedAt: at(), stageEnteredAt: at(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: candidate.author }], candidate, submission: { epoch: 1 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: [candidate.author], postMergeReview: 'owed', systemDriven: true,
    delivery: { mergedAt: at(), mergeSha: M, authorizationRevision: 8 },
    mergeLedger: { key, state: 'reconciled', head: H, baseTip: B, mergeSha: M, risk: 'normal', intentAt: at(), pushedAt: at(), observedTip: M, refusal: null, events: 3 },
    observation: { source: 'control-plane', at: at(), candidate, checks: [], reviews: [], merged: true, mergeSha: M, mergedAt: at(), mergeable: true, protected: false,
      files: ['src/feature.ts'], scopeFiles: [{ path: 'src/feature.ts', status: 'modified', sha: sha('f'), additions: 2, deletions: 1, binary: false }], baseTip: B, baseTipContained: true },
  } as unknown as Work;
}

const repository = 'owner/project';
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const principals = [admin, coordinator];
const credentials = principals.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const tokenOf = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let store: Store, http: ReturnType<typeof server>, url: string;
let root: string, credentialDirectory: string, config: Awaited<ReturnType<typeof loadMasterConfig>>, fleet: ReturnType<typeof registryFixture>['probe'];
const herdrCalls: string[][] = [];
before(async () => {
  store = await withDatabase('post-merge-review-launch'); await store.init();
  const engine = new Engine(store, 120, repository);
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  // The loop's own checkout, with one reviewer profile.
  root = await temporaryDirectory('post-merge-launch-master');
  credentialDirectory = await temporaryDirectory('post-merge-launch-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${repository}.git`], { cwd: root });
  const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: coordinator.id, role: coordinator.role }, repository, baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url, token: tokenOf(coordinator), cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard', run: { worktreeRoot: await temporaryDirectory('post-merge-launch-checkouts', '/var/tmp') } }, coordinatorStatus as typeof fetch);
  await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude', concurrency: 4 });
  config = await loadMasterConfig(root);
  // GY-3030: the registry is the only authority for a reviewer's slot; each item reviewed here takes one.
  fleet = registryFixture(config.hostId, ['claude'], ['reviewer'], 8).probe;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); });

const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
const insert = async (work: Work) => { await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]); return work; };
const request = async (credential: string, path: string, body?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const verdictBody = 'AC-1 met after the merge.\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none';

const herdr = (_command: string, args: string[]) => { herdrCalls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' }, tab: { tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); };
/** The merge commit's first parent when the ledger names one; the launcher reads it from the object store when not. */
const mergeBaseTip = (work: Work) => { const tip = work.mergeLedger?.baseTip; return tip && tip !== unknownParent ? { baseTip: tip } : {}; };
/** The real post-merge wiring: the launch through `launchReview`, registration through the real route, keyed like `dispatchEffects` keys it. */
const realLaunch = (work: Work, requestId: string) => launchReview(root, work, 'reviewer-claude', [], at(), {
  run: herdr, probe: fleet, requestId, postMerge: { mergeSha: work.delivery!.mergeSha, ...mergeBaseTip(work) },
});
const items: Work[] = [];
const effects: DispatchEffects = {
  snapshot: async () => ({ work: items, now: at() }),
  agents: () => [],
  credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
  reconcileReviews: async () => ({ reviews: [] }),
  reconcileProducers: async () => ({ producers: [] }),
  launchReview: async () => {},
  launchProducer: async () => {},
  launchPostMergeReview: (work, request) => realLaunch(work, request.id),
  persist: async () => {},
};

/** The verdict the launched session would post, read from the binding its session directory carries, sent as the launch's one-time token. */
async function postSessionVerdict(work: Work) {
  const tab = herdrCalls.filter(args => args[0] === 'tab' && args[1] === 'create').at(-1)!;
  const directory = tab.find(value => value.startsWith('GH_CONFIG_DIR='))!.slice('GH_CONFIG_DIR='.length);
  const binding = await readReviewBinding(directory);
  assert.deepEqual([binding.mode, binding.key, binding.sha, binding.baseTip], ['control-plane', work.key, M, B], 'the binding names the merge commit and its parent, and no pull request');
  assert.match(binding.verdictToken!, /^[0-9a-f]{64}$/);
  return request(binding.verdictToken!, `work/${work.id}/review-verdict`, { event: 'APPROVE', body: verdictBody, sha: M, token: binding.verdictToken });
}

test('unit:post-merge-review-without-pr-launches — a post-merge request for a control-plane merge with no pull request (pr 0) launches its reviewer through the real launch path and the real review-launch route, records the session, and takes its verdict instead of a 400', async () => {
  const work = await insert(deliveredPrLess('GY-9001'));
  items[0] = work;
  assert.deepEqual(owedPostMergeReviews([work]).map(item => item.key), ['GY-9001']);
  const cursor = emptyDispatchCursor(config);
  const tick = await runDispatchTick(config, cursor, effects, () => Date.parse(at()));
  assert.deepEqual(tick.refused, [], JSON.stringify(tick.refused));
  assert.deepEqual(tick.launched.map(launch => [launch.kind, launch.work, launch.requestId]), [['review', 'GY-9001', postMergeRequestId('GY-9001', M)]], 'the launch went out, not a 400');
  // The plane registered the launch: post-merge, on the merge commit, as the reviewer profile's identity.
  const registered = await stored(work.id);
  assert.equal(registered.reviewLaunch!.postMerge, true);
  assert.deepEqual([registered.reviewLaunch!.head, registered.reviewLaunch!.baseTip, registered.reviewLaunch!.reviewer, registered.reviewLaunch!.requester], [M, B, 'review-claude-1', coordinator.id]);
  assert.equal(registered.reviewLaunch!.verdict, null);
  // The session is on the ledger: control-plane mode, post-merge, under the request id, and the record's pr is positive —
  // `reviewRecordSchema` requires it, and the binding's `|| 1` stands in for the pull request the merge never had.
  const record = (await readReviewLedger(root)).reviews.at(-1)!;
  assert.deepEqual([record.pr > 0, record.mode, record.postMerge, record.requestId, record.state], [true, 'control-plane', true, postMergeRequestId('GY-9001', M), 'pending']);
  // The launched session posts its verdict as the token, and the delivered item reads reviewed without being reopened.
  const verdict = await postSessionVerdict(work);
  assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
  assert.deepEqual([verdict.body.postMerge, verdict.body.state], [true, 'APPROVED']);
  const reviewed = await stored(work.id);
  assert.deepEqual([reviewed.stage, reviewed.postMergeReview], ['done', 'reviewed']);
  assert.equal(reviewed.observation!.reviews.length, 1);
  assert.deepEqual([reviewed.reviewLaunch!.verdict!.state, reviewed.reviewLaunch!.verdict!.source], ['APPROVED', 'control-plane']);
  assert.deepEqual(owedPostMergeReviews([reviewed]), [], 'nothing is owed once the session is recorded');
});

test('unit:post-merge-review-refused-launch-recovers — a request the loop stopped relaunching after repeated launch refusals is probed again one hour after its last refusal and launches once the refusal\'s cause is gone', async () => {
  const work = await insert(deliveredPrLess('GY-9002'));
  items[0] = work;
  let launches = 0;
  const refusal = new Error('The control plane refused the reviewer launch of GY-9002 (400): Invalid input');
  const refusing: DispatchEffects = { ...effects, launchPostMergeReview: async () => { launches++; throw refusal; } };
  const cursor = emptyDispatchCursor(config);
  const requestId = postMergeRequestId('GY-9002', M);
  let clockMs = Date.parse(at());
  // Twelve refusals on the widening retry: each wait names the next attempt, nothing launches twice.
  for (let attempt = 1; attempt <= dispatchFailureLimit; attempt++) {
    const tick = await runDispatchTick(config, cursor, refusing, () => clockMs);
    assert.deepEqual(tick.launched, []);
    assert.deepEqual(tick.refused.map(entry => entry.attempts), [attempt]);
    assert.equal(cursor.failures[requestId]!.attempts, attempt);
    clockMs = Date.parse(cursor.failures[requestId]!.nextAt) + 1;
  }
  assert.equal(cursor.failures[requestId]!.attempts, dispatchFailureLimit);
  // Past the limit the request is not stranded: the wait names the hourly probe, and inside the
  // standstill hour the loop launches nothing.
  const strandedAt = Date.parse(cursor.failures[requestId]!.at);
  const waiting = await runDispatchTick(config, cursor, refusing, () => clockMs);
  assert.deepEqual(waiting.launched, []);
  assert.match(waiting.waiting.at(-1)!.reason, /probed again every 60 minutes/);
  assert.match(waiting.waiting.at(-1)!.reason, /launches once the refusal's cause is gone/);
  clockMs = strandedAt + postMergeRefusalProbeMs - 60_000;
  const inside = await runDispatchTick(config, cursor, refusing, () => clockMs);
  assert.deepEqual(inside.launched, []);
  assert.equal(launches, dispatchFailureLimit, 'the probe is one attempt per standstill hour, not the backoff');
  // One hour after the last refusal the loop probes again; the cause still stands, so the refusal
  // counts and the next probe waits another hour.
  clockMs = strandedAt + postMergeRefusalProbeMs + 1;
  const probe = await runDispatchTick(config, cursor, refusing, () => clockMs);
  assert.deepEqual(probe.launched, []);
  assert.equal(probe.refused.length, 1);
  assert.equal(cursor.failures[requestId]!.attempts, dispatchFailureLimit + 1);
  // The refusal's cause is gone: the next probe launches through the real path, clears the record,
  // registers the launch on the plane, and its verdict marks the debt reviewed.
  clockMs = Date.parse(cursor.failures[requestId]!.at) + postMergeRefusalProbeMs + 1;
  const recovered = await runDispatchTick(config, cursor, effects, () => clockMs);
  assert.deepEqual(recovered.launched.map(launch => [launch.kind, launch.requestId]), [['review', requestId]], JSON.stringify({ refused: recovered.refused, waiting: recovered.waiting }));
  assert.equal(cursor.failures[requestId], undefined, 'the launch that succeeds clears the refusal');
  const registeredItem = await stored(work.id);
  assert.equal(registeredItem.reviewLaunch!.postMerge, true);
  assert.deepEqual([registeredItem.reviewLaunch!.head, registeredItem.reviewLaunch!.baseTip], [M, B]);
  const session = (await readReviewLedger(root)).reviews.filter(entry => entry.requestId === requestId).at(-1)!;
  assert.deepEqual([session.pr > 0, session.mode, session.state], [true, 'control-plane', 'pending']);
  const verdict = await postSessionVerdict(work);
  assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
  const reviewedItem = await stored(work.id);
  assert.equal(reviewedItem.postMergeReview, 'reviewed');
  assert.deepEqual(owedPostMergeReviews([reviewedItem]), []);
});

test('integration:review-brief-proof-bindings — real ordinary and post-merge launches retain exact task proof inputs for retries', async () => {
  // GY-3055 COMMENT3006142 stopped on these reviewer-selected paths, even though
  // authorized surrounding-code reads were available. Reproduce the exact search and recover.
  const discovery = await temporaryDirectory('review-brief-path-discovery');
  await symlink(fileURLToPath(new URL('../', import.meta.url)), join(discovery, 'checkout'));
  const pattern = 'reviewLaunch|specCheckLaunch|policyRevision';
  assert.throws(() => execFileSync('rg', ['-n', pattern,
    'checkout/src/server/routes/review.ts', 'checkout/src/model/post-merge-review.ts',
    'checkout/tests/review-verdict.test.ts', 'checkout/tests/spec-check.test.ts',
  ], { cwd: discovery, stdio: 'pipe' }), (error: any) => {
    assert.equal(error.status, 2);
    assert.match(error.stderr.toString(), /checkout\/src\/server\/routes\/review.ts: No such file or directory/);
    assert.match(error.stderr.toString(), /checkout\/tests\/spec-check.test.ts: No such file or directory/);
    return true;
  });
  const paths = execFileSync('rg', ['--files', 'checkout/src', 'checkout/tests'], { cwd: discovery, encoding: 'utf8' }).split('\n');
  const corrected = ['checkout/src/server/review-verdict.ts', 'checkout/tests/spec-check-before-dispatch.test.ts'];
  for (const path of corrected) assert.ok(paths.includes(path));
  assert.match(execFileSync('rg', ['-n', pattern, ...corrected], { cwd: discovery, encoding: 'utf8' }), /reviewLaunch|specCheckLaunch|policyRevision/);
  for (const postMerge of [false, true]) {
    const work = deliveredPrLess(postMerge ? 'GY-9011' : 'GY-9010');
    // The criterion text deliberately supplies no proof or path: only structured launch inputs do.
    work.criteria = [{ id: 'AC-1', text: 'The reviewer receives executable coverage bindings.', proofs: ['integration:review-brief-proof-bindings', 'e2e:review-brief-proof-bindings'] }];
    work.scenarioRequirements = [{ proof: 'e2e:review-brief-proof-bindings', revision: 7, environment: 'uat', hash: 'd'.repeat(64) }];
    if (!postMerge) {
      work.candidate!.pr = 9010;
      work.stage = 'review'; work.delivery = undefined; work.postMergeReview = undefined;
      work.observation!.merged = false; work.observation!.mergeSha = null;
    }
    await insert(work);
    const prompts: string[] = [];
    const run = (command: string, args: string[]) => {
      if (args[0] === 'pane' && args[1] === 'run') {
        const launch = expandTypedCommand(args[3]);
        prompts.push(requestOf(launch.kind, launch.args)!);
      }
      return herdr(command, args);
    };
    await launchReview(root, work, 'reviewer-claude', [], at(), { run, probe: fleet, ...(postMerge ? { postMerge: { mergeSha: M, baseTip: B } } : {}) });
    const record = (await readReviewLedger(root)).reviews.find(entry => entry.key === work.key)!;
    assert.deepEqual(record.reviewInputs, { criteria: work.criteria, scenarioRequirements: work.scenarioRequirements });
    // A changed later snapshot must not replace the launch facts when its session is reminded.
    const retry = reviewRetryPrompt(repository, record, [{ id: 'AC-9', text: 'Later data', proofs: ['e2e:wrong-case'] }], launcher);
    assert.match(retry, /otherwise finish the authorized reads and judge it before posting/);
    assert.equal(prompts.length, 1);
    for (const brief of [prompts[0], retry]) {
      assert.match(brief, /\[AC-1\] proofs:/);
      for (const proof of work.criteria[0].proofs) assert.ok(brief.includes(proof));
      assert.ok(brief.includes('"caseId":"review-brief-proof-bindings","path":"e2e/cases/review-brief-proof-bindings.json"'));
      assert.ok(brief.includes('"revision":7,"environment":"uat","hash":"' + 'd'.repeat(64) + '"'));
      assert.ok(brief.includes(`git show ${postMerge ? M : H}:PATH`));
      assert.ok(brief.includes(`git diff ${B} ${postMerge ? M : H}`));
      assert.ok(brief.includes(`node ${launcher} guide review`));
      assert.match(brief, /policy revision 1/);
      assert.match(brief, /missing later trusted results do not block review; missing or inadequate test implementation can/);
      assert.match(brief, /Post exactly one verdict/);
      assert.match(brief, /one review posted with --event COMMENT/);
      assert.match(brief, /one-time token/);
      assert.match(brief, /mistyped or nonexistent exploratory path or guessed command is not itself an operational blocker/);
      assert.match(brief, /Discover the correct path with rg --files or command with CLI --help, then retry the authorized read/);
      assert.match(brief, /necessary input remains unavailable through authorized equivalent reads/);
      assert.match(brief, /genuine permission, identity, binding or runtime failure prevents judging it/);
      assert.match(brief, /Do not blanket-ignore errors, run builds\/tests\/servers, edit code, expand credentials, guess evidence or weaken a criterion/);
      assert.doesNotMatch(brief, /If a command you need is refused or cannot succeed/);
      assert.doesNotMatch(brief, /Later data|e2e:wrong-case|graphyard show GY-/);
    }
    assert.deepEqual([record.sha, record.baseSha, record.policyRevision], [postMerge ? M : H, B, 1]);
    assert.equal((await stored(work.id)).reviewLaunch!.reviewer, 'review-claude-1');
    await assert.rejects(launchReview(root, work, 'reviewer-claude', [], at(), { run, probe: fleet, ...(postMerge ? { postMerge: { mergeSha: M, baseTip: B } } : {}) }), /pending|already/);
    assert.equal(prompts.length, 1, 'one session answers this head');
    const session = await readReviewBinding(record.sessionDirectory!);
    const body = { event: 'APPROVE', body: verdictBody, sha: record.sha, token: session.verdictToken };
    const accepted = await request(session.verdictToken!, `work/${work.id}/review-verdict`, body);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const repeated = await request(session.verdictToken!, `work/${work.id}/review-verdict`, body);
    assert.ok([401, 409].includes(repeated.status), 'the session cannot decide a second time');
  }
});
