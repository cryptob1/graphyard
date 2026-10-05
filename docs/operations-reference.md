<!-- page: Operate Graphyard | 9 | recovery procedures and limits. -->
# Operations reference

## Master coordination loop

Restarting `graphyard master run` never double-dispatches. `master status` → `daemon`: health, `cycleTime` (30-minute p50/p95), `metrics.timings` (steps over 1 s); a cycle over 60 s raises `loop`, naming three slowest. Log: `journalctl --user -u graphyard-master`. Launches run beside cycles (`run.launchConcurrency`, default 3); failed requests log route, SQL. Executor claim order: priority, merge-stage `resync`/`merge`, age; failed rows await `retryAt`, yield once.

### Perpetual master loop

`master verify-deployment GY-N` refuses a release *unobserved*, *stale* (rerun), not serving the merge, or *already recording deployment*. Without `--deployment-url` it reads `productionEnvironment` deployments: newest success counts even inactive or behind sub-hour pending/queued/in_progress/waiting ones.

## Lost worker before submission

A lease expires 120 s after the last heartbeat (one more lease period after a recorded server renewal fault); the next claim (higher epoch) keeps the worktree. An unexplained lapse raises `lease-loss` ([classification](protocol/leases.md#how-a-lease-ends)), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

On the worker, `graphyard master settle-containment GY-N "reason"` verifies nothing survives (the loop alone excuses a childless `herdr server` pane shell). If refused, confirm the stop, then `rework` (`recover-containment` once delivered; [recipes](operations.md#recovery-recipes)). Autosettle's [clock bound](protocol/leases.md#watch).

## Submitted implementation needs rework

Stop the worker, then `graphyard rework GY-N --previous-worker-stopped "reason"`. `scripts/rework-causes.mjs` classifies the last 100 deliveries' rework; `master status`: `speed.reworkRounds.ownChange` (median excluding out-of-item causes). GY-643: 55% own-change, 33% conflicts; raw median 2, 0 excluding them.

## Retro synthesis

With `GRAPHYARD_INTERVENTION_PATTERNS=1`, a minutely scan groups refusal/rework interventions by cause: a declared refusal shape (`build/out-of-scope-count`), a loop refusal trigger, or a normalised rework reason. A cause reaching the threshold gets drafted artefacts (`retro.drafted`), never applied or filed: a standards/criteria wording update, a mechanical check, a producer-method correction, a fault-catalogue entry. An agent holding `decision:approve` (not a human, the drafter, or an instance's recorder) approves one, applying it at its registry's next revision (`requirements`, `checks`, `catalogue`) and recording the cause, fingerprint and instances it closes, or refuses it. In force: requirements show `retroStanding` in `graphyard status GY-N`; a check (`planned-files`, `merges-onto-base`, `checks-passed`) runs on every submission's observed candidate, refusing `complete` (`409`); a catalogue entry files later instances under its fault class (`catalogue` on interventions, `retroCatalogued` on gate refusals) and counts recurrences against itself. Drafted instances never count again; a recurrence after application is redrafted naming it (`recurredAfter`). Routes: [work commands](protocol/work-commands.md).

## Flaky CI check

A required check failing on a tip or head reruns once per sha (*rerun failed jobs*, Actions:write), holding position, approval and proofs, despite runner waits (`check.rerun.waiting`); one GitHub accepted but never created is requested once more (`check.rerun.rerequested`); a second failure, failing rerun or refusal ejects (`check.rerun.*`). A cancelled run never fails: it reruns (≤3) or stays pending. Any later pass lifts ejection. `mergeQueue.rerunFailedChecks`: default 1, 0 disables.

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
| `steady` | unchanged: 5 min, stretched by fleet bound; review requests ≤ 10 min |
| `idle` | awaiting dispatch/escalation: 5 min, stretched if unchanged |

Unchanged non-merge candidates: **at most 40%** (`steadyStateShare`).

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations wait for reset (`githubBudget.deferrals`); a token (`githubBudget.tokens`) projected below it raises `github`.

### What an observation costs

~10 requests uncached; none unchanged.

Immutable, per-cycle and webhook-driven reads: [not repeated](protocol/github-webhook.md#reads-that-are-not-repeated).

### What a pause means for gates

A `403`/`429` pauses requests; gates read stale until it lifts: nothing merges on an observation over two minutes old. A merge stalled only on observation freshness is observed, not reworked or ejected ([prioritized wakes](protocol/github-webhook.md#prioritized-wakes)).

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `billable` (also in `master status`): REST-only `perHour` across replicas (`instances`), `limit`, `share`, `target` 0.6, `byEndpoint`; 2026-09-26's mix replays at 54%.

### Webhook liveness

A silent hour: `master status` points to `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Per `resources` entry: ledgers and `agent-names`, `graphyard master run --once`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow volume and `GRAPHYARD_DATABASE_MAX_BYTES`. `tmp-inodes`: free `/tmp` inodes (warns under 25%) and loop-removed 2h-idle files. Database bound: `GRAPHYARD_DATABASE_MAX_BYTES`, else `data_directory`'s volume, else silent 10 GiB. `agent-names` flags holders 10m past settling, reclaimed each tick; `loaded-revision` counts code moves after 30m self-upgrade.

## Storage retention

- **Receipts** answer a retried command for one day; pruned every 10 minutes, 5,000 rows a run.
- **Routine ledger rows** (`github.observed`, `heartbeat`, `reconciled`, `action.claimed`, `action.failed`, `github.queue`, `session`) store only deltas unless they move the stage or delivery.
- **Compaction** deletes routine rows older than `GRAPHYARD_LEDGER_RETENTION_DAYS` (default 14, minimum 1) every 10 minutes, in batches of ≤2,000 rows per phase, five a run. It never deletes another kind, a delta-extended row, an item's newest save, a delivery event or cited revision, an uncompleted merged item's row, or an unread flow-projection row. Each batch logs `ledger.compacted` counts per kind. Only `VACUUM FULL` returns space to the volume.

### Host memory

Session-started `npm test`, `test:browser`, typecheck, `tsc --noEmit` hold one of max(2, floor(GB/8)) slots (`GRAPHYARD_VERIFICATION_SLOTS`) in the managed root's `.verification-slots` (Codex: `--add-dir`); CI unbounded.

Below max(10% RAM, 4 GB) available, launches defer (`escalation:dispatch:memory`; a `resources` item `memory` names top consumers; one `memory-pressure` fault per dip) until 1 GB above.

## Bootstrap mode for a self-proving change

A `policy:bootstrap` holder adds `"bootstrap": {"reason": "…", "contractPaths": ["src/herdr/recovery.ts"]}` to the criterion; other gates apply, `e2e:` proofs are never deferred, the next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

Stays Done, **delivered with failure**; revert via a new item, never backfill.

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

`graphyard grants` lists live authority; admins only grant or revoke, to `producer` principals: exact name, `kind:*`, or prefix (`manual:gy-43/*`).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json` (`--apply` applies); later scans and `doctor --profile through-merge|preview-validation|production-verification` report drift.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (250) sizes reconcile batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (default 8; `GRAPHYARD_DATABASE_POOL_SIZE` 16, ≥ twice workers) share one pace per token. Claims: webhook-woken, head `max(2,batchSize,parallelTips)` band, in-flight merges, review requests 15+ min stale, never-observed, due, waits, sessions. `observationThroughput`: budget, pace, head lag, oldest unobserved, `bands` lag (`github` past merge 2, review 30 min). Heartbeat, claim, `complete` and `blocked` own the lease pool; `leaseHealth` reports heartbeat p50/p95 and failures (raised past 5 s).

Heartbeats lock only their item, others fleet then item. Reconcile opens on [cached stand-ins](operations.md#safety-facts-that-never-change), evaluating moved-`xmin` rows (all after non-renewal changes or each `GRAPHYARD_RECONCILE_FULL_MS`=10000 ms), skipping writer-held rows. Contended batches rerun twice, halved, then defer; deferrals, >5s ticks warn. Resyncs share one tick and connection.

Listening precedes startup validation; meanwhile `/healthz` reports `readiness: false`, `/healthz?ready` 503.

### Concurrent reconciliation

Stale observation snapshots retry after 2 s.
