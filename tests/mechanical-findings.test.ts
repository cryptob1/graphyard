import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appliedMechanicalRework, classifyFinding, judgeBotCommit, mechanicalFixPlan, mechanicalMergeHold, mechanicalRoundStartMs, parseClassifiedFindings, planMechanicalFix, readMechanicalFixRequests, readMechanicalFixState, verifyBotCommit, type BotCommitObservation, type MechanicalFixPlan } from '../src/mechanical-findings.js';
import { loadMasterConfig, saveWorkerProfile, setupMaster } from '../src/master.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, reviewPrompt, reviewRetryPrompt, saveReviewerProfile, type ReviewRecord } from '../src/reviewer.js';
import { neededDecision } from '../src/daemon/decisions.js';
import { workerPrompt } from '../src/master/dispatch.js';
import { computeInterventionReport, foldInterventions } from '../src/interventions.js';
import { interventionKinds, interventionPolicyDefaults, interventionRecordSchema, type InterventionRecordInput } from '../src/model/interventions.js';
import type { Observation, Work } from '../src/model.js';
import { expandTypedCommand, requestOf, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-971. A review finding is mechanical (typo, docs placement, formatting, naming) or substantive
// (behaviour, criteria, scope). An approved head's mechanical findings become one worker-class bot
// commit before the independent reviewer's fresh read, which judges only substance; a reviewer who
// finds the bot commit changed substance rejects it, and the loop records the misclassification.
// Both tests drive the production path: the loop's reconciliation of reviews, its routine rework
// decision, the worker launcher's prompt, the reviewer launch, and the reconciliation of its verdict.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const H = 'a'.repeat(40), B = 'b'.repeat(40), BOT = 'c'.repeat(40);
const reviewer = 'graphyard-reviewer[bot]';
const botWorker = 'graphyard-bot-worker';
const criteria = [{ id: 'AC-1', text: 'The widget counts every frob.', proofs: ['unit:frob-count'] }];
const verdict = [
  'AC-1 met.',
  'Nit: docs/widget.md:12 — "recieve" is a typo (mechanical: typo)',
  'Nit: src/widget.ts:40 — the counter variable name frobCnt does not match the frobCount convention used elsewhere (mechanical: naming)',
  'Nit: docs/operations.md:3 — this paragraph belongs in docs/widget.md (mechanical: docs-placement)',
  'Nit: src/widget.ts:9 — trailing whitespace and a blank line (mechanical: formatting)',
  'Nit: src/widget.ts:55 — the retry loop is unbounded when the source keeps failing (substantive: behavior)',
  'Nit: src/other.ts:2 — rename this, and it also returns null for an empty list (mechanical: naming)',
  'Nit: consider a cache someday',
  'Resolved threads: none', 'Follow-up threads: none', 'Overridden threads: none',
].join('\n');
const approval = { key: 'GY-7', pr: 7, sha: H, reviewId: 901, state: 'APPROVED', body: verdict };
const observed = (plan: MechanicalFixPlan, overrides: Partial<BotCommitObservation> = {}): BotCommitObservation =>
  ({ sha: BOT, parents: [plan.head], author: { principal: botWorker, role: 'worker' }, files: plan.paths, at: '2026-09-30T12:00:00.000Z', ...overrides });

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });

async function boundMaster() {
  const root = await temporaryDirectory('mechanical'), credentialDirectory = await temporaryDirectory('mechanical-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wM' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude', concurrency: 4 });
  // The bot round's identity is a registered worker profile, as every worker-class session's is.
  await saveWorkerProfile(root, { name: 'bot-worker', principal: botWorker, agentName: 'bot-worker-1', mode: 'existing' }, async () => ({}));
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}

/** The item as the control plane reports it: `head` submitted by attempt `epoch`'s owner, and GitHub's reviews of it. */
function item(head: string, epoch: number, reviews: Observation['reviews'] = [], extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: B, pr: 7, branch: 'graphyard/gy-7-1', author: 'implementer' };
  const observation = { candidate, checks: [], reviews, merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/widget.ts'], scopeFiles: [], at: new Date().toISOString(),
    prState: 'open', draft: false, baseTip: B, baseTree: B, baseTipContained: true } as unknown as Observation;
  const owner = epoch === 1 ? 'graphyard-worker-1' : botWorker;
  return { id: 'work-7', key: 'GY-7', title: 'Widget', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/', 'docs/'], criteria,
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    stageEnteredAt: new Date().toISOString(), ready: true, epoch, lease: null, lastAssignment: { owner, epoch }, workspaces: [], candidate, submission: { epoch, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation, blocker: null, gates: [], violations: [], ...extra } as unknown as Work;
}

/** Herdr as the launch sees it, keeping the request each session was started on. */
function herdr() {
  const requests: string[] = [];
  const run = (_command: string, args: string[]) => {
    if (args[0] === 'pane' && args[1] === 'run') { const typed = expandTypedCommand(args[3]); requests.push(requestOf(typed.kind, typed.args) ?? ''); }
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: `pane-${requests.length}`, tab_id: `tab-${requests.length}` } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
  return { run, requests };
}
/** GitHub as the loop's gh sees it: each review's body, and no review threads. */
function github(bodies: Record<number, { body: string; sha: string; state: string }>) {
  return (command: string, args: string[]) => {
    if (command !== 'gh') throw new Error(`unexpected ${command}`);
    const review = /^repos\/owner\/project\/pulls\/7\/reviews\/(\d+)$/.exec(args[1] ?? '');
    if (review && bodies[Number(review[1])]) { const entry = bodies[Number(review[1])]!; return JSON.stringify({ id: Number(review[1]), state: entry.state, commit_id: entry.sha, user: { login: reviewer }, body: entry.body }); }
    if ((args.find(arg => arg.startsWith('query=')) ?? '').includes('reviewThreads'))
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
}
const verdictOf = (reviewId: number, state: string) => () => ({ state, reviewer, reviewId, submittedAt: '2026-09-30T12:20:00Z' });
const launch = (root: string, work: Work, run: ReturnType<typeof herdr>['run'], commit?: { parents: string[]; files: string[] }) =>
  launchReview(root, work, 'claude-reviewer', [], new Date().toISOString(), { run, mint, threads: async () => [], ...(commit ? { observeCommit: async () => ({ ...commit, at: '2026-09-30T12:00:00Z' }) } : {}) });
const recordOf = (records: ReviewRecord[], sha: string) => records.find(record => record.sha === sha)!;

/**
 * The approved head's round, end to end: the approval of H is recorded and planned, the loop asks
 * for the bot round, the worker launcher instructs it, and the bot's head is launched for its fresh
 * read. Returns what each step produced.
 */
async function approvedThenBotRound(root: string, body: string, commit: { parents: string[]; files: string[] }) {
  const config = await loadMasterConfig(root);
  const first = herdr();
  await launch(root, item(H, 1), first.run);
  const approved = item(H, 1, [{ reviewer, sha: H, state: 'APPROVED', id: 901 }]);
  const planned = await reconcileReviews(root, config, { run: first.run, observe: verdictOf(901, 'APPROVED'), work: [approved], threadsRun: github({ 901: { body, sha: H, state: 'APPROVED' } }) });
  const requests = await readMechanicalFixRequests(root);
  const held = mechanicalMergeHold(approved, await readMechanicalFixState(root), Date.now());
  const decision = neededDecision(approved, { autoMerge: true }, [], requests);
  // The approver applied that rework decision: the next attempt's launch reads it and is the bot round.
  const reviewId = appliedMechanicalRework(approved, [{ action: 'rework', state: 'applied', input: { previousWorkerStopped: true, binding: decision?.binding }, approvedAt: new Date().toISOString() }]);
  const worker = workerPrompt({ cliPath: '/opt/graphyard/bin/graphyard.mjs', repository: 'owner/project' }, approved, { principal: botWorker }, 2, null, reviewId === null ? null : { requests, reviewId });
  // The bot round's worker pushed its commit and submitted it: the fresh read of that head is launched.
  const second = herdr();
  await launch(root, item(BOT, 2), second.run, commit);
  const fresh = recordOf((await readReviewLedger(root)).reviews, BOT);
  return { config, planned, requests, held, decision, reviewId, worker, fresh, prompt: second.requests[0]! };
}

test('unit:mechanical-findings-auto-fixed — review findings are classified, and an approved head\'s mechanical ones are fixed by a worker bot commit before the fresh read, which is shown only substance', async () => {
  // Every finding carries a classification and a category.
  const classified = parseClassifiedFindings(verdict);
  assert.deepEqual(classified.map(finding => [finding.path, finding.classification, finding.category]), [
    ['docs/widget.md', 'mechanical', 'typo'],
    ['src/widget.ts', 'mechanical', 'naming'],
    ['docs/operations.md', 'mechanical', 'docs-placement'],
    ['src/widget.ts', 'mechanical', 'formatting'],
    ['src/widget.ts', 'substantive', 'behavior'],
    // A mechanical label never outranks a sign of behaviour, a criterion or the scope.
    ['src/other.ts', 'substantive', 'behavior'],
    // What the classifier cannot place stays with the reviewer.
    [null, 'substantive', 'behavior'],
  ]);
  assert.equal(classified[0]!.text, 'docs/widget.md:12 — "recieve" is a typo', 'the label is read off the finding');
  const unlabelled = (text: string) => classifyFinding({ path: 'src/x.ts', line: 1, text });
  assert.equal(unlabelled('misspelled word in the comment').category, 'typo');
  assert.equal(unlabelled('indentation is off by two spaces').category, 'formatting');
  assert.equal(unlabelled('AC-1 is not shown on the dashboard').category, 'criteria');
  assert.equal(unlabelled('this touches src/y.ts, out of scope for the item').category, 'scope');
  assert.equal(unlabelled('it crashes on an empty list').classification, 'substantive');
  // Everyday words inside a mechanical finding do not force it substantive.
  assert.equal(unlabelled('rename returnsCount to match the naming convention').classification, 'mechanical');
  assert.equal(unlabelled('typo in the "fails" message').classification, 'mechanical');
  // Only an approval gets a bot: a REQUEST_CHANGES head is reworked by its worker.
  assert.equal(mechanicalFixPlan({ ...approval, state: 'CHANGES_REQUESTED' }), null);
  assert.equal(mechanicalFixPlan({ ...approval, body: 'AC-1 met.\nNit: src/a.ts:1 — the retry is unbounded' }), null, 'nothing mechanical, nothing to fix');
  // Every review asks for the classification on each finding line.
  const plain = reviewPrompt({ repository: 'owner/project' }, { key: 'GY-7', pr: 7, sha: H, baseSha: B, policyRevision: 1 }, undefined, undefined, criteria);
  for (const fragment of ['(mechanical: CATEGORY)', 'typo, docs-placement, formatting, naming', '(substantive: CATEGORY)', 'behavior, criteria, scope']) assert.ok(plain.includes(fragment), fragment);
  assert.ok(!plain.includes('bot commit'), 'no bot section without a bot commit at the head');

  const { root, cleanup } = await boundMaster();
  try {
    const paths = ['docs/operations.md', 'docs/widget.md', 'src/widget.ts'];
    const round = await approvedThenBotRound(root, verdict, { parents: [H], files: paths });
    // 1. Reconciliation records the approval's plan, and holds its follow-up filing for the bot round.
    const approvalRecord = recordOf(round.planned.reviews, H);
    assert.equal(approvalRecord.mechanicalFix?.state, 'planned');
    assert.deepEqual(approvalRecord.mechanicalFix?.paths, paths);
    assert.equal(approvalRecord.mechanicalFix?.mechanical.length, 4);
    assert.equal(approvalRecord.followUps, undefined, 'the approval\'s follow-ups wait while the bot round is owed');
    assert.ok(round.planned.threads.some(line => /4 finding\(s\) classified mechanical/.test(line)), round.planned.threads.join('\n'));
    // The approved head is not merged ahead of its round: the loop's merge step holds it while the plan stands, within a bound.
    assert.match(round.held ?? '', /candidate aaaaaaaaaaaa is not merged while review 901's 4 findings classified mechanical wait/);
    const plannedState = { requests: round.requests, unclassified: [] };
    assert.equal(mechanicalMergeHold(item(H, 1), plannedState, Date.parse(round.requests[0]!.at) + mechanicalRoundStartMs), null, 'a plan whose round never starts holds nothing past the bound');
    assert.equal(mechanicalMergeHold(item(BOT, 2), plannedState, Date.now()), null, 'the bot round\'s own head is not held by the plan');
    // An approval the loop has recorded but not yet read for its findings holds the merge too, so no merge lands ahead of the plan.
    const unclassified = { requests: [], unclassified: [{ key: 'GY-7', sha: H, since: new Date().toISOString() }] };
    assert.match(mechanicalMergeHold(item(H, 1), unclassified, Date.now()) ?? '', /until its review is classified/);
    // 2. The loop's routine decision returns the approved head to a worker-class bot round.
    assert.equal(round.decision?.action, 'rework');
    assert.equal(round.decision?.binding, `${H}:mechanical:901`);
    assert.match(round.decision!.reason, /approved candidate aaaaaaaaaaaa with 4 findings classified mechanical/);
    assert.equal(neededDecision({ ...item(H, 1, [{ reviewer, sha: H, state: 'APPROVED', id: 901 }]), reworkRequested: true }, { autoMerge: true }, [], round.requests), null, 'asked once');
    assert.equal(neededDecision(item(H, 2, [{ reviewer, sha: H, state: 'APPROVED', id: 901 }]), { autoMerge: true }, [], round.requests), null, 'not again once the round has run');
    // 3. The worker launcher gives that round exactly the mechanical findings, bounded to their files, as one commit on the head.
    for (const fragment of ['mechanical-fix round', '"recieve" is a typo', 'frobCnt', `whose only parent is ${H}`, `change only ${paths.join(', ')}`, 'change no behaviour', 'complete GY-7 2 7']) assert.ok(round.worker.includes(fragment), `worker prompt: ${fragment}`);
    assert.ok(!round.worker.includes('retry loop is unbounded'), 'the bot is never handed a substantive finding');
    assert.equal(round.reviewId, 901);
    assert.ok(!workerPrompt({ cliPath: '/g', repository: 'owner/project' }, item(H, 1), { principal: botWorker }, 1, null, { requests: round.requests, reviewId: 901 }).includes('mechanical-fix round'), 'the attempt that was approved is not a bot round');
    // The bot's instruction goes only with the mechanical round's own rework decision: a later sync or change-request rework of the same head is ordinary rework.
    const applied = (binding: string, at: string) => ({ action: 'rework', state: 'applied', input: { previousWorkerStopped: true, binding }, approvedAt: at });
    assert.equal(appliedMechanicalRework(item(H, 1), [applied(`${H}:mechanical:901`, '2026-09-30T12:00:00Z'), applied(`${H}:conflict`, '2026-09-30T12:05:00Z')]), null);
    assert.equal(appliedMechanicalRework(item(B, 1), [applied(`${H}:mechanical:901`, '2026-09-30T12:00:00Z')]), null, 'bound to the head it named');
    assert.equal(appliedMechanicalRework(item(H, 1), [{ ...applied(`${H}:mechanical:901`, '2026-09-30T12:00:00Z'), state: 'refused' }]), null, 'only an applied decision');
    // 4. The fresh read of the bot's head is verified as the bot commit and shown only substance.
    assert.equal(round.fresh.freshRead?.botCommit?.sha, BOT);
    assert.equal(round.fresh.freshRead?.botCommit?.bot, botWorker);
    assert.deepEqual(round.fresh.freshRead?.carried.map(finding => finding.classification), ['substantive', 'substantive', 'substantive']);
    for (const prompt of [round.prompt, reviewRetryPrompt('owner/project', round.fresh, criteria)]) {
      assert.ok(prompt.includes(`bot commit ${BOT}`) && prompt.includes(`git show ${BOT}`), 'the delivered prompt names the bot commit');
      assert.ok(prompt.includes('retry loop is unbounded'), 'the substantive findings are judged again');
      for (const mechanical of ['recieve', 'frobCnt', 'trailing whitespace', 'belongs in docs/widget.md']) assert.ok(!prompt.includes(mechanical), `the fresh read is not shown the mechanical finding "${mechanical}"`);
    }
    // 5. The fresh read approves: the bot commit is accepted, the plan applied, and the fresh read's own follow-ups handled.
    const done = await reconcileReviews(root, round.config, { run: herdr().run, observe: verdictOf(902, 'APPROVED'), work: [item(BOT, 2, [{ reviewer, sha: BOT, state: 'APPROVED', id: 902 }])],
      threadsRun: github({ 902: { body: 'AC-1 met.\nNit: src/widget.ts:55 — the retry loop is unbounded (substantive: behavior)\nResolved threads: none\nFollow-up threads: none', sha: BOT, state: 'APPROVED' } }) });
    assert.equal(recordOf(done.reviews, BOT).freshRead?.judged?.outcome, 'accepted');
    assert.equal(recordOf(done.reviews, H).mechanicalFix?.state, 'applied');
    assert.equal(recordOf(done.reviews, H).mechanicalFix?.commit, BOT);
    assert.equal(recordOf(done.reviews, BOT).followUps?.reviewId, 902, 'the fresh read\'s own follow-ups are handled as any approval\'s');
  } finally { await cleanup(); }

  // The bot commit is accepted only as planned: a worker identity other than the reviewer, on the approved head, within the findings' files.
  const plannedFix = mechanicalFixPlan(approval)!;
  assert.match((verifyBotCommit(plannedFix, observed(plannedFix, { author: { principal: 'producer-1', role: 'producer' } }), reviewer) as { reason: string }).reason, /not a worker identity/);
  assert.match((verifyBotCommit(plannedFix, observed(plannedFix, { author: { principal: reviewer, role: 'worker' } }), reviewer) as { reason: string }).reason, /independent/);
  assert.match((verifyBotCommit(plannedFix, observed(plannedFix, { parents: [B] }), reviewer) as { reason: string }).reason, /approved head/);
  assert.match((verifyBotCommit(plannedFix, observed(plannedFix, { files: ['docs/widget.md', 'src/limits.ts'] }), reviewer) as { reason: string }).reason, /src\/limits\.ts, outside/);
  assert.match((verifyBotCommit(plannedFix, { ...observed(plannedFix), sha: 'nope' }, reviewer) as { reason: string }).reason, /could not be verified/, 'a malformed observation is a refusal, not a throw');

  // A plan holds back every finding it keeps from filing: an approval with more substantive findings than the ledger holds is not planned.
  const many = ['AC-1 met.', 'Nit: docs/widget.md:12 — "recieve" is a typo (mechanical: typo)', ...Array.from({ length: 51 }, (_, index) => `Nit: src/widget.ts:${index + 1} — the retry ${index} is unbounded (substantive: behavior)`)].join('\n');
  assert.equal(planMechanicalFix({ key: 'GY-7', pr: 7, sha: H }, 901, many, 1, new Date().toISOString()).state, 'none');

  // A head that is not the planned bot commit is refused as one: the reviewer is handed the mechanical findings back.
  const refusedRoot = await boundMaster();
  try {
    const round = await approvedThenBotRound(refusedRoot.root, verdict, { parents: [H], files: ['src/limits.ts'] });
    assert.equal(round.fresh.freshRead?.botCommit, undefined);
    assert.match(round.fresh.freshRead?.refused ?? '', /src\/limits\.ts, outside/);
    assert.ok(round.prompt.includes('Graphyard refused it as one') && round.prompt.includes('"recieve" is a typo'), 'nothing is lost: the reviewer judges the mechanical findings again');
  } finally { await refusedRoot.cleanup(); }

  // A plan whose round never produced a bot commit falls back: delivered at the approved head, its findings all return to follow-up handling.
  const fallback = await boundMaster();
  try {
    const config = await loadMasterConfig(fallback.root);
    const first = herdr();
    await launch(fallback.root, item(H, 1), first.run);
    const gh = github({ 901: { body: verdict, sha: H, state: 'APPROVED' } });
    const held = await reconcileReviews(fallback.root, config, { run: first.run, observe: verdictOf(901, 'APPROVED'), work: [item(H, 1, [{ reviewer, sha: H, state: 'APPROVED', id: 901 }])], threadsRun: gh });
    assert.equal(recordOf(held.reviews, H).followUps, undefined);
    const delivered = item(H, 1, [{ reviewer, sha: H, state: 'APPROVED', id: 901 }], { stage: 'done' } as Partial<Work>);
    const after = await reconcileReviews(fallback.root, config, { run: first.run, work: [delivered], threadsRun: gh, observe: () => null });
    assert.equal(recordOf(after.reviews, H).mechanicalFix?.state, 'fallback');
    assert.equal(recordOf(after.reviews, H).followUps?.reviewId, 901, 'the mechanical findings return to ordinary follow-up handling');
  } finally { await fallback.cleanup(); }

  // A round that never starts — its rework decision refused, or never applied — falls back past the bound, and the merge it held is released.
  const stalled = await boundMaster();
  try {
    const config = await loadMasterConfig(stalled.root);
    const first = herdr();
    await launch(stalled.root, item(H, 1), first.run);
    const gh = github({ 901: { body: verdict, sha: H, state: 'APPROVED' } });
    const approved = item(H, 1, [{ reviewer, sha: H, state: 'APPROVED', id: 901 }]);
    await reconcileReviews(stalled.root, config, { run: first.run, observe: verdictOf(901, 'APPROVED'), work: [approved], threadsRun: gh });
    assert.equal(recordOf((await readReviewLedger(stalled.root)).reviews, H).mechanicalFix?.state, 'planned');
    const late = new Date(Date.now() + mechanicalRoundStartMs + 60_000);
    const after = await reconcileReviews(stalled.root, config, { run: first.run, work: [approved], threadsRun: gh, observe: () => null, now: () => late });
    assert.equal(recordOf(after.reviews, H).mechanicalFix?.state, 'fallback');
    assert.match(recordOf(after.reviews, H).mechanicalFix?.reason ?? '', /no mechanical-fix round started within 60 minutes/);
    assert.equal(recordOf(after.reviews, H).followUps?.reviewId, 901, 'its findings return to ordinary follow-up handling');
    assert.equal(mechanicalMergeHold(approved, await readMechanicalFixState(stalled.root), late.getTime()), null, 'nothing holds the merge any more');
  } finally { await stalled.cleanup(); }
});

test('unit:mechanical-mislabel-caught — a substantive finding misclassified as mechanical is caught: the fresh read sees the full diff, rejects the bot commit, and the misclassification is an intervention signal for the retro', async () => {
  // The classifier takes the reviewer's label at its word when no substantive sign shows: this one changes a limit.
  const mislabelled = 'AC-1 met.\nNit: src/limits.ts:4 — tidy the MAX constant (mechanical: formatting)\nResolved threads: none\nFollow-up threads: none';
  const { root, cleanup } = await boundMaster();
  try {
    const round = await approvedThenBotRound(root, mislabelled, { parents: [H], files: ['src/limits.ts'] });
    const commit = round.fresh.freshRead!.botCommit!;
    assert.equal(commit.findings[0]!.classification, 'mechanical');
    // The fresh read still reviews the whole diff, bot commit included, and is told how to reject it.
    for (const fragment of ['gh pr diff 7 --repo owner/project', 'You still review the whole diff, the bot commit included', `"Rejected bot commit: ${BOT} — `, 'misclassified', 'REQUEST_CHANGES']) assert.ok(round.prompt.includes(fragment), fragment);

    // Verdicts on the bot's head: an approval accepts it, a change request without the line is ordinary rework, another head says nothing.
    const review = (state: string, body: string, sha = BOT) => ({ state, commit_id: sha, body, submitted_at: '2026-09-30T12:20:00.000Z' });
    assert.deepEqual(judgeBotCommit(commit, review('APPROVED', 'AC-1 met.'), { key: 'GY-7' }), { outcome: 'accepted' });
    assert.deepEqual(judgeBotCommit(commit, review('CHANGES_REQUESTED', 'AC-1 unmet: the count is wrong.'), { key: 'GY-7' }), { outcome: 'rework' });
    assert.deepEqual(judgeBotCommit(commit, review('CHANGES_REQUESTED', `Rejected bot commit: ${BOT} — x`, H), { key: 'GY-7' }), { outcome: 'pending' });
    assert.deepEqual(judgeBotCommit(commit, review('CHANGES_REQUESTED', `Rejected bot commit: ${'d'.repeat(40)} — another commit`), { key: 'GY-7' }), { outcome: 'rework' }, 'a rejection of some other commit is not this one');

    // The reviewer rejects the bot commit, by its short sha. Reconciliation catches it and records the
    // misclassification with the coordinator's credential; a refused record is retried on the next pass.
    const rejection = `AC-1 unmet.\nRejected bot commit: ${BOT.slice(0, 12)} — it raised MAX from 10 to 100, a behaviour change, not formatting`;
    const recorded: { signal: InterventionRecordInput; key: string }[] = [];
    let refuse = true;
    const recordIntervention = async (signal: InterventionRecordInput, key: string) => { if (refuse) { refuse = false; throw new Error('Graphyard refused the intervention (503): busy'); } recorded.push({ signal, key }); };
    const pass = () => reconcileReviews(root, round.config, { run: herdr().run, observe: verdictOf(903, 'CHANGES_REQUESTED'), work: [item(BOT, 2, [{ reviewer, sha: BOT, state: 'CHANGES_REQUESTED', id: 903 }])],
      threadsRun: github({ 903: { body: rejection, sha: BOT, state: 'CHANGES_REQUESTED' } }), recordIntervention });
    const failed = await pass();
    assert.deepEqual({ ...recordOf(failed.reviews, BOT).freshRead?.judged, at: undefined }, { outcome: 'rejected', at: undefined, reason: 'it raised MAX from 10 to 100, a behaviour change, not formatting', recorded: false, attempts: 1, failure: 'Graphyard refused the intervention (503): busy' });
    assert.ok(failed.threads.some(line => line.includes(`rejected bot commit ${BOT.slice(0, 12)}`)), failed.threads.join('\n'));
    const caught = await pass();
    assert.equal(recordOf(caught.reviews, BOT).freshRead?.judged?.recorded, true);
    assert.equal(recordOf(caught.reviews, BOT).freshRead?.judged?.attempts, 2);
    assert.equal(recordOf(caught.reviews, H).mechanicalFix?.state, 'applied', 'the plan is settled by the fresh read');
    await pass();
    assert.equal(recorded.length, 1, 'recorded once');
    assert.equal(recorded[0]!.key, `misclassified-finding:GY-7:${BOT}:903`);

    // The signal is an intervention the control plane records as it records any other (POST /api/interventions).
    assert.ok(interventionKinds.includes('misclassified-finding'));
    const parsed = interventionRecordSchema.parse(recorded[0]!.signal);
    assert.equal(parsed.kind, 'misclassified-finding');
    assert.equal(parsed.work, 'GY-7');
    assert.equal(parsed.trigger, 'formatting', 'the category that was wrong');
    assert.match(parsed.blocked, /src\/limits\.ts:4 \(formatting\)/);
    assert.match(parsed.resolution, /rejected the bot commit: it raised MAX/);

    // Recorded, it reaches the retro synthesis: the intervention report counts it by kind and stage, and its recurrence rule sees it.
    const work = { id: '00000000-0000-4000-8000-000000000007', key: 'GY-7', title: 'Widget', stage: 'review' } as unknown as Work;
    const stored = { id: '11111111-1111-4111-8111-111111111111', kind: parsed.kind, work: { id: work.id, key: 'GY-7', title: 'Widget' }, stage: parsed.stage, blocked: parsed.blocked, trigger: parsed.trigger, since: parsed.since, at: '2026-09-30T12:20:00.000Z', resolution: parsed.resolution };
    const folded = foldInterventions([{ seq: 1, workId: work.id, actor: 'graphyard-master', kind: 'intervention.recorded', at: stored.at, details: {}, payload: stored }], [work], '2026-09-30T13:00:00.000Z');
    assert.equal(folded.interventions.length, 1);
    assert.equal(folded.interventions[0]!.kind, 'misclassified-finding');
    assert.equal(folded.interventions[0]!.waitedMs, 20 * 60_000, 'from the bot commit to its rejection');
    const report = computeInterventionReport(folded, [work], interventionPolicyDefaults, { days: 7, now: '2026-09-30T13:00:00.000Z' });
    assert.deepEqual(report.byKind.map(entry => [entry.kind, entry.count]), [['misclassified-finding', 1]]);
    assert.ok(report.patterns.some(pattern => pattern.kind === 'misclassified-finding' && pattern.stage === 'review' && pattern.count === 1));
  } finally { await cleanup(); }
});
