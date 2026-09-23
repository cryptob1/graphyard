import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMasterStatus, loadMasterConfig, setupMaster } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { assertSessionLedgerRoom, bindReviewer, boundSessionLedger, launchReview, readReviewLedger, reconcileReviews, releaseClosedRequests, reviewLedgerSpec, saveReviewLedger, saveReviewerProfile, sessionLedgerBound, sessionLedgerHeadroom, sessionLedgerRetention, SessionLedgerFullError, type ReviewRecord } from '../src/reviewer.js';
import { producerLedgerSpec, readProducerLedger, saveProducerLedger, sessionRetry, sessionRetryLimit, type ProducerRecord } from '../src/producer.js';
import { ledgerRefusalAttention } from '../src/cli/master-status.js';
import type { Observation, Work } from '../src/model.js';

// Each test is named for the proof it produces (GY-131): unit:terminal-reviews-reaped,
// integration:full-ledger-still-launches, unit:ledgers-share-one-bound and
// integration:ledger-refusal-attributed. The review ledger used to be an append-only array capped
// at 200 by its schema; it filled with finished records and refused every review launch, while
// `master status` blamed a busy reviewer agent.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
const terminal = ['completed', 'failed', 'cancelled', 'expired'] as const;
const at = (minute: number) => new Date(Date.UTC(2026, 8, 23, 0, 0, 0) + minute * 60_000).toISOString();

function review(index: number, state: ReviewRecord['state'], extra: Partial<ReviewRecord> = {}): ReviewRecord {
  return { id: randomUUID(), key: `GY-${1000 + index}`, pr: 1000 + index, sha: H, baseSha: B, policyRevision: 1, profile: 'claude-reviewer', agentName: `review-claude-1-${index}`,
    pane: null, sessionDirectory: `/nonexistent/sessions/${index}`, requestedAt: at(index), tokenExpiresAt: at(index + 60), state, ...(state === 'pending' ? {} : { closedAt: at(index + 1) }), ...extra };
}
function producer(index: number, state: ProducerRecord['state'], extra: Partial<ProducerRecord> = {}): ProducerRecord {
  return { id: randomUUID(), requestId: `request-${index}`, attempt: 1, key: `GY-${1000 + index}`, pr: 1000 + index, sha: H, baseSha: B, policyRevision: 1, group: 'unit', proofs: ['unit:example'],
    profile: 'claude-producer', principal: 'graphyard-producer-1', agentName: `proof-claude-1-${index}`, pane: null, requestedAt: at(index), expiresAt: at(index + 60), state, outcome: {},
    ...(state === 'pending' ? {} : { closedAt: at(index + 1), requestClosedAt: at(index + 1) }), ...extra };
}

async function ledgerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-ledger-cap-'));
  await mkdir(join(root, '.graphyard'), { recursive: true, mode: 0o700 });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function boundMaster() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-ledger-cap-')), credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-ledger-cap-credentials-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}
/** Writes the ledger file as a host that predates the bound would have left it: every record, unreaped. */
const writeRawReviewLedger = (root: string, reviews: ReviewRecord[]) => writeFile(join(root, '.graphyard/reviews.json'), JSON.stringify({ version: 1, reviews }), { mode: 0o600 });

