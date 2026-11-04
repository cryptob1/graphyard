<!-- page: Understand or contribute | 2 | frozen exact-root benchmark and run receipts. -->
# Certified real-root benchmark

Implementation status: source work resumed in GY-3051 epoch 4. Build and focused
checks are available below; ordinary private-root delivery verification remains
required before submission. No actual-agent success is claimed.

The versioned starter is `benchmarks/hard-math/seed/`. Its `CONTRACT.md` freezes
exact JSON-lines CLI, batch HTTP and browser interfaces. The eight component
items cover contracts, arithmetic, square-free factorization, isolation, CLI,
API, browser and integration. Arithmetic, contracts and browser are initially
independent so three Graphyard-assigned implementation sessions can overlap.
The starter solver deliberately returns no roots and the starter browser reports
NOT_IMPLEMENTED. They are negative baselines, not a reference implementation.

`profiles/frozen-v1.json` pins the generator, contract, profile and oracle digests.
The first pre-evaluation calibration candidate (dense degree 32 with 224-bit
coefficients) exceeded the 120-second SymPy bound; its failure is preserved in
`profiles/calibration-failed-1.json` and its generator in commit 60307e97c.
The second and final candidate completed the exact oracle calibration in
3,696 ms across seeds 1, 2 and 3, eight polynomials each. It keeps degree 32,
a separate 251-bit coefficient case, eight clustered rational roots separated
by 2^-24, repeated irrational roots, no-real-root inputs and zero roots. The
chosen dense degree-32 polynomial uses 24-bit coefficients. This measures oracle
feasibility only. No evaluated profile was relaxed and no agent performance or
collaboration advantage has been measured. Do not recalibrate this frozen v1.

The external verifier requires SymPy 1.14.0 and mpmath 1.3.0. A supervising
producer provisions those dependencies outside implementation worktrees and
freezes `oracle/verify.py` plus `oracle/requirements.txt`. Workers receive the
contract, not producer credentials or writable oracle mounts. `HARD_MATH_PYTHON`
names the interpreter explicitly. The trial Dockerfile installs committed pinned
requirements into `/opt/graphyard-hard-math-oracle` using python3-venv, removes
write permission from the environment, and sets
`HARD_MATH_PYTHON=/opt/graphyard-hard-math-oracle/bin/python`. This is also the test
default. Nested private-root trials bind that environment read-only. There is no host HOME mount or implicit host fallback. The producer's
oracle source is frozen separately outside the implementation repository; its
source directory and Python environment are masked from implementation sessions.
For host-only focused checks, explicitly select an already provisioned pinned
interpreter. Rebuild the trial image from the final synced head before running
ordinary private-root tests; preserve the delivered runner base/Git/ripgrep and
installed-browser fixes when syncing.

Run deterministic runner checks with:

```sh
npm run build
HARD_MATH_PYTHON=/opt/graphyard-hard-math-oracle/bin/python npm test -- tests/hard-math-smoke.test.ts tests/hard-math-lifecycle.test.ts
```

The E2E binding is `e2e:hard-math-smoke`. It invokes the same head's tests, which
start real scratch Postgres/control plane and a local bare Git remote. Controlled
executors supply lookup artifacts, make actual claims and commits, post fixture
review/proof records and exercise the existing merge writer. Their receipts are
always `controlled-fixture`; they cannot establish an actual-agent rebuild,
model quality, paid usage or collaboration advantage. Negative tests are intended
to reject a missing delivery and a wrong artifact, and to exercise a failed
external certification followed by one repair through existing gates.

The proposed real command is:

```sh
node --import tsx benchmarks/hard-math/runner.ts post-deploy /path/to/run.json
```

