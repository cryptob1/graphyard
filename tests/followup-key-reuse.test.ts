import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { followUpCreateKey, followUpItem } from '../src/review-threads.js';
import { bindReviewer, existingFollowUpItem, followUpBodyKey, followUpExhaustedRetryMs, launchReview, reconcileReviews, saveReviewerProfile, stoppedFollowUpAttention } from '../src/reviewer.js';
import { clientErrorStatus, nextClientErrorRun, repeatedClientErrorLimit, retryStopped } from '../src/retry-stop.js';
import type { Observation, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-598, 2026-09-26: the loop logged "follow-up filing for GY-169 approval 5322137349 failed
// (attempt 84): ... Graphyard refused the follow-up item (409): Idempotency key reused with
// different input" every cycle. The approval's key had been used with a body that has since
// changed, so every retry was refused and the follow-ups were never filed or linked.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const H = 'a1'.padEnd(40, 'f'), B = 'b1'.padEnd(40, 'f');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
const reviewer = 'graphyard-reviewer[bot]';
const submittedAt = '2026-09-24T12:00:00Z';
const verdict = () => ({ state: 'APPROVED', reviewer, reviewId: 77, submittedAt });
const keyReuse = 'Graphyard refused the follow-up item (409): Idempotency key reused with different input';

async function boundMaster() {
  const root = await temporaryDirectory('key-reuse'), credentialDirectory = await temporaryDirectory('key-reuse-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}
function work(): Work {
  const candidate = { sha: H, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  const observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(),
    prState: 'open', draft: false, baseTip: B, baseTree: B, baseTipContained: true } as unknown as Observation;
  return { id: 'work-64', key: 'GY-64', title: 'Frobs', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'The widget counts every frob.', proofs: ['unit:frob-count'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 7, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, gates: [], violations: [] } as unknown as Work;
}
/** The follow-up item the approval's key made on an earlier attempt, with the body it was sent then. */
function earlierFollowUp(): Work {
  const made = followUpItem({ key: 'GY-64', workId: 'work-64', pr: 64, sha: H, reviewId: 77 }, [], [{ path: 'src/c.ts', line: 12, text: 'src/c.ts:12 — an earlier wording' }]);
  return { ...work(), id: 'work-300', key: 'GY-300', title: made.title, description: made.description, dependencies: ['work-64'], stage: 'backlog', candidate: null, observation: null } as unknown as Work;
}
const herdrRun = (_command: string, args: string[]) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
/** GitHub as the loop's gh sees it: an approval writing one finding with no thread, and no review threads. */
function github(body = 'AC-1 met.\nFollow-up finding: src/c.ts:12 — the retry is unbounded\nResolved threads: none\nFollow-up threads: none') {
  return (command: string, args: string[]) => {
    if (command !== 'gh') throw new Error(`unexpected ${command}`);
    if (args[1] === 'repos/owner/project/pulls/64/reviews/77') return JSON.stringify({ id: 77, state: 'APPROVED', commit_id: H, user: { login: reviewer }, submitted_at: submittedAt, body });
    if ((args.find(arg => arg.startsWith('query=')) ?? '').includes('reviewThreads'))
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
}
const launch = (root: string) => launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => [] });

test('unit:followup-key-reuse-resolved — key reuse with a changed body links to the existing follow-up after one attempt; no further attempts are made', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launch(root);
    const config = await loadMasterConfig(root), board = [work(), earlierFollowUp()];
    // The control plane holds a receipt for the approval's key with a body this attempt no longer sends.
    const sent: string[] = [];
    const server = async (_item: unknown, key: string) => { sent.push(key); throw new Error(keyReuse); };
    let clock = Date.parse('2026-09-26T11:00:00Z');
    const now = () => new Date(clock);
    const first = await reconcileReviews(root, config, { run: herdrRun, observe: verdict, work: board, threadsRun: github(), createFollowUpItem: server, now });
    const filing = first.reviews[0].followUps!;
    assert.equal(filing.item, 'GY-300', 'the approval is recorded as filed against the item its key already made');
    assert.equal(filing.failure, undefined);
    assert.equal(filing.attempts, 1);
    assert.equal(filing.keyReuse, 'linked');
    assert.deepEqual(sent, [followUpCreateKey('owner/project', 64, 77)], 'one create, under the approval key; the refusal is not retried');
    assert.ok(first.threads.some(line => line.startsWith('filed 0 follow-up review thread(s) on GY-64 PR #64 as GY-300') && line.includes('already made')), first.threads.join('\n'));
    assert.ok(!first.threads.some(line => /failed/.test(line)), first.threads.join('\n'));
    // Later cycles, past every retry pace, send nothing more.
    for (let cycle = 0; cycle < 3; cycle++) {
      clock += followUpExhaustedRetryMs + 60_000;
      const again = await reconcileReviews(root, config, { run: herdrRun, observe: verdict, work: board, threadsRun: github(), createFollowUpItem: server, now });
      assert.equal(again.reviews[0].followUps!.item, 'GY-300');
      assert.equal(again.reviews[0].followUps!.attempts, 1);
    }
    assert.equal(sent.length, 1, 'no further attempts are made');
  } finally { await cleanup(); }
});

test('unit:followup-key-reuse-resolved — with no item for the approval, the body is filed under a key of the approval and the body hash, once', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launch(root);
    const config = await loadMasterConfig(root), approvalKey = followUpCreateKey('owner/project', 64, 77);
    const sent: { key: string; item: any }[] = [];
    const server = async (item: any, key: string) => { sent.push({ key, item }); if (key === approvalKey) throw new Error(keyReuse); return { key: 'GY-301' }; };
    const first = await reconcileReviews(root, config, { run: herdrRun, observe: verdict, work: [work()], threadsRun: github(), createFollowUpItem: server });
    assert.equal(first.reviews[0].followUps!.item, 'GY-301');
    assert.equal(first.reviews[0].followUps!.failure, undefined);
    assert.equal(first.reviews[0].followUps!.keyReuse, 'rekeyed');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].key, followUpBodyKey(approvalKey, sent[1].item));
    assert.ok(sent[1].key.startsWith(`${approvalKey}:`) && sent[1].key.length <= 200);
    assert.deepEqual(sent[1].item, sent[0].item, 'the same body, under its own key');
    assert.notEqual(followUpBodyKey(approvalKey, { ...sent[1].item, description: 'changed' }), sent[1].key, 'another body gets another key');
    await reconcileReviews(root, config, { run: herdrRun, observe: verdict, work: [work()], threadsRun: github(), createFollowUpItem: server, now: () => new Date(Date.now() + 2 * followUpExhaustedRetryMs) });
    assert.equal(sent.length, 2, 'filed once; nothing is sent again');
  } finally { await cleanup(); }
});