function observation(candidate: { sha: string; baseSha: string }): Observation {
  return { candidate: { ...candidate, pr: 131, branch: 'graphyard/gy-131-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true } as Observation;
}
function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 131, branch: 'graphyard/gy-131-1', author: 'implementer' };
  return { id: 'work-131', key: 'GY-131', title: 'Review ledger cap', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Review', proofs: ['unit:terminal-reviews-reaped'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 7, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 131 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as unknown as Work;
}
/** A Herdr stub: the tab create names pane-review, pane list reports the panes gone. */
const herdrRun = (calls: string[][]) => (_command: string, args: string[]) => {
  calls.push(args);
  return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
};

test('unit:terminal-reviews-reaped — a review reaching a terminal state is reaped in the write that resolves it, keeping every live record and only the retention window of terminal ones', async () => {
  const { root, cleanup } = await ledgerRoot();
  try {
    // 20 live sessions; they resolve one write at a time, far past the retention window.
    const records = Array.from({ length: 20 }, (_, index) => review(index, 'pending'));
    await saveReviewLedger(root, { version: 1, reviews: records });
    for (let round = 0; round < 3; round++) for (let index = 0; index < 100; index++) {
      const ledger = await readReviewLedger(root);
      // Resolve the oldest live record — each terminal state in turn — and launch a fresh live one in its place.
      const target = ledger.reviews.find(record => record.state === 'pending')!;
      target.state = terminal[index % terminal.length]; target.closedAt = at(1000 + round * 100 + index);
      const fresh = review(100 + round * 100 + index, 'pending');
      await saveReviewLedger(root, { ...ledger, reviews: [...ledger.reviews, fresh] });
      const after = (await readReviewLedger(root)).reviews;
      const live = after.filter(record => record.state === 'pending'), settled = after.filter(record => record.state !== 'pending');
      assert.equal(live.length, 20, 'every live record is kept');
      assert.ok(live.some(record => record.id === fresh.id), 'the new live record is written');
      assert.ok(settled.length <= sessionLedgerRetention, `at most ${sessionLedgerRetention} terminal records are retained`);
      assert.ok(after.length <= sessionLedgerBound, 'the ledger never passes its bound');
      assert.ok(settled.some(record => record.id === target.id), 'the record just resolved is inside the retention window');
    }
    // What remains is exactly the newest terminal records; every older one was dropped.
    const final = (await readReviewLedger(root)).reviews.filter(record => record.state !== 'pending');
    assert.equal(final.length, sessionLedgerRetention);
    const oldestKept = Math.min(...final.map(record => Date.parse(record.closedAt!)));
    assert.equal(oldestKept, Date.parse(at(1000 + 300 - sessionLedgerRetention)), 'the retention window is the newest records by when they settled');
    // A ledger the old code left full of finished records is brought inside the window by its next write.
    const full = Array.from({ length: 200 }, (_, index) => review(index, terminal[index % terminal.length]));
    await writeRawReviewLedger(root, full);
    const read = await readReviewLedger(root);
    assert.equal(read.reviews.length, 200, 'a ledger at the old cap is still readable');
    await saveReviewLedger(root, read);
    assert.equal((await readReviewLedger(root)).reviews.length, sessionLedgerRetention);
  } finally { await cleanup(); }
});

test('unit:terminal-reviews-reaped — a request exhausted at its retry limit stays exhausted however many unrelated sessions settle, until the control plane stops requesting it', async () => {
  const { root, cleanup } = await ledgerRoot();
  try {
    // GY-131 review: the retry bound is read from the request's own records, so reaping them while
    // the request stands would reset it to "launch" and relaunch it every time the window rolled past.
    const requestId = 'request-exhausted', attempts = Array.from({ length: sessionRetryLimit }, (_, index) => producer(index, 'failed', { requestId, attempt: index + 1, key: 'GY-131', acknowledgedAt: at(index), requestClosedAt: undefined, resolution: 'the session finished without trusted evidence' }));
    const openItem = work({ stage: 'acceptance', autoDispatch: { review: null, producers: [{ id: requestId, kind: 'producer', state: 'requested' }], history: [] } } as unknown as Partial<Work>);
    let records: ProducerRecord[] = [...attempts];
    const exhausted = (list: ProducerRecord[]) => sessionRetry(list, requestId, Date.parse(at(10_000)));
    assert.equal(exhausted(records).exhausted, true, 'the request starts exhausted');
    // Far more than the retention window of unrelated sessions settle, each on its own write.
    for (let index = 0; index < 3 * sessionLedgerRetention; index++) {
      const other = producer(100 + index, 'completed', { requestId: `request-other-${index}`, requestClosedAt: undefined, closedAt: at(5000 + index) });
      records = [...records, other];
      releaseClosedRequests(records, [openItem], new Date(at(5000 + index)));
      await saveProducerLedger(root, { version: 1, producers: records });
      records = (await readProducerLedger(root)).producers;
    }
    assert.equal(records.filter(record => record.requestId === requestId).length, sessionRetryLimit, 'every record of the open request is kept');
    assert.equal(records.filter(record => record.requestId !== requestId).length, sessionLedgerRetention, 'the unrelated ones are reaped to the retention window');
    const retry = exhausted(records);
    assert.equal(retry.exhausted, true, 'the request still reports exhausted');
    assert.equal(retry.launch, false, 'and is not relaunched');
    assert.equal(retry.attempts, sessionRetryLimit);
    // Once the control plane stops requesting it, its records join the window and are reaped like any other.
    releaseClosedRequests(records, [{ ...openItem, autoDispatch: { review: null, producers: [], history: [] } } as unknown as Work], new Date(at(9000)));
    await saveProducerLedger(root, { version: 1, producers: records });
    assert.equal((await readProducerLedger(root)).producers.filter(record => record.requestId === requestId).length, 0, 'a closed request settled long ago is reaped');
  } finally { await cleanup(); }
});

test('unit:terminal-reviews-reaped — a pending session never adopts the verdict of a session reaped out of the window on the same head', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const config = await loadMasterConfig(root);
    const reviewer = `${config.reviewer!.slug}[bot]`;
    // A hand-launched review (no request) on GY-131 at H posted verdict 11 and settled first; a
    // relaunch for the same head is pending; many unrelated reviews settle after it.
    const answered = review(0, 'completed', { key: 'GY-131', verdict: { state: 'APPROVED', reviewer, reviewId: 11, submittedAt: at(1) } });
    const pending = review(1, 'pending', { key: 'GY-131', tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const others = Array.from({ length: 2 * sessionLedgerRetention }, (_, index) => review(10 + index, 'completed', { closedAt: at(100 + index) }));
    await saveReviewLedger(root, { version: 1, reviews: [answered, pending, ...others] });
    const kept = (await readReviewLedger(root)).reviews;
    assert.ok(kept.some(record => record.id === answered.id), 'the verdict a pending session of the same head reads is pinned');
    assert.equal(kept.filter(record => record.state !== 'pending' && record.id !== answered.id).length, sessionLedgerRetention);
    // GitHub still holds review 11 on H: the pending session must see it as answered, not adopt it.
    const seen: number[][] = [];
    const observe = (_record: ReviewRecord, _identity: string, ids: Set<number>) => { seen.push([...ids]); return ids.has(11) ? null : { state: 'APPROVED', reviewer, reviewId: 11, submittedAt: at(1) }; };
    const reconciled = (await reconcileReviews(root, config, { run: herdrRun([]), observe, work: [work()], agents: null })).reviews;
    assert.deepEqual(seen, [[11]], 'the pending session is told verdict 11 is already answered');
    assert.equal(reconciled.find(record => record.id === pending.id)!.state, 'pending', 'it does not adopt the old verdict');
    // Once the pending session settles and the item leaves H, nothing reads the old verdict and it is reaped like any other.
    const settled = reconciled.map(record => record.id === pending.id ? { ...record, state: 'cancelled' as const, closedAt: at(1000) } : record);
    releaseClosedRequests(settled, [work({ candidate: { sha: sha40('c2'), baseSha: B, pr: 131, branch: 'graphyard/gy-131-1', author: 'implementer' } as any })], new Date(at(1001)));
    await saveReviewLedger(root, { version: 1, reviews: settled });
    assert.equal((await readReviewLedger(root)).reviews.some(record => record.id === answered.id), false);
  } finally { await cleanup(); }
});

test('unit:terminal-reviews-reaped — an approval whose request closed is kept while its head is the candidate, so a relaunch after a same-head dismissal never adopts it', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const config = await loadMasterConfig(root);
    const reviewer = `${config.reviewer!.slug}[bot]`;
    // GY-131 review of 84d2a4f: the approval answered its request, the request closed, and only
    // then was the approval dismissed with the head unchanged (a recomputed merge base). No session
    // of H was pending in between, so pinning by a pending session could not keep the record.
    const approval = review(0, 'completed', { key: 'GY-131', requestId: 'request-first', attempt: 1, verdict: { state: 'APPROVED', reviewer, reviewId: 11, submittedAt: at(1) } });
    const item = work();
    let records: ReviewRecord[] = [approval];
    releaseClosedRequests(records, [item], new Date(at(2)));
    assert.ok(approval.requestClosedAt, 'the answered request is released');
    assert.equal(approval.headReleasedAt, undefined, 'the head it approved is still the candidate');
    for (let index = 0; index < 3 * sessionLedgerRetention; index++) {
      records = [...records, review(10 + index, 'completed', { closedAt: at(100 + index) })];
      releaseClosedRequests(records, [item], new Date(at(100 + index)));
      await saveReviewLedger(root, { version: 1, reviews: records });
      records = (await readReviewLedger(root)).reviews;
    }
    assert.ok(records.some(record => record.id === approval.id), 'the approval outlives the retention window while H is the candidate');
    assert.equal(records.filter(record => record.id !== approval.id).length, sessionLedgerRetention, 'everything else is reaped to the window');
    // The dismissal reopens the request for the same commit: a fresh session of H is launched.
    const relaunch = review(1, 'pending', { key: 'GY-131', requestId: 'request-second', attempt: 1, requestedAt: at(500), tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await saveReviewLedger(root, { version: 1, reviews: [...records, relaunch] });
    // GitHub lists review 11 as DISMISSED on H; an observer that does not know it is answered adopts it.
    const seen: number[][] = [];
    const observe = (_record: ReviewRecord, _identity: string, ids: Set<number>) => { seen.push([...ids]); return ids.has(11) ? null : { state: 'DISMISSED', reviewer, reviewId: 11, submittedAt: at(1) }; };
    const reconciled = (await reconcileReviews(root, config, { run: herdrRun([]), observe, work: [item], agents: null })).reviews;
    assert.deepEqual(seen, [[11]], 'the relaunched session is told verdict 11 is already answered');
    const after = reconciled.find(record => record.id === relaunch.id)!;
    assert.equal(after.state, 'pending', 'it is not recorded failed on the dismissed approval the moment it starts');
    assert.equal(after.verdict, undefined);
    // Delivered, the item no longer reads H's verdicts: the reconcile releases the head and the next write reaps the approval.
    const delivered = work({ stage: 'done' } as Partial<Work>);
    const closing = reconciled.map(record => record.id === relaunch.id ? { ...record, state: 'cancelled' as const, closedAt: at(2000) } : record);
    releaseClosedRequests(closing, [delivered], new Date(at(2001)));
    assert.ok(closing.find(record => record.id === approval.id)!.headReleasedAt, 'the head is released once the item is delivered');
    await saveReviewLedger(root, { version: 1, reviews: closing });
    assert.equal((await readReviewLedger(root)).reviews.some(record => record.id === approval.id), false, 'and the approval is reaped');
  } finally { await cleanup(); }
});

test('integration:full-ledger-still-launches — a ledger full of terminal records launches a review, and one full of live records refuses naming the ledger and the live count', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    // The 2026-09-23 state: 200 records, every one finished, none live.
    await writeRawReviewLedger(root, Array.from({ length: sessionLedgerBound }, (_, index) => review(index, terminal[index % terminal.length])));
    const calls: string[][] = [];
    const launched = await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun(calls), mint });
    const ledger = (await readReviewLedger(root)).reviews;
    assert.ok(ledger.some(record => record.id === launched.review && record.state === 'pending'), 'the review launched and was recorded');
    assert.equal(ledger.length, 1 + sessionLedgerRetention, 'terminal records were reaped to make room');
    assert.ok(calls.some(args => args[0] === 'tab' && args[1] === 'create'), 'a session was started');

    // At the bound with every record live, reaping frees nothing: the write is refused before any session exists.
    await writeRawReviewLedger(root, Array.from({ length: sessionLedgerBound }, (_, index) => review(index, 'pending')));
    const refusedCalls: string[][] = [];
    const refusal = await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun(refusedCalls), mint }).then(() => null, (error: Error) => error);
    assert.ok(refusal instanceof SessionLedgerFullError, 'the refusal is the ledger refusal');
    assert.match(refusal.message, /review ledger \(\.graphyard\/reviews\.json\) refused the write/, 'the refusal names the ledger');
    assert.match(refusal.message, /bound is 200 records and 200 are live sessions/, 'the refusal names the bound and the live count');
    assert.match(refusal.message, /not reviewer capacity/);
    assert.equal(refusedCalls.some(args => args[0] === 'tab' && args[1] === 'create'), false, 'no pane is created for a launch the ledger cannot record');
    assert.equal((await readReviewLedger(root)).reviews.length, sessionLedgerBound, 'the refused launch wrote nothing');

    // One terminal record at the bound is enough: it is reaped, even inside the retention window, and the write proceeds.
    const nearlyFull = [...Array.from({ length: sessionLedgerBound - 1 }, (_, index) => review(index, 'pending')), review(500, 'completed')];
    assert.doesNotThrow(() => assertSessionLedgerRoom(nearlyFull.filter(record => record.state === 'pending'), reviewLedgerSpec, 'GY-131'));
    const written = boundSessionLedger([...nearlyFull, review(501, 'pending')], reviewLedgerSpec);
    assert.equal(written.length, sessionLedgerBound);
    assert.equal(written.filter(record => record.state === 'pending').length, sessionLedgerBound, 'the terminal record gave way to the live one');
    // Records an open request still reads are not reaped to make room; with them the bound is still refused, by name.
    const openRequests = [...Array.from({ length: 150 }, (_, index) => review(index, 'pending')), ...Array.from({ length: 50 }, (_, index) => review(200 + index, 'failed', { requestId: `request-${index}` }))];
    assert.throws(() => assertSessionLedgerRoom(openRequests, reviewLedgerSpec, 'GY-131'), /review ledger \(\.graphyard\/reviews\.json\) refused the write: its bound is 200 records and 150 are live sessions, 50 more are terminal records an open request/);
    assert.equal(boundSessionLedger(openRequests, reviewLedgerSpec).length, sessionLedgerBound, 'at the bound, nothing an open request reads is dropped');
  } finally { await cleanup(); }
});

