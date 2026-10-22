import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { liveReviewRequest, reconcileAutoDispatch } from '../src/model/dispatch.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { bindReviewer, dismissalResolution, launchReview, readReviewLedger, reconcileReviews, reviewCommand, saveReviewerProfile } from '../src/reviewer.js';
import { sessionRetry, sessionRetryBaseMs, sessionRetryLimit } from '../src/producer.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2026-09-21 clock is the explicit now handed to reconcileReviews, runDispatchTick and sessionRetry; Date.now()-stamped ledger records are judged by attempt counts, not age.

// Each test is named for the proof it produces: integration:dismissed-review-relaunches and
// integration:master-review-forces-attempt.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), H2 = sha40('a2'), B = sha40('b1');
const clock = Date.parse('2026-09-21T01:22:07.000Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const reviewer = 'graphyard-reviewer[bot]';

function observation(candidate: { sha: string; baseSha: string }, at: string): Observation {
  return { candidate: { ...candidate, pr: 84, branch: 'graphyard/gy-84-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true };
}
/** One submitted, observed candidate whose only proof is manual: the review request stands alone. */
function work(overrides: Partial<Work> = {}, at = iso(0)): Work {
  const candidate = { sha: H, baseSha: B, pr: 84, branch: 'graphyard/gy-84-1', author: 'implementer' };
  return { id: 'work-84', key: 'GY-84', title: 'Dismissed approval', description: '', type: 'bug', priority: 0, dependencies: [], 
    criteria: [{ id: 'AC-1', text: 'Relaunch', proofs: ['manual:dismissed-review'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 3, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: '/w/gy-84', branch: 'graphyard/gy-84-1', epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: 84 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate, at), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}

/** A Herdr and `gh` stub: tab and agent calls for a launch, pane closes, and the PR's review list. */
function stubs(reviews: () => unknown[]) {
  const calls: string[][] = [];
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'api') return JSON.stringify(reviews());
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
  return { calls, run, mint: async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() }) };
}

async function reviewerRoot() {
  const root = await temporaryDirectory('dismissed'), credentialDirectory = await temporaryDirectory('dismissed-credentials');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, credentialDirectory, config: await loadMasterConfig(root), cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}

/** The dispatch loop with the real review ledger and a launcher that only records what it was asked for. */
function dispatchEffects(items: () => Work[], ledger: () => any[], log: string[], now: () => string): DispatchEffects {
  return {
    snapshot: async () => ({ work: items(), now: now() }),
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: ledger() as any }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: async (item, request, profile) => { log.push(`review:${item.key}:${request.sha.slice(0, 4)}:${profile.name}`); },
    launchProducer: async () => {},
    persist: async () => {},
  };
}

test('integration:dismissed-review-relaunches — a dismissed approval is recorded unanswered with its cause, and the next head is reviewed afresh without an operator', async () => {
  const { root, config, cleanup } = await reviewerRoot();
  try {
    const { run, mint } = stubs(() => []);
    // The candidate is observed, the control plane requests its review, and the reviewer session launches.
    const item = work({}, new Date().toISOString());
    reconcileAutoDispatch(item, [item], new Date());
    const first = item.autoDispatch!.review!;
    const launched = await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run, mint, requestId: first.id });
    assert.equal(launched.requestId, first.id);
    // The reviewer approves that head; the worker pushes a new one, and GitHub dismisses the approval with it.
    const moved = work({ candidate: { sha: H2, baseSha: B, pr: 84, branch: 'graphyard/gy-84-1', author: 'implementer' }, observation: observation({ sha: H2, baseSha: B }, new Date().toISOString()), autoDispatch: item.autoDispatch }, new Date().toISOString());
    const dismissal = { state: 'DISMISSED', reviewer, reviewId: 11, submittedAt: iso(0) };
    const settled = (await reconcileReviews(root, config, { run, observe: () => dismissal, work: [moved] })).reviews[0];
    // Unanswered, not completed: a dismissed approval is not an approval, so the session answered nothing.
    assert.equal(settled.state, 'failed');
    assert.equal(settled.verdict!.state, 'DISMISSED');
    assert.match(settled.resolution!, /the approval of a1ffffffffff was dismissed and head changed from a1ffffffffff to a2ffffffffff/);
    const unsettled = sessionRetry([settled], first.id, Date.parse(settled.closedAt!) + sessionRetryBaseMs);
    assert.deepEqual([unsettled.settled, unsettled.launch, unsettled.attempts], [false, true, 1], 'the request is unanswered, to be launched afresh as its next attempt');
    // The control plane cancels the request for the replaced head and requests the new one.
    reconcileAutoDispatch(moved, [moved], new Date());
    const second = moved.autoDispatch!.review!;
    assert.equal(second.sha, H2); assert.notEqual(second.id, first.id);
    assert.equal(moved.autoDispatch!.history.at(-1)!.state, 'cancelled');
    // One tick launches the further attempt for the new head; nobody asked it to.
    const log: string[] = [];
    const ledger = (await readReviewLedger(root)).reviews;
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), dispatchEffects(() => [moved], () => ledger, log, () => new Date().toISOString()), Date.now);
    assert.deepEqual(log, ['review:GY-84:a2ff:claude-reviewer']);
    assert.deepEqual(tick.launched.map(entry => [entry.kind, entry.sha, entry.requestId]), [['review', H2, second.id]]);
    assert.deepEqual(tick.waiting, []); assert.deepEqual(tick.refused, []);
  } finally { await cleanup(); }
});

