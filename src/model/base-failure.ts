

// A CI log line may start with its timestamp; a terminal log may carry colour codes.
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
      `No user-facing change: the master loop filed this control-plane repair itself (GY-528); the required ${failure.check} check fails the test "${failure.test}" on the head of ${baseBranch}, commit ${failure.baseSha}, in CI run ${runOf(failure)}.`,
      `The same test fails on every candidate listed below, so it is no candidate's to fix and the loop requests no rework for it: each stays held until ${baseBranch} passes again. Blocked candidates: ${blocked.join(', ') || 'none yet'}.`,
      `Once the ${failure.check} check passes on ${baseBranch} again the loop clears the attention, reruns each blocked candidate's failed job and refreshes each onto the repaired base.`,
    ].join('\n\n').slice(0, 20000),
    criteria: [{ id: 'AC-1', text: `The test "${failure.test}" passes on ${baseBranch} again, fixed at its cause rather than skipped or weakened, and a test the change adds reproduces the failure against ${short(failure.baseSha)}`.slice(0, 2000), proofs: ['manual:base-failure-repaired'] }],
    reason: `The ${failure.check} check fails "${failure.test}" on ${baseBranch} head ${short(failure.baseSha)} and on ${failure.blocks.length} candidate(s) it blocks`.slice(0, 2000),
  };
}
