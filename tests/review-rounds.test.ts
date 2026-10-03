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
import { blockingFindings, defaultReviewRoundCap, followUpFindingsOf, observedReviewBody, reviewBodyMax, reviewRoundStatus, withReviewRounds } from '../src/review-cap.js';
import { cappedReview, neededDecision } from '../src/daemon/decisions.js';
import { cappedEscalation } from '../src/daemon/cycle-review-cap.js';
import { routedScopeStatus } from '../src/cli/owed-report.js';

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

// GY-1118: past the item's review-round cap only a BLOCKING: finding holds the head, and it escalates.
const pipeline = (reworkRounds: number) => ({ attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds, interventions: { blocked: 0, requirements: 0 } });
const blockingWording = 'on its own line starting BLOCKING: in the body of REQUEST_CHANGES';

test('unit:review-rounds-capped — a change request past the cap is read for BLOCKING: lines: one naming none is filed as follow-ups, one naming one escalates, and neither is reworked; the round shows per item', () => {
  assert.deepEqual(blockingFindings('Looks fine.\nBLOCKING: AC-1 is not met\n- **BLOCKING**: the token is logged in clear\nBLOCKING: none\nNot blocking: naming'), ['AC-1 is not met', 'the token is logged in clear']);
  assert.deepEqual(blockingFindings('Nothing here is BLOCKING: it is all follow-up material.'), [], 'the word in prose names no finding');
  assert.deepEqual(followUpFindingsOf('BLOCKING: AC-1 is not met\n\nRename the helper.\n- Add a table test.\n- Trim the comment.'), ['Rename the helper.', '- Add a table test.', '- Trim the comment.']);

  // The verdict's own scaffolding — preamble, headings, per-criterion judgements, the classification and thread-summary lines — is no finding.
  const verdict = 'Review of #597 at head abc for GY-64.\n\n## Acceptance criteria\n\n- **[AC-1] MET.** The widget counts.\n- **[DOCS] MET.** Documented.\n\nRename the helper.\n\n- BLOCKING findings: none\n\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none';
  assert.deepEqual(followUpFindingsOf(verdict), ['Rename the helper.']);
  // Follow-up finding: lines, when the reviewer names them, are the findings and nothing else is.
  assert.deepEqual(followUpFindingsOf(`${verdict}\n\nFollow-up finding: src/a.ts:1 — trim the comment.\n- **Follow-up finding:** add a table test.`), ['src/a.ts:1 — trim the comment.', 'add a table test.']);
  // A long verdict keeps its BLOCKING: and Follow-up finding: lines however late they come, and the blocking ones are read from the whole body.
  const long = `${'Judgement prose. '.repeat(200)}\n\nFollow-up finding: trim the comment.\nBLOCKING: AC-1 is not met past character ${reviewBodyMax}`;
  const kept = observedReviewBody(long);
  assert.ok(long.length > reviewBodyMax && kept.body.length <= reviewBodyMax);
  assert.deepEqual([kept.blocking, blockingFindings(kept.body), followUpFindingsOf(kept.body)], [[`AC-1 is not met past character ${reviewBodyMax}`], [`AC-1 is not met past character ${reviewBodyMax}`], ['trim the comment.']]);
  assert.deepEqual(observedReviewBody('Rename the helper.'), { body: 'Rename the helper.' }, 'a short body is kept whole, with no blocking field when it names none');

  assert.equal(defaultReviewRoundCap, 3);
  assert.deepEqual([0, 1, 2, 3].map(rounds => reviewRoundStatus({ pipeline: pipeline(rounds) }, 3)), [{ round: 1, cap: 3, capped: false }, { round: 2, cap: 3, capped: false }, { round: 3, cap: 3, capped: false }, { round: 4, cap: 3, capped: true }]);
  const row = { key: 'GY-64', attention: null, attentionOwner: null };
  assert.deepEqual(routedScopeStatus({ work: [row], attentionItems: [] }, [{ ...work(), pipeline: pipeline(3) }], [], { reviewRoundCap: 5 }).work, [{ ...row, reviewRound: { round: 4, cap: 5, capped: false } }], 'master status rows carry the round against the configured cap');
  assert.deepEqual(withReviewRounds([{ key: 'GY-64' }, { key: 'GY-65' }], [{ key: 'GY-64', pipeline: pipeline(3) }], 3), [{ key: 'GY-64', reviewRound: { round: 4, cap: 3, capped: true } }, { key: 'GY-65', reviewRound: null }], 'master status shows each item\'s round');

  const config = { autoMerge: true, reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.pem', boundAt: '2026-09-24T00:00:00Z' } };
  const changed = (rounds: number, body: string, from = reviewer) => {
    const item = work();
    item.pipeline = pipeline(rounds);
    item.observation = { ...item.observation!, reviews: [{ reviewer: from, sha: H, state: 'CHANGES_REQUESTED', id: 4242, submittedAt: '2026-09-24T12:00:00Z', body }] };
    return item;
  };
  // Within the cap a change request is reworked exactly as before, whatever it names.
  assert.equal(cappedReview(changed(2, 'Rename the helper.'), config), null);
  assert.equal(neededDecision(changed(2, 'Rename the helper.'), config)?.action, 'rework');
  // Past it, the reviewer App's request naming no blocking finding is a follow-up filing, never a rework.
  const followUp = cappedReview(changed(3, 'Rename the helper.\n\n- Add a table test.'), config)!;
  assert.deepEqual([followUp.kind, followUp.round, followUp.cap, followUp.reviewId, followUp.findings], ['follow-up', 4, 3, 4242, ['Rename the helper.', '- Add a table test.']]);
  assert.equal(neededDecision(changed(3, 'Rename the helper.'), config), null);
  // One naming a blocking finding escalates, and is not reworked either.
  const blocking = cappedReview(changed(3, 'BLOCKING: AC-1 is not met'), config)!;
  assert.deepEqual([blocking.kind, blocking.blocking], ['escalate', ['AC-1 is not met']]);
  assert.match(blocking.reason, /GY-64 is in review round 4, past its cap of 3, and graphyard-reviewer\[bot\] names a blocking finding/);
  assert.equal(neededDecision(changed(3, 'BLOCKING: AC-1 is not met'), config), null);
  assert.match(cappedEscalation({ key: 'GY-64' }, blocking), /an independent approver decides whether the finding is blocking — graphyard master decide GY-64 rework REASON/);
  // A blocking finding the observation read from the whole body escalates even when the kept body no longer shows it.
  const cut = changed(3, 'Rename the helper.');
  cut.observation!.reviews[0].blocking = ['AC-1 is not met'];
  assert.deepEqual([cappedReview(cut, config)!.kind, cappedReview(cut, config)!.blocking], ['escalate', ['AC-1 is not met']]);
  // A request Graphyard cannot withdraw as its reviewer App — a person's — escalates rather than being filed.
  assert.equal(cappedReview(changed(3, 'Rename the helper.', 'a-person'), config)!.kind, 'escalate');
  assert.equal(cappedReview(changed(3, 'Rename the helper.'), { ...config, reviewer: undefined })!.kind, 'escalate');
  // The cap is configuration: at 5, round 4 is ordinary.
  assert.equal(cappedReview(changed(3, 'Rename the helper.'), { ...config, reviewRoundCap: 5 }), null);
  assert.equal(neededDecision(changed(3, 'Rename the helper.'), { ...config, reviewRoundCap: 5 })?.action, 'rework');

  // The reviewer is told the form past the cap, from the item's own round and the configured cap.
  const prompt = (rounds: number, cap = 3) => reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, criteria, { changesRequested: 0 }, undefined, null, reviewRoundStatus({ pipeline: pipeline(rounds) }, cap));
  assert.ok(prompt(3).includes('This is review round 4 of this item, past its cap of 3 rounds'));
  assert.ok(prompt(3).includes(capWording) && prompt(3).includes(blockingWording));
  assert.ok(!prompt(2).includes(blockingWording) && !prompt(3, 4).includes(blockingWording));
});

test('unit:review-rounds-capped — the reviewer launched for an item past its cap is told to name blocking findings on BLOCKING: lines', async () => {
  const master = await boundMaster();
  try {
    let request = null as string | null;
    const run = (_command: string, args: string[]) => {
      if (args[0] === 'pane' && args[1] === 'run') { const typed = expandTypedCommand(args[3]); request = requestOf(typed.kind, typed.args); }
      return herdrRun(_command, args);
    };
    const item = work();
    item.pipeline = pipeline(3);
    await launchReview(master.root, item, 'claude-reviewer', [], new Date().toISOString(), { run, mint });
    assert.ok(request!.includes('This is review round 4 of this item, past its cap of 3 rounds'), request!);
    assert.ok(request!.includes(blockingWording));
  } finally { await master.cleanup(); }
});