test('unit:followup-key-reuse-resolved — the existing follow-up is found by parent and approval id only', () => {
  const parent = { id: 'work-64', key: 'GY-64' }, earlier = earlierFollowUp();
  assert.equal(existingFollowUpItem([work(), earlier], parent, 77), 'GY-300');
  assert.equal(existingFollowUpItem([earlier], parent, 78), undefined, 'another approval of the same parent');
  assert.equal(existingFollowUpItem([{ ...earlier, dependencies: ['work-65'] }], parent, 77), undefined, 'another parent');
  assert.equal(existingFollowUpItem([{ ...earlier, title: 'Something else' }], parent, 77), undefined, 'not a follow-up item');
});

test('unit:repeated-4xx-retry-stops — a loop retry failing with the same 4xx on 10 consecutive attempts stops and raises one attention item', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launch(root);
    const config = await loadMasterConfig(root);
    const refusal = 'Graphyard refused the follow-up item (422): plannedFiles entry is invalid';
    let sent = 0;
    const server = async () => { sent++; throw new Error(refusal); };
    let clock = Date.parse('2026-09-26T11:00:00Z');
    const now = () => new Date(clock);
    let last: Awaited<ReturnType<typeof reconcileReviews>> | undefined;
    for (let attempt = 1; attempt <= repeatedClientErrorLimit; attempt++) {
      last = await reconcileReviews(root, config, { run: herdrRun, observe: verdict, work: [work()], threadsRun: github(), createFollowUpItem: server, now });
      clock += followUpExhaustedRetryMs + 60_000;
      const filing = last.reviews[0].followUps!;
      assert.equal(filing.clientError?.count, attempt);
      assert.equal(!!filing.stoppedAt, attempt === repeatedClientErrorLimit, `attempt ${attempt}`);
      // Nothing is raised until the stop.
      assert.equal(stoppedFollowUpAttention(last.reviews).length, attempt === repeatedClientErrorLimit ? 1 : 0);
    }
    assert.equal(sent, repeatedClientErrorLimit);
    assert.ok(last!.threads.some(line => line.includes('stopped retrying after 10 consecutive attempts')), last!.threads.join('\n'));
    // Stopped: later cycles, however late, attempt nothing.
    for (let cycle = 0; cycle < 5; cycle++) {
      clock += 60 * 60_000;
      last = await reconcileReviews(root, config, { run: herdrRun, observe: verdict, work: [work()], threadsRun: github(), createFollowUpItem: server, now });
    }
    assert.equal(sent, repeatedClientErrorLimit, 'no attempt after the stop');
    // One attention item naming the step, the error and the item.
    const attention = stoppedFollowUpAttention(last!.reviews);
    assert.equal(attention.length, 1);
    assert.equal(attention[0].subject, 'GY-64');
    assert.match(attention[0].text, /stopped retrying follow-up filing for approval 77 \(PR #64\) for GY-64/);
    assert.ok(attention[0].text.includes(refusal), attention[0].text);
    assert.equal(attention[0].role, 'master');
  } finally { await cleanup(); }
});

test('unit:repeated-4xx-retry-stops — only an unchanged 4xx counts toward the stop', () => {
  assert.equal(clientErrorStatus('Graphyard refused the follow-up item (409): reused'), 409);
  assert.equal(clientErrorStatus('gh: HTTP 422: Validation Failed'), 422);
  assert.equal(clientErrorStatus('Graphyard refused the follow-up item (503): unavailable'), null);
  assert.equal(clientErrorStatus('fetch failed: connection reset'), null);
  let run = undefined as ReturnType<typeof nextClientErrorRun>;
  for (let attempt = 0; attempt < repeatedClientErrorLimit - 1; attempt++) run = nextClientErrorRun(run, 'refused (403): forbidden');
  assert.equal(retryStopped(run), false);
  // A different error restarts the count; a 5xx or a transport error ends it.
  assert.equal(nextClientErrorRun(run, 'refused (404): gone')?.count, 1);
  assert.equal(nextClientErrorRun(run, 'refused (503): unavailable'), undefined);
  assert.equal(nextClientErrorRun(run, undefined), undefined);
  assert.equal(retryStopped(nextClientErrorRun(run, 'refused (403): forbidden')), true);
});
