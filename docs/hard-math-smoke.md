# Certified real-root benchmark

Implementation status: **in progress, not certified**. GY-3051 epoch 2 has not
completed the delivery integration tests. Do not use this head to launch a paid
real-agent benchmark until independent review and the checks below pass.

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
names that pinned Python for deterministic tests; this development machine's
preprovisioned recovery environment is the current local fallback. A portable
producer environment still needs that explicit setting.

Run deterministic runner checks with:

```sh
npm run build
HARD_MATH_PYTHON=/path/to/pinned/bin/python npm test -- tests/hard-math-smoke.test.ts
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
invocation and refuses a missing existing cost cap or usage meter. Nothing in
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
This check needs integration verification before real use. No new account,
purchase, credential for a person or increase in account limits is authorized.
Unknown usage is null with a reason; cost compliance and advantage stay unproven.
One fixed seed cannot establish repeatable superiority or parallel speedup.

## Epoch 2 handoff

The oracle/family and routing tests pass locally. Full scratch delivery currently
fails at the initial local Git push: migrating quarantined received objects returns
`Invalid cross-device link`, both under /tmp and under the assigned worktree.
Changing core.createObject did not resolve it and was removed. No gate was replaced
with a mocked trace, no test was skipped, and no real-agent run was attempted.

Before completion, finish and verify run-owned session/lease cleanup on success
and timeout (including the master and headless producers); improve deadline and
aggregate usage enforcement; bind overlap to actual implementation handles;
exercise source-capacity preconditions; and run the delivery tests in an ordinary
permitted environment. Review the receipt validation and real orchestration as
unfinished implementation, not shipped benchmark behavior. Then run Graphyard
self-review, address findings, commit and submit through complete. Do not submit
trusted evidence for GY-3051 from the implementation identity.
