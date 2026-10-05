<!-- page: Operate Graphyard | 9 | recovery procedures and limits. -->
# Operations reference

## Master coordination loop

`master status` → `daemon`: health, `cycleTime` (30-minute p50/p95); cycles over 60 s raise `loop`. Log: `journalctl --user -u graphyard-master`.

### Perpetual master loop

`master verify-deployment GY-N` refuses releases *unobserved*, *stale* (rerun), not serving the merge, *already recording deployment*. Without `--deployment-url` it reads `productionEnvironment` deployments (newest success counts).

## Lost worker before submission

Leases expire 120 s after last heartbeat (one further lease period after a recorded renewal fault); next claim (higher epoch) keeps the worktree. Unexplained lapses raise [`lease-loss`](protocol/leases.md#how-a-lease-ends), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

On the worker, `graphyard master settle-containment GY-N "reason"` verifies nothing survives. If refused, confirm the stop, then [`rework`, or `recover-containment` once delivered](operations.md#recovery-recipes). Autosettle's [clock bound](protocol/leases.md#watch).

## Submitted implementation needs rework

Stop worker; `graphyard rework GY-N --previous-worker-stopped "reason"`; next worker resubmits. `scripts/rework-causes.mjs` classifies the last 100 deliveries' rounds by recorded reason (55% own-change, 33% conflicts; raw median 2); `master status` `speed.reworkRounds.ownChange` excludes out-of-item causes (median 0).

## Retro synthesis

`GRAPHYARD_INTERVENTION_PATTERNS=1` groups refusal and rework interventions by cause; at the threshold it drafts unapplied changes (`retro.drafted`: wording, check, producer method, fault-catalogue entry), each [approved](protocol/work-commands.md) or refused by a non-drafting AI operator agent with `decision:approve`. Approved requirements show as [`retroStanding`](protocol/read-endpoints.md) in `graphyard status GY-N`; checks refuse a failing `complete` (`409`).

## Flaky CI check

A failing check is [rerun](github.md#merge-queue) once in place (`mergeQueue.rerunFailedChecks`, 0 disables); a second failure ejects, and a passing rerun on that tip lifts the ejection.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes the gate and ejects.

## GitHub request budget

### The live budget

`x-ratelimit-remaining`/`-limit`/`-reset` project `projectedExhaustionAt`.

### Observation cadence by state

| Band | Cadence
| --- | ---
| `merge` | near queue head, gates passing: 20 s
| `active` | awaiting check, review, base refresh, rework: 1 min
| `steady` | unchanged: 5 min, stretched by fleet bound; review requests ≤ 10 min
| `idle` | awaiting dispatch/escalation: 5 min, stretched if unchanged

Unchanged non-merge candidates spend **at most 40%** (`steadyStateShare`).

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations await reset (`githubBudget.deferrals`); a token (`githubBudget.tokens`) projected below reserve at reset raises `github`.

### What an observation costs

About ten requests uncached; unchanged, none.

### What a pause means for gates

A rate-limit `403`/`429` pause stops requests; gates read stale until it lifts; nothing merges on an observation over two minutes old. A merge stalled only on freshness gets a [prioritized wake](protocol/github-webhook.md#prioritized-wakes), not rework.

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `billable` (also `master status`): REST-only `perHour` across replicas (`instances`), `limit`, `share`, `target` 0.6, `byEndpoint`. Immutable, per-cycle and webhook-driven reads are [not repeated](protocol/github-webhook.md#reads-that-are-not-repeated).

### Webhook liveness

Hour without deliveries: `master status` points to `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Per `resources` entry: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow volume and `GRAPHYARD_DATABASE_MAX_BYTES` (default 10 GiB); `tmp-inodes`: free `/tmp` inodes; `loaded-revision` counts code moves.

## Storage retention

Receipts answer retries for a day; ledger rows store changes; compaction deletes past `GRAPHYARD_LEDGER_RETENTION_DAYS` (default 14, min 1), appending `ledger.compacted`.

## Bootstrap mode for a self-proving change

A `policy:bootstrap` holder adds `"bootstrap": {"reason": "…", "contractPaths": ["src/herdr/recovery.ts"]}` to the criterion. Other gates apply; `e2e:` proofs never defer; the next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

Stays Done, **delivered with failure**; revert via a new item, never backfill evidence.

## Merged but not deployed

An unserved merge is a [`delivery.deployment-incident`](deployment.md#production-deployment-observation) until served.

## Merge bypass

Ungated merge = permanent violation: repair access, open a follow-up item, never backfill. Admin direct-merge window: `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate [`GRAPHYARD_PRINCIPALS`](deployment.md#variables), redeploy. Operator agents hold only listed capabilities, `graphyard operator-agent setup|list|rotate|revoke`.

## Proof authority grants

```sh
graphyard grants
graphyard grants grant|revoke ci "integration:*,unit:*" REASON
```

Only `admin` grants/revokes, to `producer` principals: exact name, `kind:*` or prefix (`manual:gy-43/*`) (`graphyard grants` lists).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json`, `--apply` applies; later scans and `doctor --profile through-merge|preview-validation|production-verification` report drift, never repair.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (250) sizes batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (8; `GRAPHYARD_DATABASE_POOL_SIZE` 16, ≥ twice workers) pace per token, merge path first (`observationThroughput`). Heartbeat, claim, `complete`, `blocked` own the lease pool (`leaseHealth` in `GET /api/status`). Reconcile evaluates moved rows (all every `GRAPHYARD_RECONCILE_FULL_MS`), skipping writer-held rows. Until startup validation finishes, `/healthz` reports `readiness: false` and `/healthz?ready` 503.

### Concurrent reconciliation

Each pass locks its batch rows; contended batches defer a tick; stale observation snapshots retry after 2 s.
