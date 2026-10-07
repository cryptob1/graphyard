import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { trackFaults, type FaultRecord } from '../src/model/fault-classes.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { bindReviewer, launchReview, readReviewLedger, saveReviewerProfile, updateReviewLedger, type ReviewRecord } from '../src/reviewer.js';
import { dispatchEffects, emptyDispatchCursor, launchWaitAttention, launchWaits, observationWakeIntervalMs, reviewLaunchWaitAttentionMs, runDispatchTick, verdictIngestGraceMs, type DispatchCursor, type DispatchEffects } from '../src/auto-dispatch.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1429 names this file for its proof: manual:fault-class-review-convergence. The master loop filed
// three review-convergence faults in 24 hours on 7 October 2026, every one a `review-settlement` wait
// on GY-1394: the reviewer session had already posted APPROVED, so each tick's launch was refused as
// answered (GY-1083) and the request was left for the control plane to settle "once it reads that
// verdict". The shared cause had two halves:
//   - nothing read the verdict promptly. The request settles only when the item's observation lists
//     the verdict, and that reading rode the observation scheduler's thirty-minute review band: the
//     third instance's verdict was posted at 06:42:01Z, 38 s after its request, and stood unread until
//     after 07:04. The dispatcher, the one party that knew the verdict was there, never woke it.
//   - the wait was aged from the request, not the verdict, and reported as "without a reviewer
//     launch" though the reviewer had launched and answered: a reviewer's own working time counted
//     toward the fifteen-minute attention bound.
// Now the tick that finds a request answered wakes the item's observation at once (a prioritized
// resync), and the settlement wait is aged from the verdict. Each instance is replayed below: against
// the base (no wake, aged from the request) it raises the exact attention line the loop recorded and
// one review-convergence fault; against the candidate the woken observation reads the verdict, the
// request settles, and nothing is raised. Only the third instance's verdict time is on record (its
// observation lists it); the first two are replayed with their verdicts posted a minute after their
// requests, and the candidate's outcome does not depend on that time. Each is read when its line was
// written: the second instance's line, first recorded at 06:09, carries the 32 minutes it had reached
// when the loop last wrote it, past the review band's thirty.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const reviewer = 'graphyard-reviewer[bot]';
const base = '2cca02cd24'.padEnd(40, '0');
const minute = 60_000;

const instances = [
  { at: '2026-10-07T05:21:15.452Z', requestId: 'ce6b918a096295d26328fac33eb07a9f', sha: 'afd64fc103eb6ff4b0f2d63182c9424408d727be', requestedAt: '2026-10-07T05:05:49.336Z', reviewId: 5437864281, verdictAt: '2026-10-07T05:06:49Z', readAt: '2026-10-07T05:21:15.452Z',
    text: "GY-1394's review request ce6b918a096295d26328fac33eb07a9f on afd64fc103eb has waited 15 min (since 2026-10-07T05:05:49.336Z) without a reviewer launch: reviewer session review-claude-1-ce6b918a already answered with APPROVED (review 5437864281); the control plane settles the request once it reads that verdict" },
  { at: '2026-10-07T06:09:20.878Z', requestId: '2a214be7a90495923a7790ecd7b68849', sha: '34cad10e04abcf49c0ff43f27335130fd3df001d', requestedAt: '2026-10-07T05:50:18.123Z', reviewId: 5438197463, verdictAt: '2026-10-07T05:51:18Z', readAt: '2026-10-07T06:22:30.000Z',
    text: "GY-1394's review request 2a214be7a90495923a7790ecd7b68849 on 34cad10e04ab has waited 32 min (since 2026-10-07T05:50:18.123Z) without a reviewer launch: reviewer session review-claude-1-2a214be7 already answered with APPROVED (review 5438197463); the control plane settles the request once it reads that verdict" },
  { at: '2026-10-07T06:57:24.139Z', requestId: '4cfe56ccc4967bf04cdf26c0c784d9ef', sha: 'a31d98d137df5eb02d33cdb53487652428bc0c67', requestedAt: '2026-10-07T06:41:23.655Z', reviewId: 5438582927, verdictAt: '2026-10-07T06:42:01Z', readAt: '2026-10-07T06:57:24.139Z',
    text: "GY-1394's review request 4cfe56ccc4967bf04cdf26c0c784d9ef on a31d98d137df has waited 16 min (since 2026-10-07T06:41:23.655Z) without a reviewer launch: reviewer session review-claude-1-4cfe56cc already answered with APPROVED (review 5438582927); the control plane settles the request once it reads that verdict" },
] as const;
type Instance = typeof instances[number];

