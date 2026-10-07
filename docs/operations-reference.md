<!-- page: Operate Graphyard | 9 | procedures, limits. -->
# Operations reference

## Master coordination loop

`master status` → `daemon`: `cycleTime` (p50/p95); cycles over 60 s raise `loop`. Log: `journalctl --user -u graphyard-master`.

### Perpetual master loop

`master verify-deployment GY-N` refuses *unobserved* or *stale* releases and ones not serving the merge; without `--deployment-url` it reads `productionEnvironment` deployments.

## Lost worker before submission

Leases expire 120 s after the last heartbeat (one further lease period after a recorded renewal fault); unexplained lapses raise [`lease-loss`](protocol/leases.md#how-a-lease-ends), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

`graphyard master settle-containment GY-N "reason"` verifies nothing survives; if refused, confirm the stop, then [`rework`, or `recover-containment` once delivered](operations.md#recovery-recipes) ([autosettle](protocol/leases.md#watch)).

## Submitted implementation needs rework

Stop the worker; `graphyard rework GY-N --previous-worker-stopped "reason"`. `scripts/rework-causes.mjs` classifies the last 100 deliveries' rounds by reason (55% own-change, 33% conflicts; raw median 2).

## Retro synthesis

The scan (`GRAPHYARD_INTERVENTION_PATTERNS=0` disables; `GET /api/interventions` reports `scan`) files an item per crossed pattern and drafts changes per recurring cause, [approved](protocol/work-commands.md) or refused by a non-drafting operator agent; applied ones show as [`retroStanding`](protocol/read-endpoints.md) and refuse a failing `complete`.

## Flaky CI check

A failing check is [rerun](github.md#failed-checks) once (`mergeQueue.rerunFailedChecks`, 0 disables); a second failure returns the item for rework.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes the gate on that head.

## GitHub request budget

### The live budget

`x-ratelimit-remaining`/`-limit`/`-reset` project `projectedExhaustionAt`.

### Observation cadence by state

| Band | Cadence
| --- | ---
| `merge` | every gate passing: 20 s
| `active` | awaiting check, review, base refresh, rework: 1 min
| `steady` | unchanged: 5 min, stretched by fleet bound
| `idle` | awaiting dispatch/escalation: 5 min

Unchanged non-merge candidates spend **at most 40%** (`steadyStateShare`).

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations await reset (`githubBudget.deferrals`); a token projected below reserve raises `github`.

### What an observation costs

About ten requests uncached; unchanged, none.

### What a pause means for gates

A rate-limit `403`/`429` pause stops requests; gates read the last observation until it lifts, and GitHub's own merges are recorded once requests resume ([prioritized wakes](protocol/github-webhook.md#prioritized-wakes)).

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `billable`: REST-only `perHour`, `limit`, `share`, `target` 0.6, `byEndpoint`. Repeat reads are [cached](protocol/github-webhook.md#reads-that-are-not-repeated).

### Webhook liveness

A silent hour: `master status` points to `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Remedies per `resources` entry: ledgers, `graphyard master run --once`; `agent-names`, `herdr pane close PANE`; `session-slots`, raise `concurrency`; `database-capacity`, `GRAPHYARD_DATABASE_MAX_BYTES` (10 GiB); `tmp-inodes`, free `/tmp`.

## Storage retention

Receipts answer retries for a day; compaction deletes past `GRAPHYARD_LEDGER_RETENTION_DAYS` (default 14), appending `ledger.compacted`.

## Bootstrap mode for a self-proving change

A `policy:bootstrap` holder adds `"bootstrap": {"reason": "…", "contractPaths": ["src/herdr/recovery.ts"]}` to the criterion; `e2e:` proofs never defer, and the next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

Stays Done, **delivered with failure**; revert via a new item.

## Merged but not deployed

An unserved merge is a [`delivery.deployment-incident`](deployment.md#production-deployment-observation).

## Merge bypass

An ungated merge is a permanent violation: repair access, file a follow-up, never backfill. Admin window: `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate [`GRAPHYARD_PRINCIPALS`](deployment.md#variables), redeploy; operator agents: `graphyard operator-agent setup|list|rotate|revoke`.

## Proof authority grants

```sh
graphyard grants
graphyard grants grant|revoke ci "integration:*,unit:*" REASON
```

Only `admin` grants, to `producer` principals: exact name, `kind:*` or prefix (`manual:gy-43/*`).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json` (`--apply` applies); `doctor --profile through-merge|preview-validation|production-verification` reports drift.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (250) sizes batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (8; `GRAPHYARD_DATABASE_POOL_SIZE` ≥ twice) pace per token, merge path first. Heartbeat, claim, `complete` and `blocked` own the lease pool; `/healthz?ready` is 503 until startup validation finishes. Session-started test and typecheck runs share max(2, floor(GB/8)) slots (`GRAPHYARD_VERIFICATION_SLOTS`); under max(10% RAM, 4 GB) free, launches defer.

### Concurrent reconciliation

A 2 s tick evaluates batches lock-free, then writes each item in its own transaction under the coordination lock (≤500 ms wait) and its row lock; a renewal waits on at most one evaluation.
