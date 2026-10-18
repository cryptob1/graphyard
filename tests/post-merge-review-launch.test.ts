import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { dispatchFailureLimit, emptyDispatchCursor, runDispatchTick, unknownParent, type DispatchEffects } from '../src/auto-dispatch.js';
import { owedPostMergeReviews, postMergeRequestId, postMergeRefusalProbeMs } from '../src/model/post-merge-review.js';
import { launchReview, readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { readReviewBinding } from '../src/review-post.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
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
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true }, plannedFiles: ['src/feature.ts'],
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
let pg: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string;
let root: string, credentialDirectory: string, config: Awaited<ReturnType<typeof loadMasterConfig>>;
const herdrCalls: string[][] = [];
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1548;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('post-merge-launch-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('post_merge_launch_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/post_merge_launch_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  // The loop's own checkout, with one reviewer profile and the reviewer identity the production loop
  // registers (GY-2008): the configured reviewer App's bot login. In control-plane mode the App's
  // credential is never read, so the binding alone drives the identity.
  root = await temporaryDirectory('post-merge-launch-master');
  credentialDirectory = await temporaryDirectory('post-merge-launch-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${repository}.git`], { cwd: root });
  const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: coordinator.id, role: coordinator.role }, repository, baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url, token: tokenOf(coordinator), cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
  await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude', concurrency: 4 });
  const file = join(root, '.graphyard/master.json');
  const storedConfig = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  storedConfig.reviewer = { appId: 4242, installationId: 99, slug: 'graphyard-reviewer', credentialFile: join(credentialDirectory, 'reviewer.json'), boundAt: at() };
  await writeFile(file, JSON.stringify(storedConfig, null, 2));
  config = await loadMasterConfig(root);
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });

const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
const insert = async (work: Work) => { await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]); return work; };
const request = async (credential: string, path: string, body?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const verdictBody = 'AC-1 met after the merge.\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none';

const herdr = (_command: string, args: string[]) => { herdrCalls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' }, tab: { tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); };
/** The real post-merge wiring: the launch through `launchReview`, registration through the real route, keyed like `dispatchEffects` keys it. */
const realLaunch = (work: Work, requestId: string) => launchReview(root, work, 'reviewer-claude', [], at(), {
  run: herdr, requestId, postMerge: { mergeSha: work.delivery!.mergeSha, ...(work.mergeLedger!.baseTip !== unknownParent ? { baseTip: work.mergeLedger!.baseTip } : {}) },
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
  // The plane registered the launch: post-merge, on the merge commit, as the configured reviewer App's bot identity.
  const registered = await stored(work.id);
  assert.equal(registered.reviewLaunch!.postMerge, true);
  assert.deepEqual([registered.reviewLaunch!.head, registered.reviewLaunch!.baseTip, registered.reviewLaunch!.reviewer, registered.reviewLaunch!.requester], [M, B, 'graphyard-reviewer[bot]', coordinator.id]);
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