/** GY-1394 as the launchers read it: submitted, its review request open, last observed before the verdict. */
function item(instance: Instance): Work {
  const candidate = { sha: instance.sha, baseSha: base, pr: 887, branch: 'graphyard/gy-1394-15', author: 'implementer' };
  const observation: Observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [],
    at: new Date(Date.parse(instance.requestedAt) - 30_000).toISOString(), prState: 'open', draft: false, baseTip: base, baseTree: '7b'.padEnd(40, '0'), baseTipContained: true };
  const work = { id: 'work-GY-1394', key: 'GY-1394', title: 'Instance', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Review', proofs: ['unit:x'] }], policy: { checks: [], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1,
    createdAt: instance.requestedAt, updatedAt: instance.requestedAt, stageEnteredAt: instance.requestedAt, ready: true, epoch: 15, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 15, owner: 'implementer' }], candidate, submission: { epoch: 15, pr: 887 }, reworkRequested: false,
    scenarioRequirements: [], observation, blocker: null, violations: [],
    evidence: [{ id: 'evidence-1', proof: 'unit:x', sha: instance.sha, baseSha: base, policyRevision: 1, producer: 'ci-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at: instance.requestedAt }],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }] } as unknown as Work;
  reconcileAutoDispatch(work, [work], new Date(instance.requestedAt));
  work.autoDispatch!.review = { ...work.autoDispatch!.review!, id: instance.requestId, requestedAt: instance.requestedAt };
  return work;
}

/** The reviewer session that answered the request, settled by the loop when GitHub listed its verdict. */
function answered(instance: Instance): ReviewRecord {
  const closedAt = new Date(Date.parse(instance.verdictAt) + 20_000).toISOString();
  return { id: randomUUID(), key: 'GY-1394', pr: 887, sha: instance.sha, baseSha: base, policyRevision: 1, profile: 'claude-reviewer',
    agentName: `review-claude-1-${instance.requestId.slice(0, 8)}`, pane: null, sessionDirectory: '/nonexistent/session', requestedAt: instance.requestedAt,
    tokenExpiresAt: new Date(Date.now() + 3_000_000).toISOString(), requestId: instance.requestId, attempt: 1, state: 'completed', acknowledgedAt: closedAt, closedAt,
    verdict: { state: 'APPROVED', reviewer, reviewId: instance.reviewId, submittedAt: instance.verdictAt } };
}

async function reviewerMaster() {
  const root = await temporaryDirectory('gy1429'), credentials = await temporaryDirectory('gy1429-cred');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinator = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinator as typeof fetch);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentials, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude', concurrency: 2 });
  const tabs: string[] = [];
  const run = (_command: string, args: string[]) => {
    if (args[0] === 'tab' && args[1] === 'create') { const pane = `pane-${tabs.length + 1}`; tabs.push(pane); return JSON.stringify({ result: { root_pane: { pane_id: pane, tab_id: `tab-${tabs.length}` } } }); }
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
  const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
  return { root, run, mint, tabs, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

function effects(master: Awaited<ReturnType<typeof reviewerMaster>>, work: Work, wakeObservation?: DispatchEffects['wakeObservation']): DispatchEffects {
  return {
    snapshot: async () => ({ work: [work], now: new Date().toISOString() }), agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: (await readReviewLedger(master.root)).reviews }), reconcileProducers: async () => ({ producers: [] }),
    launchReview: (target, dispatch, profile, herdr, observedAt) => launchReview(master.root, target, profile.name, herdr, observedAt, { run: master.run, mint: master.mint, requestId: dispatch.id }),
    launchProducer: async () => { throw new Error('no producer is under test'); }, persist: async () => {},
    ...(wakeObservation ? { wakeObservation } : {}),
  };
}

const faultsOf = (attention: ReturnType<typeof launchWaitAttention>, at: string) => trackFaults({ instances: [], open: {}, failing: {} } as FaultRecord, attention.map(entry => ({ ...entry, kind: entry.kind!, faultClass: entry.faultClass! })), at);

for (const [index, instance] of instances.entries()) {
  test(`manual:fault-class-review-convergence — GY-1429 instance ${index + 1}, GY-1394 request ${instance.requestId.slice(0, 8)}: an answered request wakes its observation and settles, and raises no review-settlement fault`, async () => {
    const master = await reviewerMaster();
    try {
      const config = await loadMasterConfig(master.root);
      await updateReviewLedger(master.root, ledger => { ledger.reviews = [answered(instance)]; });
      // A tick past the verdict's ingest grace, when the launch is refused as answered (GY-1083).
      const tickAt = Date.parse(answered(instance).closedAt!) + verdictIngestGraceMs + minute, faultAt = Date.parse(instance.readAt);

      // Base: the tick waits on the answered request and nothing wakes the reading that would settle
      // it. Aged from its request, as the base aged it, it is the line the loop recorded, and a fault.
      const baseWork = item(instance), baseCursor = emptyDispatchCursor(config);
      const baseTick = await runDispatchTick(config, baseCursor, effects(master, baseWork), () => tickAt);
      assert.deepEqual(baseTick.launched, [], 'no second reviewer is launched');
      assert.equal(baseTick.woken, undefined, 'nothing woke the observation');
      assert.equal(baseWork.autoDispatch!.review!.state, 'requested', 'the request still stands');
      const baseView: Pick<DispatchCursor, 'lastTick' | 'failures'> = { failures: {}, lastTick: { ...baseCursor.lastTick!, waits: baseCursor.lastTick!.waits.map(({ answeredAt: _answeredAt, ...wait }) => wait) } };
      const baseAttention = launchWaitAttention(launchWaits([baseWork], baseView, faultAt));
      assert.deepEqual(baseAttention.map(entry => [entry.subject, entry.text, entry.kind, entry.faultClass]), [['GY-1394', instance.text, 'review-settlement', 'review-convergence']]);
      assert.deepEqual(faultsOf(baseAttention, instance.at).map(fault => [fault.faultClass, fault.kind, fault.subject]), [['review-convergence', 'review-settlement', 'GY-1394']]);

      // Candidate: the same tick wakes the item's observation, which reads the verdict and settles the request.
      const work = item(instance), cursor = emptyDispatchCursor(config), woken: string[] = [];
      const tick = await runDispatchTick(config, cursor, effects(master, work, async target => {
        woken.push(target.key);
        const landed = new Date(tickAt + 30_000);
        target.observation = { ...target.observation!, at: landed.toISOString(), reviews: [{ id: instance.reviewId, reviewer, sha: instance.sha, state: 'APPROVED', submittedAt: instance.verdictAt }] };
        reconcileAutoDispatch(target, [target], landed);
      }), () => tickAt);
      assert.deepEqual(tick.launched, [], 'still no second reviewer');
      assert.deepEqual(woken, ['GY-1394'], 'the answered request woke its observation once');
      assert.deepEqual(tick.woken, ['GY-1394']);
      assert.equal(cursor.lastTick!.waits[0].answeredAt, answered(instance).closedAt, 'the wait carries when the verdict settled');
      assert.notEqual(work.autoDispatch!.review?.state, 'requested', 'the woken reading settled the request');
      const attention = launchWaitAttention(launchWaits([work], cursor, faultAt));
      assert.deepEqual(attention, [], 'no wait is left to raise at the instance\'s time');
      assert.deepEqual(faultsOf(attention, instance.at), []);
      assert.deepEqual(master.tabs, [], 'no reviewer session was started');
    } finally { await master.cleanup(); }
  });
}

test('manual:fault-class-review-convergence — GY-1429: a settlement wait is aged from the verdict, so a reviewer\'s working time raises nothing, while a verdict unread past the bound still does', async () => {
  const master = await reviewerMaster();
  try {
    const config = await loadMasterConfig(master.root);
    const instance = instances[0];
    // A reviewer that worked 14 minutes before answering; the reading it would wake never lands.
    const verdictAt = new Date(Date.parse(instance.requestedAt) + 14 * minute).toISOString();
    const record = { ...answered(instance), closedAt: verdictAt, acknowledgedAt: verdictAt, verdict: { ...answered(instance).verdict!, submittedAt: verdictAt } };
    await updateReviewLedger(master.root, ledger => { ledger.reviews = [record]; });
    const work = item(instance), cursor = emptyDispatchCursor(config);
    await runDispatchTick(config, cursor, effects(master, work, async () => {}), () => Date.parse(verdictAt) + verdictIngestGraceMs + minute);
    assert.equal(work.autoDispatch!.review!.state, 'requested');
    const soon = launchWaits([work], cursor, Date.parse(verdictAt) + 2 * minute);
    assert.equal(soon[0].answeredAt, verdictAt);
    assert.equal(soon[0].waitedMs, 2 * minute, 'aged from the verdict, not the request sixteen minutes earlier');
    assert.deepEqual(launchWaitAttention(soon), []);
    const late = launchWaits([work], cursor, Date.parse(verdictAt) + reviewLaunchWaitAttentionMs + minute);
    const attention = launchWaitAttention(late);
    assert.equal(attention.length, 1, 'a verdict still unread past the bound is a fault');
    assert.equal(attention[0].kind, 'review-settlement');
    assert.match(attention[0].text, new RegExp(`has waited 16 min \\(since its verdict at ${verdictAt}, requested ${instance.requestedAt}\\) without a reviewer launch: `));
  } finally { await master.cleanup(); }
});

test('manual:fault-class-review-convergence — GY-1429: a wake that fails is named on the wait', async () => {
  const master = await reviewerMaster();
  try {
    const config = await loadMasterConfig(master.root);
    const instance = instances[2];
    await updateReviewLedger(master.root, ledger => { ledger.reviews = [answered(instance)]; });
    const work = item(instance), cursor = emptyDispatchCursor(config);
    const tick = await runDispatchTick(config, cursor, effects(master, work, async () => { throw new Error('control plane answered 503'); }), () => Date.parse(answered(instance).closedAt!) + verdictIngestGraceMs + minute);
    assert.equal(tick.woken, undefined);
    assert.match(cursor.lastTick!.waits[0].reason, /the control plane settles the request once it reads that verdict; waking its observation failed: control plane answered 503$/);
  } finally { await master.cleanup(); }
});

test('manual:fault-class-review-convergence — GY-1429: the shipped dispatcher wakes an item\'s observation with a prioritized resync, at most once a minute', async () => {
  const root = await temporaryDirectory('gy1429-effects');
  try {
    let clock = Date.parse('2026-10-07T07:00:00Z');
    const posts: [string, unknown][] = [];
    const shipped = dispatchEffects(root, { url: 'https://graphyard.example', credentialFile: '/nonexistent' } as never, {
      snapshot: async () => ({ work: [], now: new Date(clock).toISOString() }), mutate: async (path, body) => { posts.push([path, body]); return {}; }, now: () => clock });
    const work = { id: 'work-GY-1394', key: 'GY-1394' } as Work;
    await shipped.wakeObservation!(work);
    await shipped.wakeObservation!(work);
    clock += observationWakeIntervalMs;
    await shipped.wakeObservation!(work);
    assert.deepEqual(posts, [['work/work-GY-1394/resync', { prioritized: true, wait: false }], ['work/work-GY-1394/resync', { prioritized: true, wait: false }]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
