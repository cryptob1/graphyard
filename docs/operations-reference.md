<!-- page: Operate Graphyard | 9 | recovery procedures and limits. -->
# Operations reference

## Master coordination loop

Restart `graphyard master run` freely; it never dispatches twice. `master status` (cached interventions) → `daemon`: health, `cycleTime` (30-minute p50/p95); log `journalctl --user -u graphyard-master`. `daemon.metrics.timings` time steps and calls over 1s; cycles over 60 s raise `loop` attention naming three slowest. Launches run beside cycles (`run.launchConcurrency`, default 3). Failed requests log route and SQL.

### Perpetual master loop

`master verify-deployment GY-N` refuses a release *unobserved*, *stale* (rerun), not serving the merge, or *already recording deployment* (follow-up item).

## Lost worker before submission

A lease expires 120 s after the last heartbeat, or one further lease period after a recorded renewal fault; the next claim keeps the worktree. An unexplained lapse raises `lease-loss` ([classification](protocol/leases.md#how-a-lease-ends)), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

`graphyard master settle-containment GY-N "reason"` verifies nothing survives; only the loop excuses an idle pane shell (childless, parent `herdr server`). If refused, confirm the stop, then `rework` or `recover-containment` once delivered ([recipes](operations.md#recovery-recipes)). Automatic settlement bounds the clock with a timed `HEAD /` (plane `Date` header), not the snapshot read, falling back on failure; a too-slow read is refused naming the round trip.

## Submitted implementation needs rework

Stop the worker, then `graphyard rework GY-N --previous-worker-stopped "reason"`; the next worker resubmits. `scripts/rework-causes.mjs` classifies the last 100 deliveries' rework rounds by recorded reason; `master status` reports the split (`speed.reworkRounds.ownChange`): median excluding out-of-item causes. GY-643 (2026-09-26) measured 55% own-change, 33% conflicts; raw median 2, 0 excluding them.

## Flaky CI check

A required check failing on a tip or head reruns once per sha (*rerun failed jobs*, Actions:write), holding position, approval, proofs, no rework; a second failure or refusal ejects (`check.rerun.*`). `mergeQueue.rerunFailedChecks`: default 1, 0 disables, published like `batchSize`.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes the gate; the queue ejects it.

## GitHub request budget

### The live budget

`x-ratelimit-remaining`/`-limit`/`-reset` project exhaustion (`projectedExhaustionAt`).

### Observation cadence by state

| Band | Cadence |
| --- | --- |
| `merge` | within two of the queue head, gates passing: 20 s |
| `active` | awaiting checks, review, base refresh or rework: 1 minute |
| `steady` | unchanged: 5 minutes, fleet-stretched |
| `idle` | dispatch or escalation: 5 minutes, stretched when unchanged |

Unchanged non-merge candidates spend **at most 40%** (`steadyStateShare`).

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations wait out the reset (`githubBudget.deferrals`).

Budgets are per token (`githubBudget.tokens`); one projected below reserve at reset raises `github`.

### What an observation costs

About ten requests uncached; unchanged, none.

### What a pause means for gates

`403`/`429` pauses requests; gates read stale until it lifts: nothing merges on >2-minute-old observations.

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`.

### Webhook liveness

After an hour without deliveries `master status` points to `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Per `resources` entry: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow the volume and `GRAPHYARD_DATABASE_MAX_BYTES`.

## Bootstrap mode for a self-proving change

A `policy:bootstrap` holder adds `"bootstrap": {"reason": "…", "contractPaths": ["src/herdr/recovery.ts"]}` to that criterion. Other gates apply; `e2e:` proofs cannot be deferred; the next item on those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

It stays Done, marked **delivered with failure**; revert through a new item, never backfill evidence.

## Merged but not deployed

A merge production never served is a `delivery.deployment-incident` ([observation](deployment.md#production-deployment-observation)); fixed, it recovers once served.

## Merge bypass

An ungated merge is a permanent violation: repair access, open a follow-up item, never backfill evidence. An admin opens a direct-merge window: `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate `GRAPHYARD_PRINCIPALS` and redeploy. Operator agents hold only listed capabilities: `graphyard operator-agent setup|list|rotate|revoke`.

## Proof authority grants

```sh
graphyard grants
graphyard grants grant ci "integration:*,unit:*" "CI proofs"
graphyard grants revoke ci "integration:claim-safety" "reason"
```

`graphyard grants` lists live authority; only an `admin` grants or revokes, to `producer` principals: exact name, `kind:*`, prefix (`manual:gy-43/*`).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json`, `--apply` applies it. Later scans and `doctor --profile through-merge|preview-validation|production-verification` report drift without repairing.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (default 250) sizes reconcile batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (default 4, ≤ half pool) share one pace per token: budget above reserve, minus others' spend, paced to reset. Claims: head `max(2,batchSize,parallelTips)` band, in-flight merges, never-observed submissions, five-minute-due jobs, review/rework waits, running sessions (earlier if tight), `available_at`; tight, idle items await webhooks. `observationThroughput` reports budget, pace, head lag, oldest unobserved submission; `master status` raises `github` past two minutes. Heartbeat, claim, `complete` and `blocked` own the lease pool; `leaseHealth` (`GET /api/status`) reports heartbeat p50/p95 and failures (raised past 5 s).

### Concurrent reconciliation

A stale observation snapshot retries after two seconds.
