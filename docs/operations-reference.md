<!-- page: Operate Graphyard | 9 | recovery procedures and limits. -->
# Operations reference

## Master coordination loop

Restarting `graphyard master run` never dispatches twice. `master status` (cached interventions) → `daemon`: health, `cycleTime` (30-minute p50/p95); Cycles over 60 s raise `loop`. Log: `journalctl --user -u graphyard-master`. Launches run beside cycles (`run.launchConcurrency`, default 3).

### Perpetual master loop

`master verify-deployment GY-N` refuses releases *unobserved*, *stale* (rerun), not serving the merge, *already recording deployment* (follow-up item).

## Lost worker before submission

Leases expire 120 s after last heartbeat (one further lease period after a recorded renewal fault); next claim (higher epoch) keeps the worktree. Unexplained lapses raise [`lease-loss`](protocol/leases.md#how-a-lease-ends), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

On the worker, `graphyard master settle-containment GY-N "reason"` verifies only an idle pane shell (childless, parent `herdr server`) survives; refused: confirm stop, then [`rework`, or `recover-containment` once delivered](operations.md#recovery-recipes).

## Submitted implementation needs rework

Stop worker; `graphyard rework GY-N --previous-worker-stopped "reason"`; next worker resubmits. `scripts/rework-causes.mjs` classifies the last 100 deliveries' rounds by recorded reason (55% own-change, 33% conflicts; raw median 2); `master status` `speed.reworkRounds.ownChange` excludes out-of-item causes (median 0).

## Retro synthesis

`GRAPHYARD_INTERVENTION_PATTERNS=1`: a per-minute scan groups refusal/rework interventions by cause; at the window threshold → unapplied, unfiled drafts (`retro.drafted`): standards/criteria wording, mechanical check, producer-method correction, fault-catalogue entry. An AI admin/operator agent with `decision:approve` (not human, drafter, recorder) [approves](protocol/work-commands.md)/refuses each; applied at its registry's next revision. Requirements → [`retroStanding`](protocol/read-endpoints.md) in `graphyard status GY-N`; checks run on each observed submission, refusing failing `complete` (`409`); catalogue entries file and count later instances under their fault class. Drafted instances never recount; recurrence after application redrafts (`recurredAfter`).

## Flaky CI check

[Rerun](github.md#merge-queue) of a check failing on tip or head keeps position, approval, proofs; second failure, concluded failing rerun or refusal ejects; a passing rerun on that tip lifts the ejection. `mergeQueue.rerunFailedChecks`: default 1, 0 disables.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes the gate and ejects.

## GitHub request budget

### The live budget

`x-ratelimit-remaining`/`-limit`/`-reset` project `projectedExhaustionAt`.

### Observation cadence by state

| Band | Cadence
| --- | ---
| `merge` | passing, within two of head or a parallel tip: 20 s
| `active` | awaiting check, review, base refresh, rework: 1 min
| `steady` | unchanged: 5 min, stretched by fleet bound
| `idle` | awaiting dispatch/escalation: 5 min, stretched if unchanged

Unchanged non-merge candidates spend **at most 40%** (`steadyStateShare`).

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations await reset (`githubBudget.deferrals`); a token (`githubBudget.tokens`) projected below reserve at reset raises `github`.

### What an observation costs

About ten requests uncached; unchanged, none.

### What a pause means for gates

A rate-limit `403`/`429` pause stops requests; gates read stale until it lifts; nothing merges on an observation over two minutes old.

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `billable` (also `master status`): `perHour` across replicas (`instances`), `limit`, `share`, `target` 0.6, `byEndpoint`. Immutable, per-cycle and webhook-driven reads are [not repeated](protocol/github-webhook.md#reads-that-are-not-repeated).

### Webhook liveness

Hour without deliveries: `master status` points to `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Per `resources` entry: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow the volume and `GRAPHYARD_DATABASE_MAX_BYTES`. `tmp-inodes`: free `/tmp` inodes (filesystem-wide; warns under 25%); the loop removes 2h-idle Graphyard temporary directories.

## Storage retention

Receipts answer retries for a day; routine ledger rows store only the change unless moving stage or delivery; every 10 minutes, compaction deletes them past `GRAPHYARD_LEDGER_RETENTION_DAYS` (default 14, minimum 1), each batch appending `ledger.compacted` (per-kind counts).

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

`GRAPHYARD_RECONCILE_BATCH_MS` (default 250): reconcile batch size. `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (default 4, ≤half the pool) share one pace per token (above-reserve budget minus others' spend, until reset), claiming webhook-woken jobs, then the merge path, then the rest. `observationThroughput`: budget, pace, head lag, oldest unobserved submission (`github` past two minutes). Heartbeat, claim, `complete`, `blocked` own the lease pool; `leaseHealth` (`GET /api/status`): heartbeat p50/p95, failures (raised past 5 s).

### Concurrent reconciliation

Reconcile reads each live item once per pass and locks only its batch rows; contended batches back off, then defer to the next tick (warnings past 5 s). A stale snapshot retries after two seconds.
