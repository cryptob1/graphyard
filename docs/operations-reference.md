<!-- page: Operate Graphyard | 9 | recovery procedures and limits. -->
# Operations reference

## Master coordination loop

Restart `graphyard master run` freely; it never dispatches twice. `master status` → `daemon`: health, `cycleTime` (30-minute p50/p95), `metrics.timings` (steps over 1 s); a cycle over 60 s raises `loop`, naming three slowest. Log: `journalctl --user -u graphyard-master`. Launches run beside cycles (`run.launchConcurrency`, default 3); failed requests log route and SQL.

### Perpetual master loop

`master verify-deployment GY-N` refuses a release *unobserved*, *stale* (rerun), not serving the merge, or *already recording deployment* (follow-up).

## Lost worker before submission

A lease expires 120 s after the last heartbeat (one more lease period after a recorded server renewal fault); the next claim (higher epoch) keeps the worktree. An unexplained lapse raises `lease-loss` ([classification](protocol/leases.md#how-a-lease-ends)), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

On the worker, `graphyard master settle-containment GY-N "reason"` verifies nothing survives (the loop alone excuses a childless `herdr server` pane shell). If refused, confirm the stop, then `rework` (`recover-containment` once delivered; [recipes](operations.md#recovery-recipes)). Autosettle's [clock bound](protocol/leases.md#watch).

## Submitted implementation needs rework

Stop the worker, then `graphyard rework GY-N --previous-worker-stopped "reason"`. `scripts/rework-causes.mjs` classifies the last 100 deliveries' rework; `master status`: `speed.reworkRounds.ownChange` (median excluding out-of-item causes). GY-643 (2026-09-26): 55% own-change, 33% conflicts; raw median 2, 0 excluding them.

## Retro synthesis

With `GRAPHYARD_INTERVENTION_PATTERNS=1`, each minute's pattern scan groups refusal and rework interventions by cause: a declared refusal shape (`build/out-of-scope-count`), a loop refusal trigger, or a normalised rework reason. A cause reaching the threshold in the window gets drafted artefacts (`retro.drafted`), never applied or filed as work: a standards or criteria wording update, a mechanical check, a producer-method correction, a fault-catalogue entry. An AI admin or operator agent holding `decision:approve` (not a human session, the drafter, or an instance's recorder) approves one, applying it at its registry's next revision (`requirements`, `checks`, `catalogue`) and recording the cause, fingerprint and instances it closes, or refuses it. In force: requirements show as `retroStanding` in `graphyard status GY-N`; a check (`planned-files`, `merges-onto-base`, `checks-passed`) runs on every submission's observed candidate, refusing `complete` (`409`); a catalogue entry files later instances under its fault class (`catalogue` on interventions, `retroCatalogued` on gate refusals) and counts recurrences against itself. Instances in any draft never count again; a recurrence after application is redrafted naming it (`recurredAfter`). Routes: [work commands](protocol/work-commands.md).

## Flaky CI check

A required check failing on a tip or head reruns once per sha (*rerun failed jobs*, Actions:write), holding position, approval, proofs, with no rework meanwhile, however long its workflow run waits for a runner (`check.rerun.waiting`; master status says *waiting for a runner*); a rerun GitHub accepted but never created is requested once more (`check.rerun.rerequested`); a second failure, a concluded failing rerun or refusal ejects (`check.rerun.*`). Its passing rerun on that tip lifts the ejection. `mergeQueue.rerunFailedChecks`: default 1, 0 disables, published like `batchSize`.

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

Immutable, per-cycle and webhook-driven reads: [not repeated](protocol/github-webhook.md#reads-that-are-not-repeated).

### What a pause means for gates

A `403`/`429` pauses requests; gates read stale until it lifts: nothing merges on an observation over two minutes old.

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `billable` (also in `master status`): `perHour` across replicas (`instances`), `limit`, `share`, `target` 0.6, `byEndpoint`; the 2026-09-26 mix replays at 54%.

### Webhook liveness

A silent hour: `master status` points to `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Per `resources` entry: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow volume and `GRAPHYARD_DATABASE_MAX_BYTES`. `tmp-inodes`: free `/tmp` inodes (system-wide; warns under 25%) and loop removals of 2h-idle `graphyard-*`, `gy-*`, `landing-merge-result*`, `native-*`, `pg-password*`, `playwright_chromiumdev_profile*`. The database bound is `GRAPHYARD_DATABASE_MAX_BYTES` when set, else readable same-host `data_directory` volume size, else an advisory, silent 10 GiB. `agent-names` flags holders 10m past settling; `loaded-revision` counts code moves.

## Storage retention

- **Receipts** answer a retried command for one day; pruned every 10 minutes, 5,000 rows a run.
- **Routine ledger rows** (`github.observed`, `heartbeat`, `reconciled`, `action.claimed`, `action.failed`, `github.queue`, `session`) store only what changed, never the whole work document, unless they move the stage or delivery.
- **Compaction** deletes routine rows older than `GRAPHYARD_LEDGER_RETENTION_DAYS` (default 14, minimum 1) every 10 minutes, in batches of ≤2,000 rows per phase, five a run. It never deletes another kind, a row a delta extends, an item's newest save, a delivery event or the revision a delivery cites, a row of an item merged but not done, or a row the flow projection has not read. Each batch appends a `ledger.compacted` event with counts per kind. Postgres reuses the space; only `VACUUM FULL` returns it to the volume.

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

`graphyard grants` lists live authority; admins only grant or revoke, to `producer` principals: exact name, `kind:*`, or prefix (`manual:gy-43/*`).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json` (`--apply` applies); later scans and `doctor --profile through-merge|preview-validation|production-verification` report drift.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (default 250) sizes reconcile batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (default 4, ≤ half pool) share one pace per token (budget above reserve, less others' spend, to reset). Claims: webhook-woken, head `max(2,batchSize,parallelTips)` band, in-flight merges, never-observed, five-minute-due, review/rework waits, running sessions, `available_at`; tight, idle items await webhooks. `observationThroughput`: budget, pace, head lag, oldest unobserved (`github` past 120s). Heartbeat, claim, `complete` and `blocked` own the lease pool; `leaseHealth` reports heartbeat p50/p95 and failures (raised past 5 s).

Reconcile opens on [cached stand-ins](operations.md#safety-facts-that-never-change), reads each live item whole once per pass, unlocked, and row-locks only its batch, so other mutations never wait. Contended batches back off, then defer a tick; deferrals and >5 s ticks warn.

### Concurrent reconciliation

A stale observation snapshot retries after 2 s.
