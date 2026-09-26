import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setupMaster } from '../src/master.js';
import { expandTypedCommand, requestOf, startedAtOnce } from './helpers/launch-shell.js';
import { bindReviewer, launchReview, readReviewLedger, reviewHistory, reviewPrompt, reviewRetryPrompt, reviewRoundCap, saveReviewerProfile, updateReviewLedger, type ReviewRecord } from '../src/reviewer.js';
import type { Observation, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-167, 2026-09-24: every review round re-read the whole change and found new edge cases, and
// nothing bounded the rounds. From the second review of a pull request the reviewer judges only
// the delta since the head it last reviewed plus the open threads, and after three rounds of
// requested changes only an unmet acceptance criterion may request changes.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const H0 = 'c0'.padEnd(40, 'e'), H1 = 'c1'.padEnd(40, 'e'), H2 = 'c2'.padEnd(40, 'e'), H = 'a1'.padEnd(40, 'f'), B = 'b1'.padEnd(40, 'f');
const reviewer = 'graphyard-reviewer[bot]';
const binding = { key: 'GY-64', pr: 64, sha: H, baseSha: B, policyRevision: 1 };
const criteria = [{ id: 'AC-1', text: 'The widget counts every frob.' }];
const deltaInstruction = `git diff ${H2}..${H}`;
const capWording = 'this round only an unmet acceptance criterion may request changes, and every other finding must be listed as a FOLLOW-UP';

let reviewIds = 100;
/** One settled reviewer session of the item's pull request, with the verdict it collected. */
function settled(sha: string, state: string, at: string, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return { id: randomUUID(), key: 'GY-64', pr: 64, sha, baseSha: B, policyRevision: 1, profile: 'claude-reviewer', agentName: 'review-claude-1', pane: null, sessionDirectory: '/tmp/none',
    requestedAt: at, tokenExpiresAt: at, state: 'completed', closedAt: at, verdict: { state, reviewer, reviewId: reviewIds++, submittedAt: at }, ...overrides } as ReviewRecord;
}
/** Three rounds of requested changes on successive heads, oldest first. */
const rounds = () => [settled(H0, 'CHANGES_REQUESTED', '2026-09-24T10:00:00Z'), settled(H1, 'CHANGES_REQUESTED', '2026-09-24T11:00:00Z'), settled(H2, 'CHANGES_REQUESTED', '2026-09-24T12:00:00Z')];

test('unit:review-delta-prompt — a pull request with a completed review of an earlier head is reviewed as the delta since that head plus the unresolved threads', () => {
  // The newest completed review of an earlier head is the one named, whatever order the ledger holds it in.
  const records = [settled(H2, 'CHANGES_REQUESTED', '2026-09-24T12:00:00Z'), settled(H0, 'APPROVED', '2026-09-24T10:00:00Z'), settled(H1, 'DISMISSED', '2026-09-24T11:00:00Z')];
  const history = reviewHistory(records, binding, reviewer);
  assert.equal(history.previousHead, H2);
  const prompt = reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, criteria, history);
  assert.ok(prompt.includes(`You already reviewed an earlier head of this pull request, ${H2}.`), 'the prompt names the head last reviewed');
  assert.ok(prompt.includes(deltaInstruction), 'the prompt gives the delta to review');
  assert.ok(prompt.includes(`git fetch origin ${H2} ${H}`), 'both heads are fetched so the delta can be read');
  assert.ok(prompt.includes(`reviews only what changed since then: git fetch origin ${H2} ${H} && ${deltaInstruction}, plus the still-unresolved review threads`));
  assert.ok(prompt.includes('Do not raise findings on code that is unchanged since that head unless an acceptance criterion is unmet'));
  // The criteria-only rule still stands beside it.
  assert.ok(prompt.includes('[AC-1] The widget counts every frob.'));

  // The first review, or one whose only earlier verdict is of this same head, reads the whole change.
  for (const first of [[], [settled(H, 'DISMISSED', '2026-09-24T12:00:00Z')]]) {
    const none = reviewHistory(first, binding, reviewer);
    assert.equal(none.previousHead, undefined);
    assert.doesNotMatch(reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, criteria, none), /git diff|already reviewed an earlier head/);
  }
  // Only this item's pull request and the configured reviewer count: another PR, another item, another identity, and a session with no verdict do not.
  const foreign = [settled(H2, 'APPROVED', '2026-09-24T12:00:00Z', { pr: 65 }), settled(H2, 'APPROVED', '2026-09-24T12:00:00Z', { key: 'GY-65' }),
    settled(H2, 'APPROVED', '2026-09-24T12:00:00Z', { verdict: { state: 'APPROVED', reviewer: 'someone-else[bot]', reviewId: 5, submittedAt: '2026-09-24T12:00:00Z' } }),
    settled(H2, 'APPROVED', '2026-09-24T12:00:00Z', { state: 'failed', verdict: undefined })];
  assert.equal(reviewHistory(foreign, binding, reviewer).previousHead, undefined);

  // The retry of a session that never took up its request repeats the same delta instruction.
  const retry = reviewRetryPrompt('owner/project', { ...binding, reviewRound: history }, criteria);
  assert.ok(retry.includes(deltaInstruction));
});

