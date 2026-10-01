import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { dismissedReviewIds } from '../src/github.js';
import { reconcileAutoDispatch, type SettledReviewSession } from '../src/model/dispatch.js';
import { openReviewConflict, reconcileReviewConflict } from '../src/model/review-conflict.js';
import { classifyAttention, trackFaults, type FaultRecord } from '../src/model/fault-classes.js';
import { mergeBaseDismissal, mergeBaseDismissalAttention } from '../src/merge-base-ancestry.js';
import { figureless, wording } from '../src/model/fault-wording.js';
import { buildMasterStatus, loadMasterConfig, setupMaster } from '../src/master.js';
import { bindReviewer, launchReview, reconcileReviews, saveReviewerProfile, summarizeReviews } from '../src/reviewer.js';
import { derivedAttention } from '../src/master-status.js';
import { unansweredRequestAttention, unobtainableReviewAttention } from '../src/cli/master-status.js';
import { sessionRetry } from '../src/producer.js';
import { expandTypedCommand, requestOf, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-486: three review-convergence faults in 24 hours, each counted where no second review event
// happened. The test is named for the proof it produces: manual:fault-class-review-convergence.
//
// - review-conflict on GY-100 (PR #116, head e9a5521c608c): the reviewer App's approval was
//   dismissed by GitHub and the merge broker re-posted it through the same App. GitHub reports one
//   review per identity, so the observation showed only the re-post; the dismissed original stayed
//   standing in the verdict record and the re-post was read as a second verdict for the request.
// - merge-base-dismissed on GY-288, twice: one dismissal (review #5324672415 of 1f1bc8b91d78)
//   stood while the base branch advanced from 0e2108cf789d to ab8fdf6cf47e. The attention line
//   names the base tip, and the fault record kept the letters of a commit hash as wording, so the
//   same standing fault was opened as a new instance.
//
// GY-956: three more faults of the same class in the next 24 hours, all one recorded mechanism:
// unobtainable-review on GY-936 (reviews #5347775213, #5347805316), GY-864 (#5348018094) and
// GY-888 (#5349465160). Each approval left listed review threads unaccounted, so the loop
// withdrew it and relaunched the request — and the loop's own fault read called the relaunch
// window "nothing is running" (an unobtainable review) because it built its rows without the
// retry schedule the ledger held, while the relaunched session got the same fixed prompt that
// had already failed its predecessor, so GY-936 lost two consecutive sessions to the identical
// omission. The last two tests reproduce those instances and show the candidate ends both halves:
// the owed relaunch is read as the schedule it is, and the relaunch names exactly the threads the
// withdrawn approval passed over.

const sha40 = (prefix: string) => prefix.padEnd(40, '0');
const reviewer = 'graphyard-reviewer[bot]';
const at = (minute: number) => new Date(Date.parse('2026-09-23T21:50:00.000Z') + minute * 60_000);

function gy100(): Work {
  const candidate = { sha: sha40('e9a5521c608c'), baseSha: sha40('b6a984ffc36a'), pr: 116, branch: 'graphyard/gy-100-1', author: 'implementer' };
  const observation: Observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], at: at(0).toISOString(),
    prState: 'open', draft: false, baseTip: candidate.baseSha, baseTipContained: true };
  return { id: 'work-100', key: 'GY-100', title: 'Queue carry', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Carry', proofs: ['unit:x'] }], policy: { checks: [], review: true, reviewProvider: 'github' }, stage: 'merge', revision: 9, policyRevision: 2,
    createdAt: at(0).toISOString(), updatedAt: at(0).toISOString(), stageEnteredAt: at(0).toISOString(), ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 116 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, gates: [], violations: [],
    autoDispatch: { review: { id: '4177d8bcaee33119be12a468eb5d813c', kind: 'review', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 2, requestedAt: at(0).toISOString() }, history: [], producers: [] } } as unknown as Work;
}
/** What github.ts observes from a pull request's full review list: each identity's latest review, and every dismissed one. */
function observe(work: Work, list: { id: number; state: string; submitted_at: string }[], minute: number, base = false) {
  const latest = new Map<string, (typeof list)[number]>();
  for (const review of list) latest.set(reviewer, review);
  work.observation = { ...work.observation!, at: at(minute).toISOString(),
    reviews: [...latest.values()].map(review => ({ id: review.id, reviewer, sha: work.candidate!.sha, state: review.state, submittedAt: review.submitted_at })),
    // The base read only each identity's latest review: it recorded no list of dismissed ones.
    ...(base ? {} : { dismissedReviewIds: dismissedReviewIds(list) }) };
  return reconcileReviewConflict(work, at(minute));
}

