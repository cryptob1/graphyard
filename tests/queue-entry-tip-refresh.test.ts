import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/github.js';
import { ejectionReason, predictQueue, queueRef, validatedQueueEntry, type QueuePlacement } from '../src/merge-queue.js';
import { carriedApproval, evidenceBindsCandidate, type Evidence, type Work } from '../src/model.js';
import { evaluateLandability } from '../src/model/landability.js';

// GY-1131: The queue verifies and refreshes waiting entries when work lands behind them
// instead of conflict-ejecting them at their turn.

const sha40 = (digit: string) => digit.repeat(40);
const BASE1 = sha40('b1');
const BASE2 = sha40('b2');
const HEAD1 = sha40('1a');
const HEAD2 = sha40('2a');
const HEAD3 = sha40('3a');
const TIP2 = sha40('2t');
const at = '2026-10-01T12:00:00.000Z';

function makeItem(key: string, head: string, sequence: number, overrides: Partial<Work> = {}): Work {
  const branch = `graphyard/${key.toLowerCase()}-1`;
  const candidate = { sha: head, baseSha: BASE1, pr: Number(key.replace(/\D/g, '')), branch, author: 'worker' };
  return {
    id: `work-${key.toLowerCase()}`, key, title: key, description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'criterion', proofs: ['unit:test'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'merge', revision: 1, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    candidate, submission: { epoch: 1, pr: candidate.pr }, reworkRequested: false,
    workspaces: [{ host: 'box', path: `/tmp/${key}`, epoch: 1, owner: 'worker', branch }],
    scenarioRequirements: [], evidence: [], blocker: null, gates: [{ name: 'build', passed: true, reasons: [] }], violations: [],
    queue: { sequence, enqueuedAt: at, policyRevision: 1, speculation: null },
    queueSequence: sequence, queueHistory: [],
    observation: {
      candidate, checks: [{ name: 'test', result: 'success', appId: 1 }],
      reviews: [{ reviewer: 'reviewer[bot]', sha: head, state: 'APPROVED', id: 101, submittedAt: at }],
      merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/feature.ts'], scopeFiles: [], at,
      prState: 'open', draft: false, baseTip: BASE1, baseTree: sha40('t1'), baseTipContained: true,
    },
    ...overrides,
  } as unknown as Work;
}

function makeStubGitHub() {
  const pushes: string[] = [];
  const testMergeCalls: { key: string; head: string; base: string }[] = [];
  const publishedRefs = new Map<string, string>();
  const branchRefs = new Map<string, string>();

  const github = new GitHub({ repository: 'cryptob1/graphyard', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used' });
  github.controlPlaneLogin = async () => 'graphyard[bot]';
  github.commitTree = async (sha: string) => sha40(`t${sha.slice(0, 1)}`);
  (github as any).tipTree = async (sha: string) => sha40(`t${sha.slice(0, 1)}`);
  github.updateBranch = async (branch: string, sha: string) => {
    pushes.push(`move ${branch} ${sha.slice(0, 12)}`);
    branchRefs.set(branch, sha);
  };
  github.publishRef = async (ref: string, sha: string) => {
    publishedRefs.set(ref, sha);
  };
  github.changedFiles = async (from: string, to: string) => {
    return ['src/feature.ts'];
  };
  github.testMerge = async (key: string, head: string, base: string) => {
    testMergeCalls.push({ key, head, base });
    github.lastTestMergeSha = TIP2;
    return null;
  };
  github.request = async (path: string, method = 'GET', body?: any) => {
    if (path.startsWith('/commits/')) {
      const sha = path.slice(9);
      return { sha, commit: { author: { email: 'graphyard[bot]@users.noreply.github.com' } }, author: { login: 'graphyard[bot]', type: 'Bot' }, parents: [{ sha: HEAD2 }, { sha: BASE2 }] };
    }
    if (path.startsWith('/compare/')) {
      return { status: 'ahead', files: [{ filename: 'src/feature.ts', patch: '@@ -1 +1 @@\n+change' }] };
    }
    if (method === 'PATCH' && path.startsWith('/git/refs/')) {
      const name = path.replace('/git/refs/', '');
      pushes.push(`patch ${name} ${body.sha}`);
      return { object: { sha: body.sha } };
    }
    return {};
  };

  return { github, pushes, testMergeCalls, publishedRefs, branchRefs };
}

// ---- AC-1: test-merges queued entries behind a landing ----------------------------------------------

test('unit:landing-test-merges-overlapping-queued-entries — scratch test-merges waiting queued entries whose reviewed files overlap landed diff, but skips position 0', async () => {
  const { github, testMergeCalls } = makeStubGitHub();
  const head = makeItem('GY-101', HEAD1, 1);
  const waiting1 = makeItem('GY-102', HEAD2, 2, { observation: { ...makeItem('GY-102', HEAD2, 2).observation!, files: ['src/feature.ts'] } });
  const waiting2 = makeItem('GY-103', HEAD3, 3, { observation: { ...makeItem('GY-103', HEAD3, 3).observation!, files: ['src/other.ts'] } });
  const all = [head, waiting1, waiting2];

  await github.refreshQueueOnLanding(all, BASE2, BASE1, ['src/feature.ts']);

  assert.equal(testMergeCalls.length, 1, 'only one entry was test-merged');
  assert.equal(testMergeCalls[0].key, 'GY-102', 'waiting entry with overlapping files was test-merged');
  assert.equal(testMergeCalls[0].base, BASE2, 'test-merged against new landing base');
  assert.ok(!testMergeCalls.some(call => call.key === 'GY-101'), 'head entry at position 0 was not test-merged');
  assert.ok(!testMergeCalls.some(call => call.key === 'GY-103'), 'waiting entry outside landed diff was not test-merged');
});

test('unit:refresh-skips-entries-outside-landed-diff — skips queued entries whose reviewed files do not overlap landed diff', async () => {
  const { github, testMergeCalls } = makeStubGitHub();
  const head = makeItem('GY-101', HEAD1, 1);
  const waiting = makeItem('GY-102', HEAD2, 2, { observation: { ...makeItem('GY-102', HEAD2, 2).observation!, files: ['src/unrelated.ts'] } });
  const all = [head, waiting];

  await github.refreshQueueOnLanding(all, BASE2, BASE1, ['src/feature.ts']);

  assert.equal(testMergeCalls.length, 0, 'no test merge performed for non-overlapping entry');
  assert.equal(waiting.candidate!.sha, HEAD2, 'candidate sha remains unchanged');
});

test('unit:refresh-bounded-once-per-entry-per-landing — bounded to at most once per entry per landing', async () => {
  const { github, testMergeCalls } = makeStubGitHub();
  const head = makeItem('GY-101', HEAD1, 1);
  const waiting = makeItem('GY-102', HEAD2, 2, { observation: { ...makeItem('GY-102', HEAD2, 2).observation!, files: ['src/feature.ts'] } });
  const all = [head, waiting];

  await github.refreshQueueOnLanding(all, BASE2, BASE1, ['src/feature.ts']);
  assert.equal(testMergeCalls.length, 1);
  assert.equal(waiting.queue!.refreshedLanding, BASE2);

  // Calling refreshQueueOnLanding again with the same BASE2
  await github.refreshQueueOnLanding(all, BASE2, BASE1, ['src/feature.ts']);
  assert.equal(testMergeCalls.length, 1, 'testMerge was not invoked a second time for the same landing base');
});

// ---- AC-2: clean refresh publishes entry tip under single push -------------------------------------

test('unit:clean-refresh-publishes-entry-tip — clean test merge is published as speculative tip on entry branch', async () => {
  const { github, publishedRefs } = makeStubGitHub();
  const head = makeItem('GY-101', HEAD1, 1);
  const waiting = makeItem('GY-102', HEAD2, 2, { observation: { ...makeItem('GY-102', HEAD2, 2).observation!, files: ['src/feature.ts'] } });
  const all = [head, waiting];

  const result = await github.refreshQueueOnLanding(all, BASE2, BASE1, ['src/feature.ts']);

  assert.equal(result.refreshed.length, 1);
  assert.equal(waiting.candidate!.sha, TIP2, 'candidate sha updated to speculative tip');
  assert.equal(waiting.candidate!.baseSha, BASE2, 'candidate base updated to landing base');
  assert.equal(waiting.queue!.speculation?.tip, TIP2);
  assert.equal(waiting.queue!.speculation?.base, BASE2);
  assert.equal(waiting.queue!.speculation?.trigger, 'landing-refresh');
  assert.equal(publishedRefs.get(queueRef('GY-102')), TIP2);
});

test('unit:refreshed-entry-keeps-approval-and-proofs — approval, proofs and queue position survive clean refresh', async () => {
  const { github } = makeStubGitHub();
  const head = makeItem('GY-101', HEAD1, 1);
  const evidence: Evidence = { id: 'ev-1', proof: 'unit:test', sha: HEAD2, baseSha: BASE1, policyRevision: 1, producer: 'ci', trusted: true, result: 'pass', executed: 1, skipped: 0, at, scopeFiles: ['src/'] };
  const waiting = makeItem('GY-102', HEAD2, 2, {
    evidence: [evidence],
    observation: { ...makeItem('GY-102', HEAD2, 2).observation!, files: ['src/feature.ts'] },
  });
  const all = [head, waiting];

  await github.refreshQueueOnLanding(all, BASE2, BASE1, ['src/feature.ts']);

  assert.equal(waiting.queue!.sequence, 2, 'queue sequence survived refresh unchanged');
  const carried = carriedApproval(waiting);
  assert.ok(carried, 'approval survived refresh');
  assert.equal(carried?.carried, true);
  assert.ok(evidenceBindsCandidate(waiting, evidence), 'proof evidence binds refreshed candidate');
});

test('unit:refresh-push-is-single-head-binding — single push moves the branch to speculative tip', async () => {
  const { github, pushes } = makeStubGitHub();
  const head = makeItem('GY-101', HEAD1, 1);
  const waiting = makeItem('GY-102', HEAD2, 2, { observation: { ...makeItem('GY-102', HEAD2, 2).observation!, files: ['src/feature.ts'] } });
  const all = [head, waiting];

  await github.refreshQueueOnLanding(all, BASE2, BASE1, ['src/feature.ts']);

  assert.equal(pushes.length, 1, `branch was pushed exactly once, not multiple times: ${JSON.stringify(pushes)}`);
  assert.equal(pushes[0], `move graphyard/gy-102-1 ${TIP2.slice(0, 12)}`);
});

// ---- AC-3: confirmed conflict requests rework immediately -----------------------------------------

test('unit:confirmed-conflict-yields-head-at-landing — confirmed conflict requests rework immediately and yields head to next entry', async () => {
  const { github } = makeStubGitHub();
  github.testMerge = async () => 'merge conflict in src/feature.ts';
  const head = makeItem('GY-101', HEAD1, 1);
  const waiting1 = makeItem('GY-102', HEAD2, 2, { observation: { ...makeItem('GY-102', HEAD2, 2).observation!, files: ['src/feature.ts'] } });
  const waiting2 = makeItem('GY-103', HEAD3, 3, { observation: { ...makeItem('GY-103', HEAD3, 3).observation!, files: ['src/feature.ts'] } });
  const all = [head, waiting1, waiting2];

  const result = await github.refreshQueueOnLanding(all, BASE2, BASE1, ['src/feature.ts']);

  assert.equal(result.conflicts.length, 2);
  assert.equal(waiting1.reworkRequested, true, 'rework requested immediately');
  assert.ok(waiting1.queue!.sequence > 3, 'moved to back of queue');

  // Next entry prediction: waiting1 was passed over and moved to back
  const queueAfterLanding = [waiting2, waiting1];
  const placements = predictQueue(queueAfterLanding, Date.now());
  const pWaiting2 = placements.find(p => p.key === 'GY-103');
  assert.equal(pWaiting2?.position, 0, 'next entry GY-103 now heads the queue');
});

test('unit:early-rework-names-conflict-and-base — early rework records conflict message and base tip that caused it', async () => {
  const { github } = makeStubGitHub();
  const conflictText = 'Automatic merge failed: conflict in src/feature.ts';
  github.testMerge = async () => conflictText;
  const head = makeItem('GY-101', HEAD1, 1);
  const waiting = makeItem('GY-102', HEAD2, 2, { observation: { ...makeItem('GY-102', HEAD2, 2).observation!, files: ['src/feature.ts'] } });
  const all = [head, waiting];

  await github.refreshQueueOnLanding(all, BASE2, BASE1, ['src/feature.ts']);

  assert.ok(waiting.baseRefresh?.conflict, 'conflict recorded on baseRefresh');
  assert.match(waiting.baseRefresh!.conflict!, new RegExp(BASE2.slice(0, 12)), 'names the base tip that caused it');
  assert.match(waiting.baseRefresh!.conflict!, new RegExp(conflictText), 'names the conflict text');
  assert.equal(waiting.baseRefresh!.base, BASE2);
});

test('unit:conflicting-entry-never-heads-the-queue — conflicting entry is passed over and never heads the queue', async () => {
  const conflicting = makeItem('GY-102', HEAD2, 1, {
    reworkRequested: true,
    baseRefresh: {
      from: { sha: HEAD2, baseSha: BASE1 },
      base: BASE2,
      policyRevision: 1,
      conflict: `Candidate ${HEAD2.slice(0, 12)} cannot be brought onto base branch tip ${BASE2.slice(0, 12)} without resolving a conflict`,
      at, head: null, merge: null, carry: null, trigger: 'conflict confirmed'
    } as any,
  });
  const valid = makeItem('GY-103', HEAD3, 2);
  const placements = predictQueue([conflicting, valid], Date.now());

  const pConflicting = placements.find(p => p.key === 'GY-102');
  const pValid = placements.find(p => p.key === 'GY-103');

  assert.equal(pValid?.position, 0, 'valid entry heads the queue');
  assert.ok(pConflicting?.reasons.some(r => r.includes('passed over until revalidated')), 'conflicting entry is marked as passed over');
  assert.equal(validatedQueueEntry(conflicting), false, 'conflicting entry is not validated');

  // When moved to the back of the queue behind valid entries
  conflicting.queue!.sequence = 3;
  const placementsAfterMove = predictQueue([conflicting, valid], Date.now());
  const pConflictingAfter = placementsAfterMove.find(p => p.key === 'GY-102');
  assert.equal(pConflictingAfter?.position, 1, 'conflicting entry is at the back of the queue');
});

// ---- AC-4: clean entry lands without ejection; landability holds conflicting entry -----------------

test('unit:refreshed-entry-lands-without-ejection — refreshed entry reaches turn mergeable and lands without base-conflict ejection', async () => {
  const evidence: Evidence = { id: 'ev-1', proof: 'unit:test', sha: HEAD2, baseSha: BASE1, policyRevision: 1, producer: 'ci', trusted: true, result: 'pass', executed: 1, skipped: 0, at, scopeFiles: ['src/'] };
  const refreshed = makeItem('GY-102', TIP2, 1, {
    candidate: { sha: TIP2, baseSha: BASE2, pr: 102, branch: 'graphyard/gy-102-1', author: 'worker' },
    evidence: [evidence],
    queue: {
      sequence: 1, enqueuedAt: at, policyRevision: 1,
      speculation: {
        ref: 'refs/heads/queue/GY-102', tip: TIP2, base: BASE2, baseTree: sha40('t2'), predecessors: [], policyRevision: 1, publishedAt: at,
        reviewedHead: HEAD2, trigger: 'landing-refresh',
        carry: {
          from: { sha: HEAD2, baseSha: BASE1 }, to: { sha: TIP2, baseSha: BASE2 }, policyRevision: 1, at,
          predecessor: 'base branch', changedFiles: ['src/other.ts'], reviewedFiles: ['src/feature.ts'],
          approval: { carried: true, reviewer: 'reviewer[bot]', sha: HEAD2, originalSha: HEAD2, provider: 'github' } as any,
          evidence: [{ proof: 'unit:test', carried: true, evidenceId: 'ev-1', producer: 'ci', reason: 'carried' }],
        },
      },
      refreshedLanding: BASE2,
    },
    observation: {
      candidate: { sha: TIP2, baseSha: BASE2, pr: 102, branch: 'graphyard/gy-102-1', author: 'worker' },
      checks: [{ name: 'test', result: 'success', appId: 1 }],
      reviews: [{ reviewer: 'reviewer[bot]', sha: HEAD2, state: 'APPROVED', id: 101, submittedAt: at }],
      merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/feature.ts'], scopeFiles: [], at,
      prState: 'open', draft: false, baseTip: BASE2, baseTree: sha40('t2'), baseTipContained: true,
    },
  });

  const ejection = ejectionReason(refreshed, [1], [refreshed]);
  assert.equal(ejection, null, 'refreshed entry has no ejection reason');

  const verdict = evaluateLandability(refreshed, [refreshed], new Date());
  assert.equal(verdict.verdict, 'landable', 'refreshed entry evaluates as landable at its turn');
});

test('unit:landability-holds-conflicting-entry — landability never presents test-merge-conflicted entry as landable head', async () => {
  const conflicted = makeItem('GY-102', HEAD2, 1, {
    reworkRequested: true,
    baseRefresh: {
      from: { sha: HEAD2, baseSha: BASE1 },
      base: BASE2,
      policyRevision: 1,
      conflict: `Candidate ${HEAD2.slice(0, 12)} cannot be brought onto base branch tip ${BASE2.slice(0, 12)} without resolving a conflict`,
      at, head: null, merge: null, carry: null, trigger: 'conflict confirmed'
    } as any,
    observation: {
      ...makeItem('GY-102', HEAD2, 1).observation!,
      baseTip: BASE2,
    },
  });

  const verdict = evaluateLandability(conflicted, [conflicted], new Date());
  assert.equal(verdict.verdict, 'refused', 'test-merge-conflicted entry is refused');
  if (verdict.verdict === 'refused') {
    assert.ok(verdict.reasons.some(r => r.gate === 'build' && r.reason.includes('cannot be brought onto base branch tip')),
      'refusal explicitly names the base conflict');
  }
});