`run` selects an explicit team or single mode; `compare` is a separate explicit
invocation. Both conditions inherit the same existing authorized aggregate
agent-seconds cap and wall deadline. An unavailable monetary meter or dollar cap
is null with a reason; it does not prevent this authorized comparison, and
monetary parity, compliance and advantage remain unproven. Nothing in
ordinary checks automatically starts paid comparison runs. Configuration records
an existing authorized budget, eligible model names, source installation,
profile/seed, deadline, isolated run directory, producer oracle directory and
installation credential directory under `~/.config/graphyard/<install>/`.
Credentials are local files with mode 0600. Run directories and failed receipts
are retained; a run never overwrites an earlier directory. The real command
requires matching healthy source CLI/server and delivered GY-3044, GY-3045,
GY-3046, GY-3047, GY-3050 and GY-3048. These live prerequisites do not apply to
controlled fixtures. The first real post-deploy team run and measured single/team
comparison remain outstanding.

Source capacity must be quiescent throughout a bounded real run. Copied role
concurrency or account maxSessions is not shared capacity. The current precondition
requires an absent source loop and no live sessions on eligible source accounts;
source capacity facts are retained in receipts and checked again during polling.
The source-capacity policy has deterministic checks; its live installation
observations remain part of the actual-run receipt. No new account,
purchase, credential for a person or increase in account limits is authorized.
Unknown usage is null with a reason; cost compliance and advantage stay unproven.
One fixed seed cannot establish repeatable superiority or parallel speedup.

## Epoch 4 verification handoff

The assigned worktree is synchronized with delivered main
`2982438bc640f9c2edae3c93eff0f65dd88c48aa`. The trial stage retains trixie,
Git >=2.43, ripgrep, immutable installed Chromium, locale normalization,
linked-dependency handling and durable scratch. The oracle addition installs
python3-venv and the committed pinned requirements on top of that image; nested
trials expose the environment read-only. Build, five lifecycle/comparison tests,
focused seed 1/2/3 oracle/routing checks and documentation checks pass after sync.
Full scratch integration and container checks await the declared candidate image;
no full fixture or actual-agent outcome is assumed.

The epoch 2/3 failure at the initial scratch Git push was an inherited Landlock
REFER restriction (`Invalid cross-device link` during quarantine object migration).
The operator has recovered its scoped repair and will verify this head in a real
private-root container without ancestor Landlock. The worker has no Docker
socket; neither fact blocks source editing. The known failing push was not
repeated as a prerequisite. Full ordinary delivery tests remain mandatory and the
lease stays held for those checks; do not complete until they pass.

Cleanup now closes run-owned master and item panes, cancels this installation's
headless producer runs, finishes handles, releases worker leases through the
existing epoch-bound capacity mutation, and ends registry allocations before
stopping scratch Postgres/control plane. A failed runtime stop retains its lease
and fails cleanup. Receipts retain cleanup errors, raw registry allocations,
work/repair/merge records, review/producer ledgers and coordinator state. The
watchdog checks aggregate allocation seconds independently of coordination and
artifact latency, aborts child process groups, and starts cleanup at the deadline
or usage bound. Monetary and token usage remain unknown unless an explicit
producer meter supplies them. Allocation time includes master, workers, reviews,
proofs and repairs; it is not a token or money estimate.

Three-worker overlap is recomputed from implementation handle timestamps and
requires distinct principals, items, branches and worktree paths. Intervals end
no later than the authoritative attempt end, so a submitted worker waiting for
pane cleanup cannot manufacture overlap. Registry
selection time alone cannot establish overlap. A single comparison uses one
implementation principal with delegation forbidden, under the same frozen
initial repository, contracts, eligible models, independent checks and bounds.
The independent reviewers/producers and master count in both conditions.

Focused checks cover oracle rejection across seeds 1/2/3, routing, source capacity,
run-scoped cleanup, refusal to free a running worker's lease, cancellation of child
process groups and real implementation overlap. The scratch delivery suite also
covers early failure and aggregate-limit cleanup with actual control-plane
leases. Controlled fixtures remain controlled fixtures. Actual team rebuild and
explicit fair comparison are authorized on existing accounts and run after
ordinary verification and delivery, retaining honest success or failure receipts.
No purchase, raised limit or invented dollar authorization is involved.
