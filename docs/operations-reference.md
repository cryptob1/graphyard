<!-- page: Operate Graphyard | 9 | procedures, limits. -->
# Operations reference

## Master coordination loop

`graphyard master run` restarts freely, never dispatching twice. `master status` (cached interventions) → `daemon`: health, `cycleTime` (30-minute p50/p95), `daemon.metrics.timings` (steps and calls over 1s); a cycle over 60 s raises `loop` attention naming the three slowest. `journalctl --user -u graphyard-master` logs failed requests' route and SQL. Launches run beside cycles (`run.launchConcurrency`, default 3).

### Perpetual master loop

`master verify-deployment GY-N` refuses a release *unobserved*, *stale* (rerun), not serving the merge, or *already recording deployment* (follow-up item).

## Lost worker before submission

A lease expires 120 s after the last heartbeat (one further lease period after a recorded server-side renewal fault); the next claim (higher epoch) keeps the worktree. An [unexplained lapse](protocol/leases.md#how-a-lease-ends) blocks merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

`graphyard master settle-containment GY-N "reason"` on the worker verifies nothing survives; only the loop excuses, and closes, the recorded pane's idle childless shell under `herdr server`. If refused, confirm the stop, then [`rework`](operations.md#recovery-recipes) (`recover-containment` once delivered).

## Submitted implementation needs rework

Stop the worker, then `graphyard rework GY-N --previous-worker-stopped "reason"`; the next worker resubmits. `scripts/rework-causes.mjs` classifies the last 100 deliveries' rework rounds by recorded reason (measured: 55% own-change, 33% conflicts; raw median 2, 0 excluding them); `master status` reports `speed.reworkRounds.ownChange`, the median excluding out-of-item causes.

## Retro synthesis

With `GRAPHYARD_INTERVENTION_PATTERNS=1`, each minute's pattern scan groups refusal and rework interventions by cause: a declared refusal shape (`build/out-of-scope-count`), a loop refusal trigger, or a normalised rework reason. A cause reaching the threshold in the window gets drafted artefacts (`retro.drafted`), never applied or filed as work: a standards or criteria wording update, a mechanical check, a producer-method correction, a fault-catalogue entry. An AI admin or operator agent holding `decision:approve` (not a human session, the drafter, or an instance's recorder) approves one, applying it at its registry's next revision (`requirements`, `checks`, `catalogue`) and recording the cause, fingerprint and instances it closes, or refuses it. In force: requirements show as `retroStanding` in `graphyard status GY-N`; a check (`planned-files`, `merges-onto-base`, `checks-passed`) runs on every submission's observed candidate, refusing `complete` (`409`); a catalogue entry files later instances under its fault class (`catalogue` on interventions, `retroCatalogued` on gate refusals) and counts recurrences against itself. Instances in any draft never count again; a recurrence after application is redrafted naming it (`recurredAfter`). Routes: [work commands](protocol/work-commands.md).

## Flaky CI check

A required check failing on a tip or head reruns once per sha (*rerun failed jobs* on the newest check-run ID of configured CI Apps), keeping position, approval and proofs, no rework meanwhile; a second failure or refusal ejects (`check.rerun.*`). An owed or accepted rerun expires after 15 minutes without a new run. It needs Actions:write (preflight diagnoses it; requests hold until accepted). `mergeQueue.rerunFailedChecks`: default 1, 0 disables, published like `batchSize`.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes the gate and ejects it from the queue.

## GitHub request budget

### The live budget

`x-ratelimit-remaining`/`-limit`/`-reset` project exhaustion (`projectedExhaustionAt`).

### Observation cadence by state

| Band | Cadence |
| --- | --- |
| `merge` | within two of the head, gates passing: 20 s |
| `active` | awaiting check, review, base refresh or rework: 1 min |
| `steady` | unchanged since observed: 5 min, stretched by the fleet bound |
| `idle` | next action dispatch or escalation: 5 min, stretched if unchanged |

Unchanged non-merge candidates spend **at most 40%** (`steadyStateShare`).

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations wait for the reset (`githubBudget.deferrals`). Budgets are per token (`githubBudget.tokens`); one projected below the reserve at reset raises `github`.

### What an observation costs

About ten requests uncached; none unchanged.

### What a pause means for gates

A rate-limit `403`/`429` pauses requests; gates read stale until it lifts: nothing merges on an observation over two minutes old.

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`.

### Webhook liveness

After an hour without deliveries `master status` points to `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Remedies per `resources` entry: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow the volume and `GRAPHYARD_DATABASE_MAX_BYTES`, the bound when set (else the data directory's volume size if readable: same host, role may read `data_directory`; else an advisory 10 GiB that only warns).

## Storage retention

Receipts answer retries for one day, pruned every 10 minutes, 5,000 rows a run. Routine ledger rows (`github.observed`, `heartbeat`, `reconciled`, `action.claimed`, `action.failed`, `github.queue`, `session`) store only the change, not the work document, unless they move stage or delivery. Every 10 minutes compaction deletes those older than `GRAPHYARD_LEDGER_RETENTION_DAYS` (default 14, minimum 1), five batches a run of at most 2,000 rows per phase, each appending `ledger.compacted` (counts per kind). Kept: other kinds, rows a delta extends, an item's newest save, delivery events, cited revisions, merged-not-done items' rows and rows the flow projection has not read. Only `VACUUM FULL` returns freed space to the volume.

## Bootstrap mode for a self-proving change

A `policy:bootstrap` holder adds `"bootstrap": {"reason": "…", "contractPaths": ["src/herdr/recovery.ts"]}` to the criterion; other gates apply, `e2e:` proofs are never deferred, and the next item touching those paths owes the proof (`graphyard obligations`).

## Delivered with a failed smoke proof

It stays Done, **delivered with failure**; revert via a new item, never backfill evidence.

## Merged but not deployed

An unserved merge is a [`delivery.deployment-incident`](deployment.md#production-deployment-observation) until served.

## Merge bypass

An ungated merge is a permanent violation: repair access, open a follow-up item, never backfill evidence. Admins open a direct-merge window with `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate `GRAPHYARD_PRINCIPALS` and redeploy. Operator agents (`graphyard operator-agent setup|list|rotate|revoke`) hold only listed capabilities.

## Proof authority grants

`graphyard grants` lists live authority; only an `admin` runs `graphyard grants grant|revoke PRINCIPAL "PROOFS" "reason"` (e.g. `grant ci "integration:*,unit:*" "CI proofs"`) for `producer` principals, by exact name, `kind:*` or prefix (`manual:gy-43/*`).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json` (`--apply` applies it); later scans and `doctor --profile through-merge|preview-validation|production-verification` report drift, never repairing.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (default 250) sizes reconcile batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (default 4, ≤ half pool) share one pace per token: budget above reserve, minus others' spend, paced to reset. Claims: head `max(2,batchSize,parallelTips)` band, in-flight merges, never-observed submissions, five-minute-due jobs, review/rework waits, running sessions (earlier if tight), `available_at`; tight, idle items await webhooks. `observationThroughput` reports budget, pace, head lag and oldest unobserved submission (`github` attention past two minutes). Heartbeat, claim, `complete` and `blocked` own the lease pool; `leaseHealth` (`GET /api/status`) reports heartbeat p50/p95 and failures (raised past 5 s).

### Concurrent reconciliation

A stale observation snapshot retries after two seconds.