test('unit:ledgers-share-one-bound — the review and producer ledgers enforce the same bound and the same reaping rule', async () => {
  const { root, cleanup } = await ledgerRoot();
  try {
    const states = (index: number) => index % 7 === 0 ? 'pending' as const : terminal[index % terminal.length];
    // Every record answers a request; one in fifty requests is still open, so its terminal records are pinned in both.
    const open = (index: number) => index % 50 === 1;
    const request = (index: number) => ({ requestId: `request-${index}`, ...(open(index) || states(index) === 'pending' ? {} : { requestClosedAt: at(index + 1) }) });
    const reviews = Array.from({ length: 450 }, (_, index) => review(index, states(index), request(index)));
    const producers = Array.from({ length: 450 }, (_, index) => producer(index, states(index), open(index) ? { requestClosedAt: undefined } : {}));
    await saveReviewLedger(root, { version: 1, reviews });
    await saveProducerLedger(root, { version: 1, producers });
    const keptReviews = (await readReviewLedger(root)).reviews, keptProducers = (await readProducerLedger(root)).producers;
    // The same records survive in both: same live set, same retained terminal set, same order.
    const shape = (records: { key: string; state: string }[]) => records.map(record => `${record.key}:${record.state}`);
    assert.deepEqual(shape(keptProducers), shape(keptReviews), 'both ledgers keep exactly the same records');
    assert.equal(keptReviews.filter(record => record.state === 'pending').length, reviews.filter(record => record.state === 'pending').length, 'every live record is kept');
    const pinned = reviews.filter((record, index) => record.state !== 'pending' && open(index)).length;
    assert.ok(pinned > 0);
    assert.equal(keptReviews.filter(record => record.state !== 'pending' && !record.requestClosedAt).length, pinned, 'every terminal record of an open request is pinned');
    assert.equal(keptProducers.filter(record => record.state !== 'pending' && !record.requestClosedAt).length, pinned, 'the producer ledger pins the same records');
    assert.equal(keptReviews.filter(record => record.state !== 'pending' && record.requestClosedAt).length, sessionLedgerRetention, 'the rest keep only the retention window');
    // The producer ledger no longer grows to its own cap by truncation: it is inside the same bound.
    assert.ok(keptProducers.length <= sessionLedgerBound);
    // Both refuse at the same bound, each naming itself.
    const overReviews = Array.from({ length: sessionLedgerBound + 1 }, (_, index) => review(index, 'pending'));
    const overProducers = Array.from({ length: sessionLedgerBound + 1 }, (_, index) => producer(index, 'pending'));
    await assert.rejects(saveReviewLedger(root, { version: 1, reviews: overReviews }), /review ledger \(\.graphyard\/reviews\.json\) refused the write: its bound is 200 records and 201 are live/);
    await assert.rejects(saveProducerLedger(root, { version: 1, producers: overProducers }), /producer ledger \(\.graphyard\/producers\.json\) refused the write: its bound is 200 records and 201 are live/);
    assert.throws(() => assertSessionLedgerRoom(overProducers.slice(1), producerLedgerSpec, 'GY-131'), /producer ledger .* 200 are live/);
    assert.throws(() => assertSessionLedgerRoom(overReviews.slice(1), reviewLedgerSpec, 'GY-131'), /review ledger .* 200 are live/);
    // Headroom is reported the same way for both.
    const reviewRoom = sessionLedgerHeadroom(keptReviews, reviewLedgerSpec), producerRoom = sessionLedgerHeadroom(keptProducers, producerLedgerSpec);
    assert.deepEqual({ ...reviewRoom, ledger: null, path: null }, { ...producerRoom, ledger: null, path: null });
    assert.equal(reviewRoom.bound, sessionLedgerBound);
    assert.equal(reviewRoom.pinned, pinned);
    assert.equal(reviewRoom.headroom, sessionLedgerBound - reviewRoom.live - reviewRoom.pinned);
    assert.equal(JSON.parse(await readFile(join(root, '.graphyard/producers.json'), 'utf8')).producers.length, keptProducers.length);
  } finally { await cleanup(); }
});

