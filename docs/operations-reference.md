<!-- page: Operate Graphyard | 9 | recovery procedures and limits. -->
# Operations reference

## Master coordination loop

Restart `graphyard master run` freely; it never dispatches twice. `master status` (cached interventions) → `daemon` gives health and `cycleTime` (30-minute p50/p95); `journalctl --user -u graphyard-master`, the log. `daemon.metrics.timings` time steps and calls over 1s; cycles over 60 s raise `loop` attention naming three slowest. Launches run beside cycles (`run.launchConcurrency`, default 3). Failed requests log route and SQL.

### Perpetual master loop

`master verify-deployment GY-N` refuses a release *unobserved*, *stale* (rerun), not serving the merge, or *already recording deployment* (follow-up item).

## Lost worker before submission

A lease expires 120 seconds after the last heartbeat, or one further lease period after a recorded server-side renewal fault; the next claim, a higher epoch, keeps the worktree. An unexplained lapse raises `lease-loss` ([classification](protocol/leases.md#how-a-lease-ends)), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

On the worker `graphyard master settle-containment GY-N "reason"` verifies nothing survives; only the loop excuses an idle pane shell (childless, parent `herdr server`). If refused, confirm the stop, then `rework` or `recover-containment` once delivered ([recipes](operations.md#recovery-recipes)).

## Submitted implementation needs rework

Stop the worker, then `graphyard rework GY-N --previous-worker-stopped "reason"`; the next worker resubmits. `scripts/rework-causes.mjs` classifies the last 100 deliveries' rework rounds by recorded reason; `master status` reports the split (`speed.reworkRounds.ownChange`): median excluding out-of-item causes. GY-643 (2026-09-26) measured 55% own-change, 33% conflicts; raw median 2, 0 excluding them.

## Retro synthesis

With `GRAPHYARD_INTERVENTION_PATTERNS=1`, each minute's pattern scan groups refusal and rework interventions by cause: a declared refusal shape (`build/out-of-scope-count`), a loop refusal trigger, or a normalised rework reason. A cause reaching the threshold in the window gets drafted artefacts (`retro.drafted`), never applied or filed as work: a standards or criteria wording update, a mechanical check, a producer-method correction, a fault-catalogue entry. An AI admin or operator agent holding `decision:approve` (not a human session, the drafter, or an instance's recorder) approves one, applying it at its registry's next revision (`requirements`, `checks`, `catalogue`) and recording the cause, fingerprint and instances it closes, or refuses it. In force: requirements show as `retroStanding` in `graphyard status GY-N`; a check (`planned-files`, `merges-onto-base`, `checks-passed`) runs on every submission's observed candidate, refusing `complete` (`409`); a catalogue entry files later instances under its fault class (`catalogue` on interventions, `retroCatalogued` on gate refusals) and counts recurrences against itself. Instances in any draft never count again; a recurrence after application is redrafted naming it (`recurredAfter`). Routes: [work commands](protocol/work-commands.md).

## Flaky CI check

A required check failing on a tip or head reruns once per sha (*rerun failed jobs*, Actions:write), holding position, approval, proofs, with no rework meanwhile, however long its workflow run waits for a runner (`check.rerun.waiting`; master status says *waiting for a runner*); a rerun GitHub accepted but never created is requested once more (`check.rerun.rerequested`); a second failure, a concluded failing rerun or refusal ejects (`check.rerun.*`). `mergeQueue.rerunFailedChecks`: default 1, 0 disables, published like `batchSize`.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes the gate; the queue ejects it.

## GitHub request budget

### The live budget

`x-ratelimit-remaining`/`-limit`/`-reset` project exhaustion (`projectedExhaustionAt`).

### Observation cadence by state

| Band | Cadence |
| --- | --- |
| `merge` | within two of the queue head, gates passing: 20 seconds |
| `active` | awaiting a check, review, base refresh or rework: 1 minute |
| `steady` | unchanged since last observed: 5 minutes, stretched by the fleet bound |
| `idle` | next action dispatch or escalation: 5 minutes, stretched when unchanged |

Unchanged non-merge candidates spend **at most 40%** (`steadyStateShare`).

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations wait for the reset (`githubBudget.deferrals`).

Budgets are per token (`githubBudget.tokens`); one projected below the reserve at reset raises `github`.

### What an observation costs

About ten requests uncached; unchanged, none.

### What a pause means for gates

A rate-limit `403`/`429` pauses requests; gates read stale until it lifts: nothing merges on an observation over two minutes old.

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`.

### Webhook liveness

After an hour without deliveries `master status` points to `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Per `resources` entry: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow the volume and `GRAPHYARD_DATABASE_MAX_BYTES`. The database bound is `GRAPHYARD_DATABASE_MAX_BYTES` when set, else the size of the volume holding the database's data directory when the plane can read it (same host, role allowed to read `data_directory`), else an advisory 10 GiB that only warns.

## Storage retention

- **Receipts** answer a retried command for one day, then the server prunes them every 10 minutes, 5,000 rows a run.
- **Routine ledger rows** (`github.observed`, `heartbeat`, `reconciled`, `action.claimed`, `action.failed`, `github.queue`, `session`) store only what changed, never the whole work document, unless they move the stage or delivery.
- **Compaction** deletes routine rows older than `GRAPHYARD_LEDGER_RETENTION_DAYS` (default 14, minimum 1) every 10 minutes, in batches of at most 2,000 rows per phase and five batches a run. It never deletes another kind, a row a delta extends, an item's newest save, a delivery event or the revision a delivery cites, a row of an item merged but not done, or a row the flow projection has not read. Each batch appends a `ledger.compacted` event with counts per kind. Postgres reuses the space; only `VACUUM FULL` returns it to the volume.

## Bootstrap mode for a self-proving change

A `policy:bootstrap` holder adds `"bootstrap": {"reason": "…", "contractPaths": ["src/herdr/recovery.ts"]}` to that criterion. Other gates apply; `e2e:` proofs cannot be deferred; the next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

It stays Done, marked **delivered with failure**; revert through a new item, never backfill evidence.

## Merged but not deployed

A merge production never served is a `delivery.deployment-incident` ([observation](deployment.md#production-deployment-observation)); fixed, it recovers once served.

## Merge bypass

An ungated merge is a permanent violation: repair access, open a follow-up item, never backfill evidence. An admin opens a direct-merge window with `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate `GRAPHYARD_PRINCIPALS` and redeploy. Operator agents hold only listed capabilities: `graphyard operator-agent setup|list|rotate|revoke`.

## Proof authority grants

```sh
graphyard grants
graphyard grants grant ci "integration:*,unit:*" "CI proofs"
graphyard grants revoke ci "integration:claim-safety" "Runner decommissioned"
```

`graphyard grants` lists live authority; only an `admin` grants or revokes, to `producer` principals: exact name, `kind:*`, prefix (`manual:gy-43/*`).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json`, `--apply` applies it. Later scans and `doctor --profile through-merge|preview-validation|production-verification` report drift without repairing.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (default 250) sizes reconcile batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (default 4, ≤ half pool) share one pace per token: budget above reserve, minus others' spend, paced to reset. Claims: head `max(2,batchSize,parallelTips)` band, in-flight merges, never-observed submissions, five-minute-due jobs, review/rework waits, running sessions (earlier if tight), `available_at`; tight, idle items await webhooks. `observationThroughput` reports budget, pace, head lag, oldest unobserved submission; `master status` raises `github` past two minutes. Heartbeat, claim, `complete` and `blocked` own the lease pool; `leaseHealth` (`GET /api/status`) reports heartbeat p50/p95 and failures (raised past 5 s).

### Concurrent reconciliation

A stale observation snapshot retries after two seconds.
