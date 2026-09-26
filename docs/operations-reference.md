<!-- page: Operate Graphyard | 9 | recovery procedures and limits. -->
# Operations reference

## Master coordination loop

Restart `graphyard master run` freely; it never dispatches twice. `master status` (cached interventions) → `daemon` gives health and `cycleTime` (30-minute p50/p95); `journalctl --user -u graphyard-master`, the log. `daemon.metrics.timings` time steps and calls over 1s; cycles over 60 s raise `loop` attention naming three slowest. Launches run beside cycles, `run.launchConcurrency` (default 3) at once. Failed requests log route and SQL.

### Perpetual master loop

`master verify-deployment GY-N` refuses a release *unobserved*, *stale* (rerun), not serving the merge (keep cycling), or *already recording deployment* (use a follow-up item).

## Lost worker before submission

A lease expires 120 seconds after the last heartbeat, or one further lease period after a recorded server-side renewal fault; the next claim, a higher epoch, keeps the worktree. An unexplained lapse raises `lease-loss` ([classification](protocol/leases.md#how-a-lease-ends)), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

On the worker's machine `graphyard master settle-containment GY-N "reason"` verifies nothing survives; only the loop excuses an idle pane shell (childless, parent `herdr server`). If refused, confirm the stop, then `rework`, or `recover-containment` once delivered ([recipes](operations.md#recovery-recipes)).

## Submitted implementation needs rework

Stop the worker, then `graphyard rework GY-N --previous-worker-stopped "reason"`; the next worker resubmits.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes the gate; the queue ejects the entry.

## GitHub request budget

### The live budget

`x-ratelimit-remaining`, `-limit` and `-reset` project exhaustion (`projectedExhaustionAt`).

### Observation cadence by state

| Band | State | Cadence |
| --- | --- | --- |
| `merge` | within two of the queue head, gates passing | 20 seconds |
| `active` | waiting on a check, review, base refresh or rework | 1 minute |
| `steady` | unchanged since last observed | 5 minutes, stretched by the fleet bound |
| `idle` | next action is dispatch or escalation | 5 minutes, stretched when unchanged |

Unchanged non-merge candidates spend **at most 40%** (`steadyStateShare`) of the limit.

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations wait for the reset (`githubBudget.deferrals`).

Budgets are per token (`githubBudget.tokens`); one projected below the reserve at its reset raises `github`.

### What an observation costs

About ten requests uncached; unchanged, none.

### What a pause means for gates

A rate-limit `403`/`429` pauses requests; gates read stale until it lifts.

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `master status` attention items with subject `github`.

### Webhook liveness

After an hour without deliveries `master status` points to `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Per `resources` entry: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow the volume and `GRAPHYARD_DATABASE_MAX_BYTES`.

## Bootstrap mode for a self-proving change

A `policy:bootstrap` holder adds `"bootstrap": {"reason": "…", "contractPaths": ["src/herdr/recovery.ts"]}` to that criterion. Other gates apply; `e2e:` proofs cannot be deferred; the next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

It stays Done, marked **delivered with failure**; revert through a new item, never backfill evidence.

## Merged but not deployed

A merge production never served is a `delivery.deployment-incident` ([observation](deployment.md#production-deployment-observation)). Fix the deployment; it recovers once served.

## Merge bypass

An ungated merge is a permanent violation: repair access, open a follow-up item, never backfill evidence. An admin opens a direct-merge window with `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate `GRAPHYARD_PRINCIPALS` and redeploy. Operator agents hold only listed capabilities: `graphyard operator-agent setup|list|rotate|revoke`.

## Proof authority grants

```sh
graphyard grants                                   # live authority
graphyard grants grant ci "integration:*,unit:*" "CI proofs"
graphyard grants revoke ci "integration:claim-safety" "Runner decommissioned"
```

Only an `admin` grants, only to `producer` principals. Patterns: an exact name, `kind:*`, or a prefix (`manual:gy-43/*`).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json`, `--apply` applies it. Later scans and `doctor --profile through-merge|preview-validation|production-verification` report drift without repairing it.

## Scale limits

`GRAPHYARD_OBSERVATION_CONCURRENCY` workers (default 4, ≤ half the pool) share one pace per token: budget above reserve, less others' projected spend, spread to reset. Claims: head band, in-flight merges, never-observed submissions, jobs due over five minutes, review/rework waits, running sessions (before waits when tight), `available_at`; tight, idle items await webhooks. `observationThroughput` reports budget, pace, head lag, oldest unobserved submission; `master status` raises `github` past two minutes. Heartbeat, claim, `complete` and `blocked` own the lease pool; `leaseHealth` (`GET /api/status`) reports heartbeat p50/p95 and failures, raised above 5 s p95.

The reconciliation tick reads only the items that can change — everything except settled deliveries, selected from the work index — and reads each one once per pass, however many batches it takes, so pass cost grows with the live items, not with items × batches. Each batch locks only its own items' rows (`SELECT … FOR UPDATE`) and holds no coordination lock, so a heartbeat or a request on any other item commits while a batch holds its transaction; a write that landed between the pass's read and an item's lock is left for the next pass, never overwritten. A tick slower than 5 s logs a warning naming its item count and duration: find what held its batches in the server logs.

### Concurrent reconciliation

A stale observation snapshot retries after two seconds.