test('manual:fault-class-review-convergence — GY-100: an approval GitHub dismissed and the reviewer App re-posted is one verdict, not a conflict', () => {
  const original = { id: 5297208889, state: 'APPROVED', submitted_at: '2026-09-23T21:51:24Z' };
  const repost = { id: 5297255395, state: 'APPROVED', submitted_at: '2026-09-23T21:55:54Z' };
  // The reviewer session's approval is observed.
  for (const run of ['base', 'candidate'] as const) {
    const item = gy100();
    assert.deepEqual(observe(item, [original], 2), []);
    // GitHub dismisses it for a merge-base change and the merge broker re-posts it before the next
    // observation: the list now holds the dismissed original and the re-post, and each identity's
    // latest review is the re-post alone.
    const list = [{ ...original, state: 'DISMISSED' }, repost];
    if (run === 'base') {
      // The original's dismissal is never seen, and the re-post is taken for a second verdict.
      assert.deepEqual(observe(item, list, 6, true).map(entry => entry.event), ['review.conflicted'], 'the base raises the conflict');
      assert.deepEqual(openReviewConflict(item)!.verdicts.map(verdict => verdict.id), [original.id, repost.id]);
      continue;
    }
    assert.deepEqual(observe(item, list, 6), [], 'no conflict against the candidate');
    assert.equal(openReviewConflict(item), null);
    assert.deepEqual(item.reviewVerdicts!.verdicts.map(verdict => [verdict.id, !!verdict.dismissed]), [[original.id, true], [repost.id, false]]);
    // The re-posted approval reaches the gates as the one standing verdict.
    assert.deepEqual(item.observation!.reviews.map(review => [review.id, review.state]), [[repost.id, 'APPROVED']]);
  }
});

