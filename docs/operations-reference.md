<!-- page: Operate Graphyard | 9 | every recovery procedure and limit. -->
# Operations reference

## Master coordination loop

Restart `graphyard master run` freely; it never dispatches twice. Health: `master status` → `daemon`; log: `journalctl --user -u graphyard-master`. `daemon.metrics.timings` and status `timings` time steps and calls over 1s; status reads cached interventions; failed server requests log route and SQL.

### Perpetual master loop

`master verify-deployment GY-N` refuses a release *unobserved* (set `--deployment-url`), *stale* (rerun), not serving the merge (keep cycling), or *already recording deployment* (follow up).

## Lost worker before submission

Leases expire 120 seconds after the last heartbeat; the next claim (higher epoch) keeps the worktree. Unexplained lapses raise `lease-loss` ([classification](protocol/leases.md#how-a-lease-ends)), blocking merge until settled ([settling](delegation.md#who-may-settle-what)).

## Supervisor died leaving a containment quarantine

On the worker's machine `graphyard master settle-containment GY-N "reason"` verifies no process survives (`containment.held` lists them); only the loop excuses an idle pane shell (childless, parent `herdr server`), closing it. If refused, confirm the stop, then `graphyard rework GY-N --previous-worker-stopped "reason"`, or `graphyard recover-containment GY-N --previous-worker-stopped "reason"` once delivered.

## Submitted implementation needs rework

Stop the worker, then `graphyard rework GY-N --previous-worker-stopped "reason"`; the next worker resubmits.

## Flaky CI check

A required check failing on a tip or head reruns once per sha (*rerun failed jobs*, Actions: write), holding position, approval, proofs; a second failure or refusal ejects (`check.rerun.*` events). Master config `mergeQueue.rerunFailedChecks`: default 1, 0 disables; published like `batchSize`.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)): the gate closes and the queue ejects it.

## GitHub request budget

Observation spends the hourly limit, webhook-first.

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

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations await the reset (`githubBudget.deferrals`).

### What an observation costs

About ten requests uncached; unchanged, none.

### What a pause means for gates

A rate-limit `403`/`429` pauses requests; gates read stale until it lifts; nothing merges on observations over two minutes old.

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `master status` attention subject `github`.

### Webhook liveness

Deliveries silent an hour: `master status` points to `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Per `resources` entry: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow the volume and `GRAPHYARD_DATABASE_MAX_BYTES`.

## Bootstrap mode for a self-proving change

For a change shipping its own proof harness a `policy:bootstrap` holder adds `"bootstrap": {"reason": "…", "contractPaths": ["src/herdr/recovery.ts"]}` to that criterion. Other gates apply; `e2e:` proofs are never deferred; the next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

Stays Done, **delivered with failure**; revert through a new item, never backfill evidence.

## Merged but not deployed

An unserved merge is a `delivery.deployment-incident` ([observation](deployment.md#production-deployment-observation)). It recovers once served.

## Merge bypass

An ungated merge is a permanent violation: repair access, open a follow-up, never backfill evidence. Admins open direct-merge windows: `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate `GRAPHYARD_PRINCIPALS`, redeploy. Operator agents hold listed capabilities only: `graphyard operator-agent setup|list|rotate|revoke`.

## Proof authority grants

```sh
graphyard grants
graphyard grants grant ci "integration:*,unit:*" "CI proves both"
graphyard grants revoke ci "integration:claim-safety" "Runner decommissioned"
```

Admins grant, to `producer` principals only. Patterns: exact name, `kind:*`, or prefix like `manual:gy-43/*`.

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json`; `--apply` applies it. Later scans and `doctor --profile through-merge|preview-validation|production-verification` report drift, repairing nothing.

## Scale limits

Four provider jobs per replica tick; watch lock wait, job lag, budget.

### Concurrent reconciliation

Stale observation snapshots retry after two seconds.