test('integration:master-review-forces-attempt — master review launches the open request\'s next attempt for a session that settled unanswered, keeping the first in the ledger', async () => {
  const { root, config, cleanup } = await reviewerRoot();
  try {
    const { run, mint } = stubs(() => []);
    const at = new Date().toISOString();
    const item = work({}, at);
    reconcileAutoDispatch(item, [item], new Date());
    const request = item.autoDispatch!.review!;
    // Every automatic attempt is spent: the request stands, and nothing will launch for it again.
    for (let attempt = 1; attempt <= sessionRetryLimit; attempt++) {
      await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run, mint, requestId: request.id });
      await reconcileReviews(root, config, { run, observe: () => ({ state: 'DISMISSED', reviewer, reviewId: 10 + attempt, submittedAt: iso(attempt * 1000) }), work: [item], now: () => new Date(clock + attempt * 1000) });
    }
    const spent = (await readReviewLedger(root)).reviews;
    assert.equal(spent.length, sessionRetryLimit);
    assert.ok(spent.every(record => record.state === 'failed'));
    assert.ok(sessionRetry(spent, request.id, clock + 3_600_000).exhausted, 'no automatic attempt is left');
    const log: string[] = [];
    const held = await runDispatchTick(config, emptyDispatchCursor(config), dispatchEffects(() => [item], () => spent, log, () => new Date().toISOString()), () => clock + 3_600_000);
    assert.deepEqual(log, []); assert.match(held.waiting[0].reason, /no further automatic attempt|master review GY-84/);
    // `master review GY-84 claude-reviewer` answers that same request as its next attempt, rather
    // than recording a session the control plane's request knows nothing about.
    assert.equal(liveReviewRequest(item)!.id, request.id);
    const forced = await reviewCommand(root, ['GY-84', 'claude-reviewer'], { work: [item], now: new Date().toISOString() }, [], { run, mint });
    assert.equal(forced.requestId, request.id);
    const ledger = (await readReviewLedger(root)).reviews;
    assert.equal(ledger.length, sessionRetryLimit + 1, 'every earlier session is retained in the ledger');
    assert.deepEqual([ledger.at(-1)!.state, ledger.at(-1)!.attempt, ledger.at(-1)!.sha], ['pending', sessionRetryLimit + 1, H]);
    assert.ok(ledger.slice(0, sessionRetryLimit).every(record => record.state === 'failed' && /was dismissed/.test(record.resolution ?? '')));
    assert.equal(sessionRetry(ledger, request.id, clock + 3_600_000).settled, true, 'the forced attempt is the request\'s live session; the loop launches nothing beside it');
    // A head with no open request records none, which is the launch-refused recovery path unchanged.
    assert.equal(liveReviewRequest(work({ autoDispatch: { review: { ...request, sha: H2 }, producers: [], history: [] } })), null);
    assert.equal(liveReviewRequest(work({ autoDispatch: { review: { ...request, state: 'satisfied' }, producers: [], history: [] } })), null);
    assert.equal(liveReviewRequest(work()), null);
    // `master review` is exactly this command, on the snapshot it reads, and it refuses the same way it always did.
    const cli = await readFile(new URL('../src/cli/master/fleet.ts', import.meta.url), 'utf8');
    assert.match(cli, /if \(id === 'review'\) \{\n\s+const snapshot = await masterApi\('work-snapshot'\);\n\s+return print\(await reviewCommand\(root, args, snapshot, await listHerdrAgents\(\)\)\);/);
    await assert.rejects(reviewCommand(root, [], { work: [item], now: new Date().toISOString() }, []), /Use master review GY-N/);
    await assert.rejects(reviewCommand(root, ['GY-9999'], { work: [item], now: new Date().toISOString() }, []), /Unknown work item GY-9999/);
  } finally { await cleanup(); }
});