test('integration:ledger-refusal-attributed — master status names a full ledger, its bound and the remedy, never a busy reviewer agent', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await writeRawReviewLedger(root, Array.from({ length: sessionLedgerBound }, (_, index) => review(index, 'pending')));
    const refusal = await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun([]), mint }).then(() => null, (error: Error) => error);
    assert.ok(refusal instanceof SessionLedgerFullError);
    const now = new Date().toISOString();
    // The item as the loop leaves it: an open review request, the dispatcher's refusal recorded
    // against it, and the executor's failed request-review row carrying the same refusal.
    const request = { id: 'review-request-131', kind: 'review' as const, sha: H, baseSha: B, policyRevision: 1, pr: 131, provider: 'github' as const, requestedAt: now, reason: 'observed head', state: 'requested' as const };
    const failed = { at: now, event: 'failed', reason: refusal.message, result: 'failed', executor: 'exec-1', requester: 'graphyard' };
    const item = work({ autoDispatch: { review: request, producers: [], history: [] },
      actionQueue: { actions: [{ id: 'row-1', key: 'GY-131', gate: 'review', kind: 'request-review', work: 'work-131', state: 'pending', attempts: 3, history: [failed, failed, failed], resolution: refusal.message, requestedAt: now }], history: [] } } as unknown as Partial<Work>);
    const status = buildMasterStatus({ work: [item], now }, [], [], {}, {}, { pending: [], completed: [] }, 'main', undefined,
      { producers: { pending: [], completed: [] }, failures: [{ requestId: request.id, kind: 'review', attempts: 3, reason: refusal.message, at: now, nextAt: now }] });
    // The symptom the board used to show beside the raw refusal.
    const busy = { subject: 'GY-131', text: "GY-131's request-review action is stalled, not retrying: 3 attempts in a row failed for one unchanged reason — reviewer agent review-claude-1 is busy in Herdr", owner: 'master' } as any;
    const attributed = ledgerRefusalAttention({ work: status.work, attentionItems: [...status.attentionItems, busy] }, [item]);
    const items = attributed.attentionItems.filter(entry => entry.subject === 'GY-131');
    assert.equal(items.length, 1, 'one attention item for the item');
    assert.match(items[0].text, /review ledger \(\.graphyard\/reviews\.json\) refused the write/, 'it names the ledger');
    assert.match(items[0].text, /bound is 200 records and 200 are live/, 'it names the bound and the live count');
    assert.match(items[0].text, /not reviewer capacity/);
    assert.doesNotMatch(items[0].text, /is busy in Herdr/, 'it is not reported as waiting on a busy reviewer agent');
    assert.match((items[0] as any).next ?? JSON.stringify(items[0]), /settle the live sessions/, 'it names the remedy');
    // The remedy says what a reconcile does with a session gone from Herdr: it waits out the idle grace, it does not settle it on that pass.
    assert.match(JSON.stringify(items[0]), /marked idle by the first pass that finds it gone and failed by the first pass after its 5-minute idle grace, not on the same one/);
    assert.doesNotMatch(JSON.stringify(items[0]), /settles on that pass/);
    const row = attributed.work.find((entry: { key: string }) => entry.key === 'GY-131') as { attention: string | null };
    assert.match(row.attention!, /review ledger/, 'the row names the ledger too');
    assert.doesNotMatch(row.attention!, /busy/);
    // counts.attention moves with the list: the superseded items leave the count as the one ledger item joins it.
    const counted = ledgerRefusalAttention({ work: status.work, attentionItems: [...status.attentionItems, busy], counts: { attention: status.attentionItems.length + 1 } }, [item]);
    assert.equal(counted.counts!.attention, counted.attentionItems.length, 'the count matches the listed items');
    // A refusal that no longer stands is not attributed: the action failed once on the full ledger, then was claimed again, or completed.
    const recovered = (events: object[]) => work({ autoDispatch: { review: request, producers: [], history: [] },
      actionQueue: { actions: [{ id: 'row-1', key: 'GY-131', gate: 'review', kind: 'request-review', work: 'work-131', state: 'claimed', attempts: 2, history: [failed, ...events], requestedAt: now }], history: [] } } as unknown as Partial<Work>);
    const running = { subject: 'GY-131', text: 'GY-131 is under review by review-claude-1', owner: 'master' } as any;
    for (const events of [[{ ...failed, event: 'claimed', reason: 'claimed' }], [{ ...failed, event: 'claimed', reason: 'claimed' }, { ...failed, event: 'completed', reason: 'review requested', result: 'done' }]]) {
      const later = recovered(events);
      const quiet = ledgerRefusalAttention({ work: [{ key: 'GY-131', attention: running.text, dispatch: null }], attentionItems: [running], counts: { attention: 1 } }, [later]);
      assert.deepEqual(quiet.attentionItems, [running], 'the running reviewer is still what the item shows');
      assert.equal(quiet.counts!.attention, 1);
    }
    // Nothing is rewritten for an item whose launch was not refused by a ledger.
    const untouched = ledgerRefusalAttention({ work: [{ key: 'GY-7', attention: 'reviewer agent review-claude-1 is busy in Herdr', dispatch: null }], attentionItems: [busy] }, []);
    assert.equal(untouched.attentionItems.length, 1);
  } finally { await cleanup(); }
});
