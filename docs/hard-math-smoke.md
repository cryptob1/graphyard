<!-- page: Understand or contribute | 2 | frozen exact-root benchmark and run receipts. -->
# Certified real-root benchmark

This benchmark measures Graphyard delivery of an exact-root workbench in a fresh
repository: solver, JSON-lines CLI, batch HTTP API and browser UI. The starter in
`benchmarks/hard-math/seed/` deliberately returns incorrect results. A successful
controlled test proves the delivery harness works; only a retained `real-agent`
receipt can establish an actual coding-agent rebuild. Neither establishes a
repeatable team advantage by itself.

The [frozen contract](../benchmarks/hard-math/seed/CONTRACT.md) requires every real
root of a nonzero integer polynomial, with reduced rational isolating intervals,
exact multiplicities and width at most 2^-precisionBits. Ordinary arithmetic
libraries are allowed; wrapping a CAS root solver is outside the goal. CLI, API
and browser must agree. The independent SymPy oracle checks completeness as well
as each interval and multiplicity. Browser certification compares the complete
rendered root records in order, including both exact endpoints and each associated
multiplicity; missing, extra or stale records fail, including for no real roots.

`benchmarks/hard-math/profiles/frozen-v1.json` pins the profile, generator,
contract and oracle digests. Seeds 1, 2 and 3 cover dense degree-32 polynomials,
large coefficients, tightly clustered and repeated roots, no real roots and zero
as a root, at 64-bit interval precision. The profile permits degree at most 32,
256-bit coefficients and 24 polynomials per seed. Do not recalibrate or relax
these frozen inputs after observing a result.

## Native setup and checks

The trial Dockerfile provisions pinned SymPy 1.14.0 and mpmath 1.3.0 in
`/opt/graphyard-hard-math-oracle`. Use the candidate's ordinary private-root trial
image with installed Chromium. The oracle environment is read-only in nested
trials; no host HOME or implicit Python fallback is used. For focused host
checks, explicitly select an already provisioned pinned interpreter.

```sh
npm run build
npm run docs:check
HARD_MATH_PYTHON=/opt/graphyard-hard-math-oracle/bin/python npm test -- tests/hard-math-smoke.test.ts tests/hard-math-lifecycle.test.ts
```

The bound case `e2e:hard-math-smoke` runs the same head's smoke file. It starts real
scratch Postgres, a control plane and a local Git remote, then uses controlled
executors to exercise claims, independent review/proof records, pushed merges,
injected failure/repair, cleanup and external CLI/API/browser certification.
The focused `tests/hard-math-process.test.ts` regression also creates a real Git
conflict through the real daemon's bounded process adapter and checks native
refusal, conflicting paths and rework without retrying the refused head. Process
errors preserve exit status, signal, timeout and captured stdout/stderr.
The small `tests/hard-math-display.test.ts` Chromium diagnostic exercises the
same rendered-text verifier with correct layouts and deliberately swapped
endpoints/multiplicities, extra roots and fraction digits posing as multiplicity.
Run it in the native image alongside the ordinary smoke checks.
Fixtures use finite lookup artifacts, never an implementation solver. Missing
delivery, incorrect artifacts and zero-count proofs must fail. The seed test
command emits TAP so canonical trials observe positive execution counts.

## Run with existing accounts

Run from the delivered Graphyard checkout using its matching healthy source
CLI/server and configured accounts. GY-3044, GY-3045, GY-3046, GY-3047, GY-3050
and the run-only docs prerequisite GY-3048 must be delivered. Shared trial failures
must be resolved: base failures use the folded refusal reason, while host failures,
timeouts and cancellations use the latest actual `merge.trial` event; these
no-verdict events have no folded trial. A later verdict/reconciled delivery clears
historical failures. An outstanding source flight also refuses launch. Keep the source loop stopped and eligible source accounts free
of live sessions throughout the run; copied account limits are not shared capacity.

Create a config using existing authorized limits and actual configured model names.
This example shows the one-hour, 21,600 aggregate allocation-second envelope;
it does not grant a new budget or account limit:

```json
{
  "id": "roots-v1-seed1",
  "mode": "team",
  "profileVersion": "v1",
  "seed": 1,
  "wallClockSeconds": 3600,
  "budget": {
    "authorization": "Reference to existing run authorization",
    "maxAgentSeconds": 21600,
    "maxTokens": null,
    "maxCost": null,
    "currency": "USD",
    "priceSource": {
      "url": null,
      "date": null,
      "reason": "Subscription allocation unavailable"
    }
  },
  "eligibleModels": ["existing-configured-model"],
  "sourceRoot": "/absolute/path/to/source-repository",
  "oraclePython": "/opt/graphyard-hard-math-oracle/bin/python",
  "oracleDirectory": "/absolute/path/to/new-producer-oracle",
  "runDirectory": "/absolute/path/to/new-run",
  "credentialDirectory": "/home/USER/.config/graphyard/roots-v1-seed1"
}
```

```sh
node --import tsx benchmarks/hard-math/runner.ts post-deploy /path/to/run.json
node --import tsx benchmarks/hard-math/runner.ts run /path/to/run.json
node --import tsx benchmarks/hard-math/runner.ts estimate /path/to/run.json
node --import tsx benchmarks/hard-math/runner.ts compare /path/to/run.json
```

