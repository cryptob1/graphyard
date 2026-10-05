import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedCheckRework } from '../src/daemon/decisions.js';
import { batchStep, classifyRerunRun, ejectingCheck, latestCheck, reconcileCheckReruns } from '../src/merge-queue.js';
import { attributeDocsOverflow, docsBudgetProof, ownDocsOverflow, type DocsWordBudget, type DocsWordCount, type TipDocs } from '../src/model/documentation.js';
import type { Observation, Work } from '../src/model.js';

// GY-1109: GY-967 (PR #513, head 5c54592412a8 on base 7ef4cb702d65) was ejected from the merge queue
// with "Required CI check test did not pass ..., again after one rerun of its failed jobs:
// unit:docs-word-budget failed ... 15643 words, 3643 over the 12000-word budget; pages that grew:
// none". Its failed test run 110730635605 was rerun as workflow run 36972672738, whose attempt 2
// passed; the "failed rerun" recorded was check run 110739678221 of workflow run 36975811723, which
// GitHub cancelled for a higher-priority waiting request, and the 15643 words were the base's own.
// Each test is named for the proof it produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);

type Check = Observation['checks'][number];
const run = (name: string, id: number, result: string): Check => ({ name, result, appId: 15368, id });
/** GY-967's candidate as the control plane records it: approved, submitted, observed with `checks` on its head. */
function candidate(head: string, base: string, checks: Check[]): Work {
  const at = new Date().toISOString(), branch = 'graphyard/gy-967-1', current = { sha: head, baseSha: base, pr: 513, branch, author: 'implementer' };
  return { id: 'gy-967', key: 'GY-967', title: 'Cancelled rerun', description: '', type: 'bug', priority: 0, dependencies: [], criteria: [], plannedFiles: ['src/attribution.ts'],
    policy: { checks: ['test', 'typecheck'], review: true }, stage: 'test', revision: 4, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'machine-a', path: '/tmp/attribution', branch, epoch: 1, owner: 'agent-a' }], candidate: current, submission: { epoch: 1, pr: 513 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], checkReruns: [],
    observation: { clockOffset: { min: 0, max: 0 }, candidate: current, checks, reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED' }],
      protected: true, mergeable: true, merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: base, baseTipContained: true, files: ['src/attribution.ts'], scopeFiles: [], at } } as unknown as Work;
}

// GY-967's run sequence on its tip: test run 110730635605 failed; GitHub's attempt 2 of workflow run
// 36972672738 passed; check run 110739678221 of workflow run 36975811723 was cancelled by GitHub
// ("Canceling since a higher priority waiting request for CI-513 exists") and is the newest by id.
const failedTest = run('test', 110730635605, 'failure');
const cancelledTest = run('test', 110739678221, 'cancelled');
const passedAttempt = run('test', 110739500001, 'success');
const typecheck = run('typecheck', 110730635606, 'success');

test('unit:cancelled-rerun-not-failure — GY-967\'s run 36975811723, cancelled by GitHub, is never recorded as a failed rerun nor ejects or asks for rework; the check is re-read, and the rerun attempt that passed decides', () => {
  const main = sha40('7ef4cb702d65'), head = sha40('5c54592412a8');
  assert.equal(latestCheck([failedTest, cancelledTest])?.id, 110730635605, 'a cancelled run never supersedes one that was not cancelled');
  assert.equal(latestCheck([failedTest, passedAttempt, cancelledTest])?.id, 110739500001, 'the rerun attempt that passed decides the check');

  // A check whose only run GitHub cancelled is owed a rerun on its own allowance, never a failure;
  // a rerun attempt GitHub cancels is requested again instead of failing.
  const onlyCancelled = candidate(head, main, [cancelledTest, typecheck]);
  assert.equal(ejectingCheck(onlyCancelled, [15368]), null);
  assert.equal(failedCheckRework(onlyCancelled), null);
  const owed = reconcileCheckReruns(onlyCancelled, [15368], 1, new Date());
  assert.deepEqual(owed.reruns.map(entry => [entry.failedRunId, entry.state, entry.cancelled]), [[110739678221, 'owed', true]]);
  const spent = { ...onlyCancelled, checkReruns: [{ sha: head, check: 'test', failedRunId: 1, state: 'failed' as const, at: new Date().toISOString() }] } as Work;
  assert.equal(reconcileCheckReruns(spent, [15368], 1, new Date()).reruns.at(-1)!.failedRunId, 110739678221, 'a spent failure allowance does not stop the rerun of a cancelled run');
  assert.deepEqual(classifyRerunRun({ attempt: 1 }, { status: 'completed', conclusion: 'cancelled', attempt: 2 }), { kind: 'cancelled', attempt: 2 }, 'a cancelled attempt is classified as cancelled');
  assert.deepEqual(classifyRerunRun({ attempt: 1 }, { status: 'completed', conclusion: 'failure', attempt: 2 }), { kind: 'failed', conclusion: 'failure' }, 'a failed attempt still fails');
});

// GY-967's base 7ef4cb702d65 already carried 15643 budgeted words; its head grew no page.
const budget: DocsWordBudget = { total: 12_000, perPage: 1_200, paths: ['docs/', 'README.md'], documentation: ['docs/', 'README.md', 'AGENTS.md'] };
const inherited: DocsWordCount = Object.fromEntries([...Array.from({ length: 13 }, (_, index) => [`docs/page-${index}.md`, 1_100]), ['README.md', 1_343]]);
const totalOf = (count: DocsWordCount) => Object.values(count).reduce((sum, words) => sum + words, 0);

test('unit:inherited-docs-total-not-attributed — a docs total the base already carries and the candidate did not grow (GY-967: 15643 words on base 7ef4cb702d65, pages that grew: none) is never named in an ejection or rework reason', () => {
  assert.equal(totalOf(inherited), 15_643);
  const tipDocs = (head: string, pages: DocsWordCount): TipDocs => ({ sha: head, base: inherited, pages, onlyFailure: true, budget });
  // The attribution names nobody for an inherited total, and still names an entry whose change grew a page.
  assert.equal(attributeDocsOverflow(inherited, [{ key: 'GY-967', count: inherited }], budget), null);
  assert.equal(ownDocsOverflow(tipDocs('x', inherited)), false);
  const grown = { ...inherited, 'docs/page-0.md': 1_150 };
  assert.equal(attributeDocsOverflow(inherited, [{ key: 'GY-967', count: grown }], budget)?.member, 'GY-967', 'a page grown over an already-over total is still the entry\'s');
  assert.equal(ownDocsOverflow(tipDocs('x', grown)), true);
  const step = batchStep(['GY-967'], () => ({ result: 'fail', check: docsBudgetProof }), { result: 'pass' }, { base: inherited, count: () => inherited, budget });
  assert.ok(!('reason' in step) || !(step as { reason?: string }).reason, 'the batch plan attributes no docs reason');
});