test('manual:fault-class-review-convergence — GY-100: a second verdict for the request that no dismissal withdrew still conflicts', () => {
  const item = gy100();
  observe(item, [{ id: 11, state: 'APPROVED', submitted_at: '2026-09-23T21:51:24Z' }], 2);
  const transitions = observe(item, [{ id: 11, state: 'APPROVED', submitted_at: '2026-09-23T21:51:24Z' }, { id: 12, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-23T21:52:00Z' }], 3);
  assert.deepEqual(transitions.map(entry => entry.event), ['review.conflicted']);
  assert.deepEqual(openReviewConflict(item)!.verdicts.map(verdict => verdict.id), [11, 12]);
  assert.deepEqual(item.observation!.reviews, [], 'neither verdict reaches the gates');
});

function gy288(baseTip: string): Work {
  const head = '1f1bc8b91d78'.padEnd(40, 'a'), boundBase = 'b6a984ffc36a'.padEnd(40, 'a');
  const candidate = { sha: head, baseSha: boundBase, pr: 288, branch: 'graphyard/gy-288-1', author: 'implementer' };
  return { key: 'GY-288', candidate, observation: { candidate, checks: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], at: '2026-09-26T05:05:00.000Z',
    baseTip, baseTipAncestor: false, baseTipContained: false,
    reviews: [{ id: 5324672415, reviewer, sha: head, state: 'DISMISSED', submittedAt: '2026-09-26T04:40:00Z', dismissal: { mergeBase: true, verdict: 'approved', at: '2026-09-26T05:03:19Z', commit: null } }] } } as unknown as Work;
}

test('manual:fault-class-review-convergence — GY-288: one standing merge-base dismissal is one fault while the base branch advances under it', () => {
  const line = (tip: string) => {
    const work = gy288(tip.padEnd(40, 'a'));
    return { kind: 'merge-base-dismissed' as const, faultClass: 'review-convergence' as const, subject: 'GY-288', text: mergeBaseDismissalAttention('GY-288', mergeBaseDismissal(work)!) };
  };
  const first = line('0e2108cf789d'), second = line('ab8fdf6cf47e');
  // The two lines the loop read differ only in the base branch tip they name.
  assert.match(first.text, /base branch tip 0e2108cf789d/);
  assert.match(second.text, /base branch tip ab8fdf6cf47e/);
  assert.notEqual(first.text, second.text);
  // trackFaults keys a standing fault by its kind, subject and normalised wording. The base
  // normaliser (figureless) kept a hash's letters, so the advance changed the key; the candidate's
  // drops the hash.
  for (const [run, normalise] of [['base', figureless], ['candidate', wording]] as const) {
    if (run === 'base') assert.notEqual(normalise(first.text), normalise(second.text), 'the base keys the advance as another fault');
    else assert.equal(normalise(first.text), normalise(second.text), 'the candidate keys it as the same fault');
  }
  // A lone standing line of its kind keeps its instance when reworded under either normaliser
  // (GY-368), so the key only decides the count once a second fault of the kind stands on the
  // subject — here a dismissal for a changed verdict beside the merge-base one.
  const beside = (entry: typeof first) => ({ ...entry, text: entry.text.replace('for a merge-base change', 'for a changed verdict') });
  const record: FaultRecord = { instances: [], open: {}, failing: {} };
  assert.equal(trackFaults(record, [first, beside(first)], '2026-09-26T05:05:55.157Z').length, 2);
  assert.equal(trackFaults(record, [second, beside(second)], '2026-09-26T05:11:49.761Z').length, 0, 'the advance opens no second instance');
  assert.equal(record.instances.length, 2);
  assert.deepEqual(record.instances.map(entry => entry.lastSeenAt), ['2026-09-26T05:11:49.761Z', '2026-09-26T05:11:49.761Z']);
  assert.match(record.instances[0].text, /ab8fdf6cf47e/, 'the standing instance carries the latest wording');
  // A dismissal that ended and happens again is a new instance, as before.
  trackFaults(record, [], '2026-09-26T05:20:00.000Z');
  assert.equal(trackFaults(record, [second], '2026-09-26T05:30:00.000Z').length, 1);
  // Only moving figures are dropped: a different fault on the subject is still its own instance.
  assert.equal(trackFaults(record, [second, beside(second)], '2026-09-26T05:31:00.000Z').length, 1);
});

test('fault wording drops hex-shaped tokens with a digit, commit hashes or not, and keeps words', () => {
  assert.equal(wording('base branch tip 0e2108cf789d advanced'), wording('base branch tip ab8fdf6cf47e advanced'));
  assert.equal(wording(`head ${sha40('1f1bc8b91d78')} dismissed`), 'head # dismissed');
  // Any 7–40-character hex-shaped token with a digit is dropped, as documented — not only a hash.
  assert.equal(wording('lease beef1234 lapsed'), 'lease # lapsed');
  // A word with no digit, or one too short to be a hash, keeps its letters.
  assert.equal(wording('facade deadbeef stood'), 'facade deadbeef stood');
  assert.equal(wording('run abc123 failed'), 'run abc # failed');
});

// The GY-956 harness: a master with a bound reviewer App, a submitted candidate whose review
// request stands, and the real launcher and reconciler over stubbed Herdr and gh.
const launcherPath = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const HEAD = sha('a1'), BASE = sha('b1');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
const approval = (reviewId: number) => ({ state: 'APPROVED', reviewer, reviewId, submittedAt: '2026-09-29T12:00:00.000Z' });

async function reviewerRoot() {
  const root = await temporaryDirectory('convergence'), credentials = await temporaryDirectory('convergence-cred');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcherPath, credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentials, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, config: await loadMasterConfig(root) };
}

/** One submitted candidate whose only proof is manual, so the review request stands alone. */
function candidate(autoDispatch?: Work['autoDispatch']): Work {
  const head = { sha: HEAD, baseSha: BASE, pr: 936, branch: 'graphyard/gy-936-1', author: 'implementer' };
  const now = new Date().toISOString();
  return { id: 'work-936', key: 'GY-936', title: 'Review convergence', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Converge', proofs: ['manual:fault-class-review-convergence'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 9, policyRevision: 1, createdAt: now, updatedAt: now, stageEnteredAt: now, ready: true, epoch: 1,
    lease: null, workspaces: [], candidate: head, submission: { epoch: 1, pr: 936 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { candidate: head, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: now, prState: 'open', draft: false, baseTip: BASE, baseTipContained: true },
    blocker: null, gates: [], violations: [], ...(autoDispatch ? { autoDispatch } : {}) } as unknown as Work;
}
const listedThread = (id: string) => ({ id, author: 'lead', path: 'src/a.ts', line: 3, outdated: false, excerpt: 'finding', createdAt: '2026-09-29T11:00:00Z' });
/** Herdr as the launch tests stub it, keeping every typed line so the prompt a session was started on can be read back. */
function herdr() {
  const typed: string[] = [];
  let panes = 0;
  const run = (_command: string, args: string[]) => {
    if (args[0] === 'pane' && args[1] === 'run') { typed.push(args[3]); return ''; }
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: `pane-${++panes}`, tab_id: `tab-${panes}` } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
  return { run, typed, promptOf: (line: string) => { const launch = expandTypedCommand(line); return requestOf(launch.kind, launch.args) ?? ''; } };
}

test('manual:fault-class-review-convergence — GY-936, GY-864 and GY-888: a withdrawn approval\'s relaunch is scheduled and the loop reads it, so the window is a wait, not an unobtainable review', async () => {
  const { root, config } = await reviewerRoot();
  const item = candidate();
  reconcileAutoDispatch(item, [item], new Date());
  const request = item.autoDispatch!.review!;
  const threads = async () => [listedThread('PRRT_person01'), listedThread('PRRT_bot0001')];
  // Two approvals, each leaving one listed thread off its three lines: the first misses the
  // bot's thread, as GY-864 and GY-888's single sessions and GY-936's first session did; the
  // second misses the person's, as GY-936's second session did.
  const bodies: Record<number, string> = {
    5348018094: 'AC-1 met.\nResolved threads: PRRT_person01\nFollow-up threads: none\nOverridden threads: none',
    5349465160: 'AC-1 met.\nResolved threads: none\nFollow-up threads: none\nOverridden threads: PRRT_bot0001',
  };
  const run = (_command: string, args: string[]) => {
    const review = /pulls\/936\/reviews\/(\d+)$/.exec(args[1] ?? '');
    if (review) return JSON.stringify({ id: Number(review[1]), state: 'APPROVED', commit_id: HEAD, user: { login: reviewer }, submitted_at: '2026-09-29T12:00:00Z', body: bodies[Number(review[1])] });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const dismissed: { reviewId: number; message: string }[] = [];
  const dismiss = async (_record: unknown, reviewId: number, message: string) => { dismissed.push({ reviewId, message }); };
  const launch = { run: herdr().run, mint, threads };

  // The instance's mechanism, exactly as GY-864 and GY-888 recorded it: one approval withdrawn
  // for the thread it left unaccounted, the session failed unanswered, the request standing.
  await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { ...launch, requestId: request.id });
  let records = (await reconcileReviews(root, config, { run, observe: (record: any) => record.attempt === 1 ? approval(5348018094) : null, work: [item], threadsRun: run, dismiss })).reviews;
  const first = records[0];
  assert.equal(first.state, 'failed', 'recorded unanswered, so the request is relaunched');
  assert.equal(first.verdict?.state, 'DISMISSED');
  assert.match(first.resolution!, /left listed threads unaccounted \(PRRT_bot0001\), so it was withdrawn and the request is relaunched/);
  assert.deepEqual(first.unaccountedThreads, ['PRRT_bot0001'], 'the omission is on the record for the relaunch to name');
  assert.deepEqual(dismissed.map(entry => entry.reviewId), [5348018094]);
  // The relaunch is owed and the ledger schedules it.
  const retry = sessionRetry(records, request.id, Date.now());
  assert.ok(retry.nextAt && !retry.exhausted, `the relaunch is scheduled at ${retry.nextAt}`);
  const settled = () => summarizeReviews(records).completed as SettledReviewSession[];
  const rows = () => buildMasterStatus({ work: [item], now: new Date().toISOString() }, [], [], {}, {}, summarizeReviews(records), 'main', undefined,
    { producers: { pending: [], completed: [] }, failures: [], retries: [] }).work;
  // Reproduced against the base: rows built as the loop built them — without the schedule —
  // read the window as the fault all three instances recorded.
  const alone = unobtainableReviewAttention(rows(), settled());
  assert.equal(alone.length, 1, 'the base reads the withdrawal window as an unobtainable review');
  assert.match(alone[0]!.text, /1 reviewer session settled on review #5348018094, which GitHub dismissed, so no verdict has ever been obtained on that commit .* over 1 attempt/);
  assert.match(alone[0]!.text, /left listed threads unaccounted \(PRRT_bot0001\), so it was withdrawn and the request is relaunched\. This is not a review in progress: nothing is running for the request$/);
  assert.deepEqual(classifyAttention([alone[0]!] as any).map(entry => [entry.kind, entry.faultClass]), [['unobtainable-review', 'review-convergence']]);

  // The relaunch loses its session the same way, as GY-936's did: two settled dismissals now.
  await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { ...launch, requestId: request.id });
  records = (await reconcileReviews(root, config, { run, observe: (record: any) => record.attempt === 1 ? approval(5348018094) : approval(5349465160), work: [item], threadsRun: run, dismiss })).reviews;
  assert.deepEqual(dismissed.map(entry => entry.reviewId), [5348018094, 5349465160]);
  assert.deepEqual(records.filter(record => record.state === 'failed' && record.verdict?.state === 'DISMISSED').length, 2);
  const retryAgain = sessionRetry(records, request.id, Date.now());
  assert.ok(retryAgain.nextAt && !retryAgain.exhausted, `the third attempt is still scheduled, at ${retryAgain.nextAt}`);
  const both = unobtainableReviewAttention(rows(), settled());
  assert.equal(both.length, 1);
  // GY-936's instance, verbatim in shape: two sessions, two dismissed reviews, nothing running.
  assert.match(both[0]!.text, /2 reviewer sessions settled on review #5348018094, #5349465160, which GitHub dismissed, so no verdict has ever been obtained on that commit .* over 2 attempts/);
  assert.match(both[0]!.text, /This is not a review in progress: nothing is running for the request$/);

  // Not recurring against the candidate: the loop's own read — the same builder, with the retry
  // schedule the ledger holds — names the owed attempt instead, and no fault of the class stands.
  const derived = await derivedAttention(root, config, async () => ({}), { github: true }, { work: [item], now: new Date().toISOString() },
    { reviews: records, producers: [], runtime: { available: true, agents: [] }, trees: [] });
  assert.deepEqual(derived.unobtainable, [], 'the candidate reads the scheduled relaunch, not an unobtainable review');
  assert.deepEqual(derived.unanswered, [], 'a scheduled relaunch is an answer in progress, not an unanswered request');
  assert.ok(!classifyAttention(derived.items as any).some(entry => entry.kind === 'unobtainable-review'),
    `no unobtainable-review fault stands: ${derived.items.filter((entry: any) => entry.kind === 'unobtainable-review').map((entry: any) => entry.text).join('\n')}`);
});

test('manual:fault-class-review-convergence — GY-936: the relaunch of a withdrawn approval names exactly the threads its predecessor left unaccounted, so the next approval accounts for them and the request settles', async () => {
  const { root, config } = await reviewerRoot();
  const item = candidate();
  reconcileAutoDispatch(item, [item], new Date());
  const request = item.autoDispatch!.review!;
  const threads = async () => [listedThread('PRRT_person01'), listedThread('PRRT_bot0001')];
  const bodies: Record<number, string> = {
    5347775213: 'AC-1 met.\nResolved threads: PRRT_person01\nFollow-up threads: none\nOverridden threads: none',
    5347805316: 'AC-1 met.\nResolved threads: PRRT_person01\nOverridden threads: PRRT_bot0001',
  };
  const resolved: string[] = [];
  const run = (_command: string, args: string[]) => {
    const review = /pulls\/936\/reviews\/(\d+)$/.exec(args[1] ?? '');
    if (review) return JSON.stringify({ id: Number(review[1]), state: 'APPROVED', commit_id: HEAD, user: { login: reviewer }, submitted_at: '2026-09-29T12:10:00Z', body: bodies[Number(review[1])] });
    const query = args.find(arg => arg.startsWith('query=')) ?? '';
    if (query.includes('resolveReviewThread')) { const id = args.find(arg => arg.startsWith('thread='))!.slice('thread='.length); resolved.push(id); return JSON.stringify({ data: { resolveReviewThread: { thread: { id, isResolved: true } } } }); }
    if (query.includes('reviewThreads')) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [listedThread('PRRT_person01'), listedThread('PRRT_bot0001')].map(thread => ({ id: thread.id, isResolved: resolved.includes(thread.id), isOutdated: false, path: thread.path, line: thread.line,
        comments: { nodes: [{ author: { login: thread.author }, body: thread.excerpt, createdAt: thread.createdAt }] } })) } } } } });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const dismissed: { reviewId: number; message: string }[] = [];
  const dismiss = async (_record: unknown, reviewId: number, message: string) => { dismissed.push({ reviewId, message }); };
  const herdrStub = herdr();
  const launch = { run: herdrStub.run, mint, threads };

  // The first launch is told only the fixed rule; its prompt names no withdrawal.
  await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { ...launch, requestId: request.id });
  assert.equal(herdrStub.typed.length, 1);
  const firstPrompt = herdrStub.promptOf(herdrStub.typed[0]);
  assert.match(firstPrompt, /An approval that leaves a listed thread off all three lines, a bot's included, is withdrawn and the review asked again/);
  assert.ok(!firstPrompt.includes('was withdrawn because it left'), 'the first launch names no withdrawal');

  // Its approval leaves the bot's thread off every line: withdrawn, as GY-936's first session was.
  let records = (await reconcileReviews(root, config, { run, observe: record => record.attempt === 1 ? approval(5347775213) : null, work: [item], threadsRun: run, dismiss })).reviews;
  assert.deepEqual(dismissed.map(entry => entry.reviewId), [5347775213]);
  assert.match(dismissed[0].message, /does not account for listed review thread\(s\) PRRT_bot0001/);
  assert.deepEqual(records[0].unaccountedThreads, ['PRRT_bot0001']);

  // The relaunch's prompt names exactly the passed-over thread — the fixed prompt demonstrably
  // did not converge, so the relaunch says which omissions to answer instead of repeating the
  // rule they broke.
  await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { ...launch, requestId: request.id });
  assert.equal(herdrStub.typed.length, 2);
  const relaunchPrompt = herdrStub.promptOf(herdrStub.typed[1]);
  assert.match(relaunchPrompt, /The previous approval of this head was withdrawn because it left these listed review threads unaccounted: PRRT_bot0001\./);
  assert.match(relaunchPrompt, /Name every one of them that is still an unresolved thread of this pull request on your Resolved threads, Follow-up threads or Overridden threads lines/);

  // Told so, its approval accounts for the thread: a complete verdict, never withdrawn, and the
  // threads it named are resolved — the request settles instead of burning another session.
  records = (await reconcileReviews(root, config, { run, observe: record => record.attempt === 1 ? approval(5347775213) : approval(5347805316), work: [item], threadsRun: run, dismiss })).reviews;
  assert.deepEqual(dismissed.map(entry => entry.reviewId), [5347775213], 'the told approval is complete and is not withdrawn');
  const second = records.find(record => record.attempt === 2)!;
  assert.deepEqual([second.state, second.verdict?.state, second.verdict?.reviewId], ['completed', 'APPROVED', 5347805316]);
  assert.ok(resolved.includes('PRRT_person01'), 'the threads the complete verdict named are resolved');
  // And the same state the first test read as an unobtainable review now reads as its verdict:
  // the request settles instead of counting another fault of the class.
  const settled = summarizeReviews(records).completed as SettledReviewSession[];
  const rows = buildMasterStatus({ work: [item], now: new Date().toISOString() }, [], [], {}, {}, summarizeReviews(records), 'main', undefined,
    { producers: { pending: [], completed: [] }, failures: [], retries: [] }).work;
  assert.equal(unobtainableReviewAttention(rows, settled).length, 0, 'a complete verdict is obtained; nothing is unobtainable');
});
