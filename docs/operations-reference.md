<!-- page: Operate Graphyard | 9 | recovery procedures and limits. -->
# Operations reference

## Master coordination loop

Restart `graphyard master run` freely; it never dispatches twice. `master status` `daemon` reports health and cycle times; cycles over 60 s raise `loop`. Log: `journalctl --user -u graphyard-master`. `run.launchConcurrency` (default 3) bounds launches.

### Perpetual master loop

`master verify-deployment GY-N` refuses a release *unobserved*, *stale* (rerun), not serving the merge, or *already recording deployment* (follow-up). Without `--deployment-url` it reads `productionEnvironment` deployments only; the newest, if successful, counts even when inactive.

## Lost worker before submission

A lease expires 120 s after the last heartbeat (one further lease period after a recorded renewal fault); the next claim keeps the worktree. An unexplained lapse raises [`lease-loss`](protocol/leases.md#how-a-lease-ends), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

On the worker, `graphyard master settle-containment GY-N "reason"` verifies only an idle pane shell survives. If refused, confirm the stop, then [`rework` or `recover-containment`](operations.md#recovery-recipes). Autosettle bounds clock skew via `HEAD`.

## Submitted implementation needs rework

Stop the worker, then [`rework`](operations.md#recovery-recipes). `scripts/rework-causes.mjs` classifies rounds; `speed.reworkRounds.ownChange` excludes out-of-item causes. Measured: 55% own-change, 33% conflicts; raw median 2, 0 excluding them.

## Retro synthesis

With `GRAPHYARD_INTERVENTION_PATTERNS=1`, recurring causes become drafts (`retro.drafted`), never self-applied. [Approved](protocol/work-commands.md) ones join [`retroStanding`](protocol/read-endpoints.md) and refuse a failing `complete` (`409`); one recurring after application is redrafted (`recurredAfter`).

## Flaky CI check

A failing required check [reruns once](github.md#merge-queue) per sha, keeping position, approval and proofs (`check.rerun.waiting`, `check.rerun.rerequested`); a second failure or refusal ejects (`check.rerun.*`). A cancelled run never fails: it reruns (≤3) or stays pending. `mergeQueue.rerunFailedChecks`: default 1, 0 disables.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes the gate and ejects.

## GitHub request budget

### The live budget

`x-ratelimit-remaining`/`-reset` project `projectedExhaustionAt`.

### Observation cadence by state

| Band | Cadence |
| --- | --- |
| `merge` | passing, within two of the head or a parallel tip: 20 s |
| `active` | awaiting check, review or rework: 1 min |
| `steady` | unchanged: 5 min or longer; review requests ≤ 10 min |
| `idle` | awaiting dispatch or escalation: 5 min |

Unchanged non-merge candidates: **at most 40%** (`steadyStateShare`).

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations wait for the reset (`githubBudget.deferrals`); a token (`githubBudget.tokens`) projected below it raises `github`.

### What an observation costs

About ten requests; unchanged, none. Immutable, per-cycle and webhook-driven reads are [not repeated](protocol/github-webhook.md#reads-that-are-not-repeated).

### What a pause means for gates

A `403`/`429` pauses requests; gates read stale until it lifts; nothing merges on an observation over two minutes old.

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `billable` (also `master status`): `perHour` across `instances`, `limit`, `share`, `target` 0.6, `byEndpoint`.

### Webhook liveness

After an hour without deliveries, check `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Per `resources` entry: ledgers and `agent-names` (holders 10m past settling), `graphyard master run --once`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow the volume and `GRAPHYARD_DATABASE_MAX_BYTES` (default: volume size, else advisory 10 GiB); `tmp-inodes`, free `/tmp` inodes (filesystem-wide; warns under 25%); the loop clears 2h-idle `graphyard-*`, `gy-*`, `landing-merge-result*`, `native-*`, `pg-password*`, `playwright_chromiumdev_profile*`; `loaded-revision` counts code moves.

## Storage retention

Receipts answer retries for a day. Routine ledger rows (`github.observed`, `heartbeat`, `action.*`) store only the change; `ledger.compacted` deletes those past `GRAPHYARD_LEDGER_RETENTION_DAYS` (default 14, minimum 1) unless delivery or flow needs them. Only `VACUUM FULL` frees disk.

## Bootstrap mode for a self-proving change

A `policy:bootstrap` holder adds `"bootstrap": {"reason": "…", "contractPaths": ["src/herdr/recovery.ts"]}` to the criterion. Other gates apply; `e2e:` proofs never defer; the next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

It stays Done, **delivered with failure**; revert through a new item, never backfill evidence.

## Merged but not deployed

An unserved merge is a [`delivery.deployment-incident`](deployment.md#production-deployment-observation) until served.

## Merge bypass

An ungated merge is a permanent violation: repair access, open a follow-up item, never backfill evidence. Admin direct-merge window: `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate [`GRAPHYARD_PRINCIPALS`](deployment.md#variables), redeploy. Operator agents hold only listed capabilities: `graphyard operator-agent setup|list|rotate|revoke`.

## Proof authority grants

```sh
graphyard grants
graphyard grants grant|revoke ci "integration:*,unit:*" REASON
```

Only an `admin` grants or revokes, to `producer` principals: exact name, `kind:*` or prefix.

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json`; `--apply` applies it. Later scans and `doctor --profile through-merge|preview-validation|production-verification` report drift, never repair it.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (default 250) sizes reconcile batches. `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (default 8; `GRAPHYARD_DATABASE_POOL_SIZE` 16, ≥ twice workers) pace each token's budget to the reset; review requests 15+ min stale are claimed. `observationThroughput`: pace, head lag, `bands` lag (`github` past merge 2, review 30 min). `leaseHealth`: lease pool (heartbeat, claim, `complete`, `blocked`) p50/p95, raised past 5 s.

Reconcile reads each live item once per pass, locking only its batch rows; contended batches back off, then defer a tick; ticks over 5 s warn.

### Concurrent reconciliation

A stale snapshot retries after two seconds.
