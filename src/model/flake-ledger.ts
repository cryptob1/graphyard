// Concern: the proof id a failing test's name leads with. GY-2086 retired the flake ledger and its
// "Flaky test" and "Advisory test" item filing; what survives is the proof-id reader the PR gate's
// rerun decision and the merge writer's trial judgement share.
/**
 * The proof id a test's name leads with (`unit:base-failure-no-rework — …`), or null. A `FILE › NAME` name is read from its NAME.
 * The id is read in the proof grammar's own alphabet (`proofSchema`), `/` included, so `unit:guard/retry` is never cut to `unit:guard`.
 */
export function leadingProof(test: string) {
  const name = test.includes(' › ') ? test.slice(test.lastIndexOf(' › ') + 3) : test;
  return /^((?:unit|integration):[a-zA-Z0-9._/-]+)/.exec(name.trim())?.[1] ?? null;
}