`post-deploy` requires team mode. `run` uses the configured team or single mode.
`estimate` is read-only: it returns the shared per-condition authorization,
aggregate cap in allocation-seconds, wall deadline, optional token/USD caps and a
separate financial estimate with price source or explicit unavailable reason.
It never creates run paths or launches sessions. `compare` checks this preflight
before either condition launches and retains it in the comparison result.
The existing authorization is 21,600 aggregate allocation-seconds and 3,600 wall
seconds per condition on existing accounts. Registry intervals measure allocation
seconds across every role; these seconds are a usage bound, never USD. Missing
or unavailable authorized aggregate bounds refuse launch. Null token/USD caps
permit this authorized allocation-budget comparison; monetary parity remains
unproven. Configured token/USD caps require a `usageCommand` measurement adapter.
`compare` runs both conditions sequentially, retaining separate
`-team` and `-single` directories and a `-comparison.json` result. Ordinary checks
never launch paid runs. Use fresh paths; existing run directories are never
overwritten. Installation credentials have mode 0600 under
`~/.config/graphyard/<install>/`; workers receive neither producer credentials nor
writable oracle mounts. No new accounts, purchases or increased limits are authorized.

## Read the result

Each run retains `config.json`, `receipt.json`, runtime logs, worktrees and failed
attempts. `PASS` requires authoritative delivered work and pushed commit bindings,
independent approvals, positive mechanical proof counts, final candidate
certification, verified CLI/API/UI from the final merge, and successful cleanup.
A loop cycle or worker self-report cannot pass. Deadline, aggregate usage limit,
unrecoverable gate failure or exhausted repair allowance ends the run with
`FAIL`; at most two repairs per component are allowed. Cleanup stops run-owned
sessions and releases their epoch-bound leases; failure to stop a runtime fails
cleanup and retains its lease.

Team mode creates eight dependent component items. Its receipt requires three
distinct implementation principals, items, branches and worktrees with actual
runtime overlap. Real overlap begins at `session.runtimeStartedAt`; preparation
or registry allocation alone does not count. Intervals end no later than the
attempt end. Controlled receipts retain explicitly synthetic handle intervals.
Allocation time still counts toward budgets, including master, implementation,
review, proof and repair overhead.

Single mode uses one implementation principal with delegation forbidden. A fair
comparison requires identical starting repository, frozen inputs, seed, eligible
models, deadline and authorized aggregate budget, with independent acceptance
checks in both conditions. Report failures honestly. One seed cannot prove a
repeatable advantage; do not infer parallel speedup without a comparable serial
measurement. A single eligible runtime/model leaves comparative selection untested.

Unknown tokens or monetary usage remain null with a reason, never zero. Optional
`usageCommand` is an argv array: it reads `{sessions,runDirectory}` JSON on stdin
and returns usage entries with role, session, inputTokens, outputTokens, cost and
reason. Without complete measured usage and an applicable cost cap, monetary
parity, monetary budget compliance and cost advantage remain unproven. Known
partial token/cost lower bounds still stop the run at configured caps with terminal
`FAIL`, even when missing usage keeps totals null. Allocation seconds
are not a monetary estimate.

## Evidence and history

Controlled fixtures passed the native private-root harness at preserved head
`4f516018cbcb627b47163c6a9d31f4c15b087589` (20 tests, zero failures or skips).
Later native ordinary checks also passed the runtime-overlap correction. These
results do not certify a mathematical solver built by AI: consult the actual
run's receipt kind, outcome and artifact binding for that claim. Each new head
still owes its own ordinary, independent-review and canonical/bound E2E gates.

Earlier failure diagnostics remain in Git history and retained run directories.
The rejected calibration is preserved in
`benchmarks/hard-math/profiles/calibration-failed-1.json` (generator commit
`60307e97c`); the final calibration measured oracle feasibility only. Preserve
those artifacts and failed receipts when investigating or comparing later runs.

## Response to review 3113523

The enforcement rework addresses the three blocking findings without changing
criteria, frozen mathematics or the delivery harness:

- AC-8: `runner.ts` reads full authoritative work documents, the latest raw trial
  event and the persisted source flight. `enforcement.ts` checks actual base
  refusal reasons and no-verdict outcomes. Enforcement tests exercise real ledger
  folds, failed and resolved records, and the prerequisite's HTTP/cursor reads.
- AC-3/AC-11: runtime enforcement and PASS validation use known token/USD lower
  bounds independently of total completeness. Tests exceed each cap with another
  role's usage unknown, reject PASS and retain FAIL with null money and reasons.
- AC-6/AC-7/AC-11: read-only `estimate` exposes the identical authorized caps and
  unavailable financial estimate before launch. Tests retain the authorized
  allocation-second comparison, reject absent aggregate bounds and unsupported
  configured monetary/token caps, and verify estimate creates no run paths.

These changes request fresh independent judgement; they do not supply a review
verdict or waive technical, product, full-suite, bound E2E or actual-run obligations.
