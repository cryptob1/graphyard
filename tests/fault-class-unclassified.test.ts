import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { followUpCreateKey } from '../src/review-threads.js';
import { bindReviewer, followUpExhaustedRetryMs, launchReview, reconcileReviews, saveReviewerProfile, stoppedFollowUpAttention } from '../src/reviewer.js';
import { repeatedClientErrorLimit, retryStopAttention } from '../src/retry-stop.js';
import { unansweredRequestAttention } from '../src/cli/unanswered-requests.js';
import { classifyAttention, trackFaults, type FaultRecord } from '../src/model/fault-classes.js';
import type { Observation, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1091, 2026-10-01: five unclassified faults in 24 hours, from two shared causes.
//
// - GY-727, GY-859, GY-1069: "GY-N is awaiting rework for a non-exercising proof: ..." — the line
//   unansweredRequestAttention raises for a producer that recorded its proof as not exercising its
//   criterion (GY-817). Its builder set no kind and no catalogue signature named its wording.
// - GY-73 (PR #501, approval 5379316566) and GY-957 (PR #508, approval 5375815849): "The loop stopped
//   retrying follow-up filing ... Graphyard refused the follow-ups for GY-1071 (409): Idempotency key
//   reused with different input". Two ledger records of one approval — the reviewed head's and the
//   head it was carried onto — appended its findings under the approval's one key, and the reason
//   names the head: GY-1071's ledger shows approval 5379316566 appended "at ccc14e051e77" at 12:41,
//   while the second record's kept append named "at 23f92d8bbe37" and was refused on every retry
//   until the retry stopped. The create path already resolved such a refusal (GY-598); the append did
//   not. The stop line itself also carried no kind.
// The test is named for the proof it produces: manual:fault-class-unclassified.

const nonExercising = [
  ['GY-727', 'unit:reconcile-tick-bounded was recorded as not exercising AC-2 on bc00115a30ef: the mutation removing "Batches yield if they exceed reconcileBatchMs time. Exercise: removed batch time limit check." survived'],
  ['GY-859', 'unit:sync-restores-out-of-scope was recorded as not exercising AC-1 on 418b569602f4: the mutation removing "removed the --restore branch of syncWork in src/cli/workspace.ts (restore loop, commit, recheck)" survived'],
  ['GY-1069', 'unit:docs-no-duplication was recorded as not exercising AC-2 on a5119748b68b: the mutation removing "reverted the docs shrink (README.md and docs/ restored to base)" survived'],
] as const;

test('manual:fault-class-unclassified — GY-727, GY-859, GY-1069: a non-exercising proof awaiting rework is a proof fault, never unclassified', () => {
  const rows = nonExercising.map(([key, finding]) => ({ key, dispatch: { review: null, producers: [{ requestId: `request-${key}`, sinceMs: 600_000, group: 'claude',
    session: { state: 'completed', attempt: 1, resolution: 'recorded its proofs as not exercising their criterion', verdict: null }, unexercised: [finding] }] } }));
  const lines = unansweredRequestAttention(rows);
  assert.equal(lines.length, 3);
  const record: FaultRecord = { instances: [], open: {}, failing: {} };
  const opened = trackFaults(record, classifyAttention(lines), '2026-10-01T17:01:27.555Z');
  assert.deepEqual(opened.map(entry => [entry.subject, entry.kind, entry.faultClass]), nonExercising.map(([key]) => [key, 'nonexercising-proof', 'proof']));
  // A line recorded before its builder set the kind — the instances' own text — is recognised by its wording.
  for (const line of lines) {
    assert.match(line.text, /^GY-\d+ is awaiting rework for a non-exercising proof: /);
    const [worded] = classifyAttention([{ subject: line.subject, text: line.text }]);
    assert.deepEqual([worded.kind, worded.faultClass], ['nonexercising-proof', 'proof'], line.text);
  }
});

test('manual:fault-class-unclassified — a stopped loop retry is a loop fault, never unclassified', () => {
  const recorded = [
    { item: 'GY-73', step: 'follow-up filing for approval 5379316566 (PR #501)', error: 'the follow-ups could not be appended to GY-1071: Graphyard refused the follow-ups for GY-1071 (409): Idempotency key reused with different input' },
    { item: 'GY-957', step: 'follow-up filing for approval 5375815849 (PR #508)', error: 'the follow-ups could not be appended to GY-1054: Graphyard refused the follow-ups for GY-1054 (409): Idempotency key reused with different input' },
  ];
  for (const stop of recorded) {
    const line = retryStopAttention({ ...stop, count: 10, at: '2026-10-01T14:22:19.728Z' });
    for (const item of classifyAttention([line, { subject: line.subject, text: line.text }])) assert.deepEqual([item.kind, item.faultClass], ['retry-stopped', 'loop'], line.text);
  }
});

// --- The append refused as a reused key: GY-73 and GY-957 ------------------------------------------

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const H = '23f92d8bbe37'.padEnd(40, 'f'), B = 'b1'.padEnd(40, 'f');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
const reviewer = 'graphyard-reviewer[bot]', reviewId = 5379316566, submittedAt = '2026-10-01T12:00:00Z';
const verdict = () => ({ state: 'APPROVED', reviewer, reviewId, submittedAt });

async function boundMaster() {
  const root = await temporaryDirectory('append-reuse'), credentialDirectory = await temporaryDirectory('append-reuse-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}
function parent(): Work {
  const candidate = { sha: H, baseSha: B, pr: 501, branch: 'graphyard/gy-73-1', author: 'implementer' };
  const observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(),
    prState: 'open', draft: false, baseTip: B, baseTree: B, baseTipContained: true } as unknown as Observation;
  return { id: 'work-73', key: 'GY-73', title: 'Producer env', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'The producer runs.', proofs: ['unit:producer'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 7, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 501 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, gates: [], violations: [] } as unknown as Work;
}
/** GY-1071: GY-73's open follow-up item, filed by an earlier approval. */
function followUpItem(): Work {
  return { ...parent(), id: 'work-1071', key: 'GY-1071', title: 'Follow-ups from the approved review of GY-73 (PR #501)', description: '1. Finding with no thread: src/producer.ts — earlier',
    type: 'chore', dependencies: ['work-73'], stage: 'backlog', ready: false, candidate: null, observation: null, createdAt: '2026-10-01T11:20:04.645Z',
    origin: { reviewFollowUps: { parent: 'GY-73', findings: [{ path: 'src/producer.ts', text: 'src/producer.ts — earlier' }] } } } as unknown as Work;
}
const herdrRun = (_command: string, args: string[]) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
function github(command: string, args: string[]) {
  if (command !== 'gh') throw new Error(`unexpected ${command}`);
  if (args[1] === `repos/owner/project/pulls/501/reviews/${reviewId}`) return JSON.stringify({ id: reviewId, state: 'APPROVED', commit_id: H, user: { login: reviewer }, submitted_at: submittedAt,
    body: 'AC-1 met.\nFollow-up finding: src/producer.ts:40 — the env bound is undocumented\nFollow-up finding: src/x.ts — a name hides its unit\nResolved threads: none\nFollow-up threads: none' });
  if ((args.find(arg => arg.startsWith('query=')) ?? '').includes('reviewThreads'))
    return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
  throw new Error(`unexpected gh ${args.join(' ')}`);
}

test('manual:fault-class-unclassified — GY-73, GY-957: an append refused as a reused key is filed under its body key once, and the retry never stops on it', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, parent(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => [] });
    const config = await loadMasterConfig(root), board = [parent(), followUpItem()];
    // The control plane as src/server/followups.ts answers: one receipt per key, refused for another body,
    // and only the findings the item does not hold yet are added. The approval's other ledger record
    // already appended under the approval's key, naming the head it reviewed.
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const appendKey = `${followUpCreateKey('owner/project', 501, reviewId)}:append`;
    const held = new Set(['src/producer.ts — earlier']), receipts = new Map<string, { fingerprint: string; result: { key: string; added: number } }>();
    const earlier = { id: 'GY-73', followups: { findings: [{ path: 'src/producer.ts', text: 'src/producer.ts:40 — the env bound is undocumented' }, { path: 'src/x.ts', text: 'src/x.ts — a name hides its unit' }], reason: `Follow-ups named by approval ${reviewId} of GY-73 at ccc14e051e77`, parent: true } };
    receipts.set(appendKey, { fingerprint: digest(earlier), result: { key: 'GY-1071', added: 2 } });
    for (const finding of earlier.followups.findings) held.add(finding.text);
    const sent: string[] = [];
    const append = async (item: string, findings: { path: string | null; text: string }[], reason: string, key: string, parent?: boolean) => {
      sent.push(key);
      const fingerprint = digest({ id: item, followups: { findings, reason, ...(parent ? { parent: true } : {}) } }), receipt = receipts.get(key);
      if (receipt) { if (receipt.fingerprint !== fingerprint) throw new Error(`Graphyard refused the follow-ups for ${item} (409): Idempotency key reused with different input`); return receipt.result; }
      const added = findings.filter(finding => !held.has(finding.text));
      for (const finding of added) held.add(finding.text);
      const result = { key: parent ? 'GY-1071' : item, added: added.length };
      receipts.set(key, { fingerprint, result });
      return result;
    };
    const create = async () => { throw new Error('a follow-up item is never created while GY-1071 is open'); };
    let clock = Date.parse('2026-10-01T12:59:00Z');
    const now = () => new Date(clock);
    let last: Awaited<ReturnType<typeof reconcileReviews>> | undefined;
    for (let cycle = 0; cycle < repeatedClientErrorLimit + 2; cycle++) {
      last = await reconcileReviews(root, config, { run: herdrRun, observe: verdict, work: board, threadsRun: github, createFollowUpItem: create, appendFollowUps: append, now });
      clock += followUpExhaustedRetryMs + 60_000;
    }
    const filing = last!.reviews[0].followUps!;
    assert.equal(filing.failure, undefined, filing.failure);
    assert.equal(filing.item, 'GY-1071', 'the findings are filed into the open follow-up item');
    assert.equal(filing.keyReuse, 'rekeyed');
    assert.equal(filing.stoppedAt, undefined, 'the retry never stops on an unchanged 409');
    assert.equal(filing.attempts, 1);
    assert.deepEqual(stoppedFollowUpAttention(last!.reviews), [], 'no stopped-retry attention is raised');
    assert.equal(sent.length, 2, 'the approval key once, then its body key once; nothing after');
    assert.equal(sent[0], appendKey);
    assert.ok(sent[1]!.startsWith(`${followUpCreateKey('owner/project', 501, reviewId)}:`) && sent[1] !== appendKey && sent[1]!.length <= 200, sent[1]);
    assert.equal(receipts.get(sent[1]!)!.result.added, 0, 'the findings the first append added are not added twice');
  } finally { await cleanup(); }
});
