<!-- page: Operate Graphyard | 9 | recovery procedures and limits. -->
# Operations reference

## Master coordination loop

Restart `graphyard master run` freely; it never dispatches twice. Health: `master status` → `daemon`; log: `journalctl --user -u graphyard-master`. `daemon.metrics.timings` and status `timings` time steps and calls over 1s; status reads a cached intervention report. Failed server requests log route and SQL statement.

### Perpetual master loop

`master verify-deployment GY-N` refuses a release *unobserved*, *stale* (rerun), not serving the merge (keep cycling) or *already recording deployment* (use a follow-up item).

## Lost worker before submission

A lease expires 120 seconds after the last heartbeat; the next claim (higher epoch) keeps the worktree. An unexplained lapse raises `lease-loss` ([classification](protocol/leases.md#how-a-lease-ends)), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

On the worker's machine `graphyard master settle-containment GY-N "reason"` verifies nothing survives; only the loop excuses an idle pane shell (childless, parent `herdr server`). If refused, confirm the stop, then `graphyard rework GY-N --previous-worker-stopped "reason"` (delivered: `graphyard recover-containment GY-N --previous-worker-stopped "reason"`).

## Submitted implementation needs rework

Stop the worker, then `graphyard rework GY-N --previous-worker-stopped "reason"`; the next worker resubmits.

## Rework rounds by cause

`node scripts/rework-causes.mjs` classifies every rework round of the last 100 delivered items from the ledger's recorded rework reasons — findings on the item's own change, base breakage, conflict with the base, docs budget, lost approval or proof, CI flake, other — and names the share of each. The three largest causes each link to an open fix item; it files one when none exists (needs an admin or wildcard-scope credential, else it prints the payload). `master status` carries the split under `speed.reworkRounds.ownChange`: the rework median again with out-of-item causes removed, so a pipeline change is measured only against the rounds it can affect. As of 2026-09-26: 55% findings on the item's own change, 33% conflicts with the base, 12% spread across docs budget, CI flakes, base breakage, lost approvals, other; the raw median of 2 rounds falls to 0 once out-of-item causes are removed.

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

### What an observation costs

About ten requests uncached; unchanged, none.

### What a pause means for gates

A rate-limit `403`/`429` pauses requests; gates read stale until it lifts.

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `master status` attention with subject `github`.

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

`graphyard init --scan` writes `.graphyard/setup-proposal.json`; `--apply` applies it. Later scans and `doctor --profile through-merge|preview-validation|production-verification` report drift, never repairing it.

## Scale limits

Observation claims `GRAPHYARD_OBSERVATION_CONCURRENCY` jobs at once (default 4, at most half the pool), each `SKIP LOCKED`: queue head and `max(2, batchSize)` band first, then never-observed submissions, any job due over five minutes, review/rework waits, then `available_at`; `master status` raises `github` once the head's observation passes two minutes. Watch `observationThroughput` lag, budget.

### Concurrent reconciliation

A stale observation snapshot retries after two seconds.