test('unit:review-delta-prompt — the launch reads the ledger history and starts the reviewer on the delta prompt', async () => {
  const master = await boundMaster();
  try {
    await updateReviewLedger(master.root, ledger => { ledger.reviews.push(settled(H2, 'CHANGES_REQUESTED', '2026-09-24T12:00:00Z')); });
    let request = null as string | null;
    const run = (_command: string, args: string[]) => {
      if (args[0] === 'pane' && args[1] === 'run') { const typed = expandTypedCommand(args[3]); request = requestOf(typed.kind, typed.args); }
      return herdrRun(_command, args);
    };
    await launchReview(master.root, work(), 'claude-reviewer', [], new Date().toISOString(), { run, mint });
    assert.ok(request, 'the reviewer session started on its request');
    assert.ok(request!.includes(`You already reviewed an earlier head of this pull request, ${H2}.`));
    assert.ok(request!.includes(deltaInstruction));
    assert.ok(!request!.includes(capWording), 'one round of requested changes is not the cap');
    const launched = (await readReviewLedger(master.root)).reviews.find(record => record.state === 'pending')!;
    assert.deepEqual(launched.reviewRound, { previousHead: H2, changesRequested: 1 });
  } finally { await master.cleanup(); }
});

test('unit:review-round-cap — after three CHANGES_REQUESTED rounds the next launch allows changes only for an unmet criterion, from the fourth round only', () => {
  const history = rounds();
  assert.equal(reviewRoundCap, 3);
  // Round n launches with the n - 1 change requests before it.
  for (let round = 1; round <= 4; round++) {
    const counted = reviewHistory(history.slice(0, round - 1), binding, reviewer);
    assert.equal(counted.changesRequested, round - 1);
    const prompt = reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, criteria, counted);
    if (round < 4) assert.ok(!prompt.includes(capWording), `round ${round} carries no cap`);
    else {
      assert.ok(prompt.includes(capWording), 'the fourth round carries the cap');
      assert.ok(prompt.includes('already had 3 rounds of requested changes under this policy revision'));
    }
  }
  // Approvals, dismissals, another reviewer identity, another pull request and another policy revision are not rounds of requested changes.
  const other = [settled(H0, 'APPROVED', '2026-09-24T09:00:00Z'), settled(H0, 'DISMISSED', '2026-09-24T09:30:00Z'),
    settled(H1, 'CHANGES_REQUESTED', '2026-09-24T12:00:00Z', { verdict: { state: 'CHANGES_REQUESTED', reviewer: 'someone-else[bot]', reviewId: 9, submittedAt: '2026-09-24T12:00:00Z' } }),
    settled(H1, 'CHANGES_REQUESTED', '2026-09-24T12:00:00Z', { pr: 65 }), settled(H1, 'CHANGES_REQUESTED', '2026-09-24T12:00:00Z', { policyRevision: 2 })];
  assert.equal(reviewHistory([...history.slice(0, 2), ...other], binding, reviewer).changesRequested, 2);
  // One GitHub review recorded twice (a relaunch of the same head re-reading it) is one round.
  assert.equal(reviewHistory([...history.slice(0, 2), { ...history[1], id: randomUUID() }], binding, reviewer).changesRequested, 2);
  // A new policy revision starts the count again.
  assert.equal(reviewHistory(history, { ...binding, policyRevision: 2 }, reviewer).changesRequested, 0);
  // The count survives the ledger reaping older records: each launch carries the count it started from.
  const newest = { ...history[2], reviewRound: { previousHead: H1, changesRequested: 2 } };
  assert.equal(reviewHistory([newest], binding, reviewer).changesRequested, 3);
  assert.ok(reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, criteria, reviewHistory([newest], binding, reviewer)).includes(capWording));
});

test('unit:review-round-cap — the launch counts the rounds from the review ledger and states the cap on the fourth', async () => {
  for (const [prior, capped] of [[2, false], [3, true]] as const) {
    const master = await boundMaster();
    try {
      await updateReviewLedger(master.root, ledger => { ledger.reviews.push(...rounds().slice(3 - prior)); });
      let request = null as string | null;
      const run = (_command: string, args: string[]) => {
        if (args[0] === 'pane' && args[1] === 'run') { const typed = expandTypedCommand(args[3]); request = requestOf(typed.kind, typed.args); }
        return herdrRun(_command, args);
      };
      await launchReview(master.root, work(), 'claude-reviewer', [], new Date().toISOString(), { run, mint });
      assert.equal(request!.includes(capWording), capped, `round ${prior + 1}`);
      assert.equal((await readReviewLedger(master.root)).reviews.find(record => record.state === 'pending')!.reviewRound?.changesRequested, prior);
    } finally { await master.cleanup(); }
  }
});

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
const herdrRun = (_command: string, args: string[]) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });

async function boundMaster() {
  const root = await temporaryDirectory('rounds'), credentialDirectory = await temporaryDirectory('rounds-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}
function work(): Work {
  const candidate = { sha: H, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  const observation: Observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: B, baseTree: B, baseTipContained: true } as unknown as Observation;
  return { id: 'work-64', key: 'GY-64', title: 'Frobs', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ ...criteria[0], proofs: ['unit:frob-count'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 7, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation, blocker: null, gates: [], violations: [] } as unknown as Work;
}
