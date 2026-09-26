// Concern: base failures (GY-528) — a required check that fails on the base branch as well as on
// the candidate. Such a failure is not the candidate's to fix: requesting rework for it spent one
// approver session per blocked item (2026-09-26: nine items, each refused as "a date time-bomb
// unrelated to" the item) and nothing raised the fault against the base. This module holds the
// pure half: reading failing test names from a CI log, comparing the candidate's with the base
// head's, and the attention and P0 item a base failure raises. The loop's step is
// src/daemon/cycle-base-failures.ts.
import { createHash } from 'node:crypto';
import type { Work } from './work.js';

/** The conclusions a required check has failed with; the latest attempt of each check decides. */
export const failedCheckResults: readonly string[] = ['failure', 'timed_out', 'action_required', 'cancelled'];
type Check = NonNullable<Work['observation']>['checks'][number];
const latestAttempt = (runs: Check[]) => runs.length ? runs.reduce((newest, check) => (check.attempt ?? 0) >= (newest.attempt ?? 0) ? check : newest) : null;
/**
 * The required checks that failed on exactly the current head, each with its latest run. The same
 * judgement `failedCheckRework` makes: an open submitted candidate observed at its own head, not
 * merged or closed, and the latest attempt of the check failed.
 */
export function failedRequiredChecks(work: Work): { name: string; check: Check }[] {
  const candidate = work.candidate, observation = work.observation;
  if (!work.submission || work.reworkRequested || !candidate || !observation || work.stage === 'done') return [];
  if (observation.candidate.sha !== candidate.sha || observation.merged || observation.prState === 'closed') return [];
  return work.policy.checks.flatMap(name => {
    const latest = latestAttempt(observation.checks.filter(check => check.name === name));
    return latest && failedCheckResults.includes(latest.result) ? [{ name, check: latest }] : [];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// A GitHub Actions log line starts with its timestamp; a terminal log may carry colour codes.
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
// eslint-disable-next-line no-control-regex
const ansi = /\u001b\[[0-9;]*m/g;
/**
 * The failing test names a Node test-runner log reports, in either of its reporters: the spec
 * reporter's `✖ name (12.3ms)` and TAP's `not ok 3 - name`. A suite that failed because a test in
 * it did is listed too, as the runner lists it; both sides of a comparison are read the same way,
 * so that is no difference between them. TODO and SKIP entries are not failures.
 */
export function parseFailedTests(log: string): string[] {
  const names = new Set<string>();
  for (const raw of log.split('\n')) {
    const line = raw.replace(timestamp, '').replace(ansi, '').trimEnd();
    const spec = /^\s*✖ (.+?) \(\d+(?:\.\d+)?m?s\)(?:\s+#.*)?$/.exec(line);
    const tap = /^\s*not ok \d+ - (.+?)(\s+#\s+(?:TODO|SKIP)\b.*)?$/i.exec(line);
    const name = spec?.[1] ?? (tap && !tap[2] ? tap[1] : null);
    if (name && name.length <= 500) names.add(name.trim());
  }
  return [...names].sort();
}

/**
 * The latest completed run of one check on the base branch head, as the loop read it from GitHub
 * outside any coordination transaction. `pending` while the head's run of the check has not
 * completed, `none` when the head has no run of it (or one that neither passed nor failed).
 */
export interface BaseCheck {
  check: string; baseSha: string; state: 'passed' | 'failed' | 'pending' | 'none';
  jobId: number | null; url: string | null;
  /** The failing test names of a failed run, or null when its log could not be read. */
  tests: string[] | null;
}
/** How one failed required check of a candidate is judged against the base head. */
export type CheckJudgement =
  /** Every test failing on the candidate fails on the base head too: nothing of the candidate's to fix. */
  | { kind: 'base'; tests: string[] }
  /** The base head's run of the check is still going: the comparison waits for it. */
  | { kind: 'pending' }
  /** A failure of the candidate's own, or one that cannot be compared: rework, as before GY-528. */
  | { kind: 'own'; tests: string[] | null };
/**
 * Compare the failing tests of a candidate's check with the base head's latest completed run of the
 * same check. A failure present on the base too is a base failure; one only the candidate has, or
 * a failure whose tests cannot be read on either side, is the candidate's own.
 */
export function judgeFailedCheck(candidateTests: string[] | null, base: BaseCheck | null | undefined): CheckJudgement {
  if (base?.state === 'pending') return { kind: 'pending' };
  if (!base || base.state !== 'failed' || !candidateTests?.length || !base.tests?.length) return { kind: 'own', tests: candidateTests };
  const onBase = new Set(base.tests);
  const own = candidateTests.filter(test => !onBase.has(test));
  return own.length ? { kind: 'own', tests: own } : { kind: 'base', tests: candidateTests };
}

/** One candidate a base failure blocks: its item, the head the check failed on, and the failed job. */
export interface BlockedCandidate { key: string; id: string; sha: string; jobId: number | null; url: string | null }
/** A standing base failure, one per failing test and base head: what the loop raised and what it did once the base passed. */
export interface BaseFailure {
  test: string; check: string; baseSha: string; jobId: number | null; url: string | null; raisedAt: string;
  blocks: BlockedCandidate[];
  /** The P0 item filed for it, by key; one item per test however many base heads it is seen on. */
  item: string | null;
  /** When the base head's run of the check passed again, and on which commit. */
  cleared: { at: string; baseSha: string; jobId: number | null } | null;
}
/** The record key of a base failure: deduplicated by test name and base head. */
export const baseFailureKey = (test: string, baseSha: string) => `${baseSha.slice(0, 40)}:${createHash('sha256').update(test).digest('hex').slice(0, 16)}`;
export const short = (sha: string) => sha.slice(0, 12);
export const runOf = (failure: Pick<BaseFailure, 'jobId' | 'url'>) => failure.url ?? (failure.jobId !== null ? `job ${failure.jobId}` : 'an unnamed run');

/**
 * The P0 item a base failure files, as the master's operator-agent identity: the test, the base
 * commit, the CI run and the candidates it blocks. Repairing the base is the one change that frees
 * them, so it goes to the front of the queue.
 */
export function baseFailureItem(failure: BaseFailure, baseBranch: string) {
  const blocked = failure.blocks.map(block => `${block.key} (${short(block.sha)})`);
  return {
    title: `Base branch ${baseBranch} fails ${failure.check} test: ${failure.test}`.slice(0, 200),
    type: 'bug' as const, priority: 0,
    description: [
      `The master loop filed this item itself (GY-528): the required ${failure.check} check fails the test "${failure.test}" on the head of ${baseBranch}, commit ${failure.baseSha}, in CI run ${runOf(failure)}.`,
      `The same test fails on every candidate listed below, so it is no candidate's to fix and the loop requests no rework for it: each stays held until ${baseBranch} passes again. Blocked candidates: ${blocked.join(', ') || 'none yet'}.`,
      `Once the ${failure.check} check passes on ${baseBranch} again the loop clears the attention, reruns each blocked candidate's failed job and refreshes each onto the repaired base.`,
    ].join('\n\n').slice(0, 20000),
    criteria: [{ id: 'AC-1', text: `The test "${failure.test}" passes on ${baseBranch} again, fixed at its cause rather than skipped or weakened, and a test the change adds reproduces the failure against ${short(failure.baseSha)}`.slice(0, 2000), proofs: ['manual:base-failure-repaired'] }],
    reason: `The ${failure.check} check fails "${failure.test}" on ${baseBranch} head ${short(failure.baseSha)} and on ${failure.blocks.length} candidate(s) it blocks`.slice(0, 2000),
  };
}
