<!-- page: Operate Graphyard | 9 | recovery procedures and limits. -->
# Operations reference

## Master coordination loop

Restart `graphyard master run` freely; it never dispatches twice. `master status` → `daemon`: health, `cycleTime` (30-minute p50/p95), `metrics.timings` (steps over 1 s); a cycle over 60 s raises `loop`, naming three slowest. Log: `journalctl --user -u graphyard-master`. Launches run beside cycles (`run.launchConcurrency`, default 3); failed requests log route and SQL.

### Perpetual master loop

`master verify-deployment GY-N` refuses a release *unobserved*, *stale* (rerun), not serving the merge, or *already recording deployment* (follow-up).

## Lost worker before submission

A lease expires 120 s after the last heartbeat (one more lease period after a recorded server renewal fault); the next claim (higher epoch) keeps the worktree. An unexplained lapse raises `lease-loss` ([classification](protocol/leases.md#how-a-lease-ends)), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

On the worker, `graphyard master settle-containment GY-N "reason"` verifies nothing survives (the loop alone excuses a childless `herdr server` pane shell). If refused, confirm the stop, then `rework`, or `recover-containment` once delivered ([recipes](operations.md#recovery-recipes)).

## Submitted implementation needs rework

Stop the worker, then `graphyard rework GY-N --previous-worker-stopped "reason"`. `scripts/rework-causes.mjs` classifies the last 100 deliveries' rework; `master status` reports `speed.reworkRounds.ownChange` (median excluding out-of-item causes). GY-643 (2026-09-26): 55% own-change, 33% conflicts; raw median 2, 0 excluding them.

## Flaky CI check

A failing required check reruns once per sha (*rerun failed jobs*, Actions:write), keeping position, approval, proofs; another failure or refusal ejects (`check.rerun.*`). `mergeQueue.rerunFailedChecks`: default 1, 0 disables.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes the gate and ejects it.

## GitHub request budget

### The live budget

`x-ratelimit-remaining`/`-limit`/`-reset` project exhaustion (`projectedExhaustionAt`).

### Observation cadence by state

| Band | Cadence |
| --- | --- |
| `merge` | near queue head, gates passing: 20 s |
| `active` | awaiting check, review, base refresh, rework: 1 min |
| `steady` | unchanged: 5 min, stretched by fleet bound |
| `idle` | awaiting dispatch/escalation: 5 min, stretched if unchanged |

Unchanged non-merge candidates: **at most 40%** (`steadyStateShare`).

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations wait for reset (`githubBudget.deferrals`); a token (`githubBudget.tokens`) projected below it raises `github`.

### What an observation costs

~10 requests uncached; unchanged, none.

### Reads that are not repeated

- **Immutable:** commits by SHA and exact-SHA compares: fetched once, kept permanently in `github_cache`.
- **Per cycle:** the base ref once per 15 s (a base push or own ref write restarts it); protection every 5 minutes or after a protection, ruleset or `repository` event.
- **Webhooks:** `pull_request`, `pull_request_review`, `check_run`, `check_suite` and `push` (branch pushes too) claim items first on any replica; a poll within a webhook-driven observation's interval is skipped (`poll skipped: a webhook refreshed this item`).

### What a pause means for gates

A `403`/`429` pauses requests; gates read stale until it lifts.

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; its `billable` (in `master status`) gives `perHour` across all replicas (`instances`), `limit`, `share`, `target` 0.6, `byEndpoint`. The 2026-09-26 mix replays at 54%.

### Webhook liveness

A silent hour: `master status` points to `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Per `resources` entry: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow the volume and `GRAPHYARD_DATABASE_MAX_BYTES`.

## Bootstrap mode for a self-proving change

A `policy:bootstrap` holder adds `"bootstrap": {"reason": "…", "contractPaths": ["src/herdr/recovery.ts"]}` to the criterion; other gates apply, `e2e:` proofs are never deferred, the next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

It stays Done, **delivered with failure**; revert via a new item, never backfill.

## Merged but not deployed

A merge production never served is a `delivery.deployment-incident` ([observation](deployment.md#production-deployment-observation)), recovered once served.

## Merge bypass

An ungated merge is a permanent violation: repair access, file a follow-up, never backfill evidence. Admin direct-merge window: `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate `GRAPHYARD_PRINCIPALS`, redeploy. Operator agents hold only listed capabilities (`graphyard operator-agent setup|list|rotate|revoke`).

## Proof authority grants

```sh
graphyard grants
graphyard grants grant ci "integration:*,unit:*" "CI proofs"
graphyard grants revoke ci "integration:claim-safety" "Runner decommissioned"
```

Admins only, to `producer` principals: exact name, `kind:*`, or prefix (`manual:gy-43/*`).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json` (`--apply` applies); later scans and `doctor --profile through-merge|preview-validation|production-verification` report drift.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (default 250) sizes reconcile batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (default 4, ≤ half pool) share one pace per token (budget above reserve, less others' spend, to reset). Claims: webhook-woken, head `max(2,batchSize,parallelTips)` band, in-flight merges, never-observed, five-minute-due, review/rework waits, running sessions, `available_at`; tight, idle items await webhooks. `observationThroughput`: budget, pace, head lag, oldest unobserved (`github` past 120s). Heartbeat, claim, `complete` and `blocked` own the lease pool; `leaseHealth` reports heartbeat p50/p95 and failures (raised past 5 s).

### Concurrent reconciliation

A stale observation snapshot retries after 2 s.
