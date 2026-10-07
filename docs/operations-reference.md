<!-- page: Operate Graphyard | 9 | recovery procedures and limits. -->
# Operations reference

## Master coordination loop

`master status` → `daemon`: health, `cycleTime` (30-minute p50/p95); cycles over 60 s raise `loop`. Log: `journalctl --user -u graphyard-master`.

### Perpetual master loop

`master verify-deployment GY-N` emits instructions from an isolated served-commit checkout and refuses releases *unobserved*, *stale* (rerun), not serving the merge, or already recorded. Without `--deployment-url`, the newest successful `productionEnvironment` deployment counts.

## Lost worker before submission

Leases expire 120 s after last heartbeat (one further lease period after a recorded renewal fault); next claim (higher epoch) keeps the worktree. Unexplained lapses raise [`lease-loss`](protocol/leases.md#how-a-lease-ends), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

On the worker, `graphyard master settle-containment GY-N "reason"` verifies nothing survives. If refused, confirm the stop, then [`rework`, or `recover-containment` once delivered](operations.md#recovery-recipes). Autosettle's [clock bound](protocol/leases.md#watch).

## Submitted implementation needs rework

Stop worker; `graphyard rework GY-N --previous-worker-stopped "reason"`; next worker resubmits. `scripts/rework-causes.mjs` classifies the last 100 deliveries' rounds by reason (55% own-change, 33% conflicts; raw median 2); `master status` `speed.reworkRounds.ownChange` excludes out-of-item causes (median 0).

## Retro synthesis

The scan (`GRAPHYARD_INTERVENTION_PATTERNS=0` disables; `GET /api/interventions` reports `scan`) opens an item per crossed pattern each minute and drafts changes per recurring refusal or rework cause (`retro.drafted`: wording, check, producer method, fault-catalogue entry), each [approved](protocol/work-commands.md) or refused by a non-drafting operator agent (`decision:approve`). Approved requirements show as [`retroStanding`](protocol/read-endpoints.md) in `graphyard status GY-N`; checks refuse a failing `complete`. Off, `master status` flags crossed patterns as configuration faults.

## Flaky CI check

A failing check is [rerun](github.md#failed-checks) once (`mergeQueue.rerunFailedChecks`, 0 disables); a second failure returns it for rework; a passing rerun clears it.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes the gate, so that head's required checks no longer pass on GitHub.

## GitHub request budget

### The live budget

`x-ratelimit-remaining`/`-limit`/`-reset` project `projectedExhaustionAt`.

### Observation cadence by state

| Band | Cadence
| --- | ---
| `merge` | every gate passing, GitHub may merge it: 20 s
| `active` | awaiting check, review, base refresh, rework: 1 min
| `steady` | unchanged: 5 min, stretched by fleet bound; review requests ≤ 10 min
| `idle` | awaiting dispatch/escalation: 5 min, stretched if unchanged

Unchanged non-merge candidates spend **at most 40%** (`steadyStateShare`).

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations await reset (`githubBudget.deferrals`); a token (`githubBudget.tokens`) projected below reserve at reset raises `github`.

### What an observation costs

About ten requests uncached; unchanged, none.

### What a pause means for gates

A rate-limit `403`/`429` pause stops requests; gates read the last observation until it lifts. GitHub keeps merging on branch protection; merges are recorded on resumption ([prioritized wakes](protocol/github-webhook.md#prioritized-wakes)).

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `billable` (also `master status`): REST-only `perHour` across replicas (`instances`), `limit`, `share`, `target` 0.6, `byEndpoint`. Immutable, per-cycle and webhook-driven reads are [not repeated](protocol/github-webhook.md#reads-that-are-not-repeated).

### Webhook liveness

A silent hour: `master status` points to `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Per `resources` entry: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow volume and `GRAPHYARD_DATABASE_MAX_BYTES` (default 10 GiB); `tmp-inodes`, free `/tmp` (TMPDIR, `/tmp`); `loaded-revision` counts code moves. No reading faults while its remedy acts: an owed restart retried within bound, a pane unowned under 10 minutes, the loop's own lag, `/tmp` above a tenth free after a pass within 30 minutes.

Merges awaiting a due-later or validating [promotion](delivery.md) owe no restart: `releaseLag` and `loaded-revision` skip them (never on an unavailable observation). Sandboxed `systemctl --user` probes read unverified given the cursor's unit.

## Storage retention

Receipts answer retries for a day; compaction deletes past `GRAPHYARD_LEDGER_RETENTION_DAYS` (default 14, min 1), appending `ledger.compacted`.

### Host memory

Session-started `npm test`, `test:browser`, typecheck and `tsc --noEmit` wait for one of max(2, floor(GB/8)) slots (`GRAPHYARD_VERIFICATION_SLOTS`) in the managed root's `.verification-slots`; CI is unbounded. Below max(10% RAM, 4 GB) available, launches defer (`escalation:dispatch:memory`; `resources` item `memory` names top consumers; one `memory-pressure` fault per dip) until 1 GB above.

## Bootstrap mode for a self-proving change

A `policy:bootstrap` holder adds `"bootstrap": {"reason": "…", "contractPaths": ["src/herdr/recovery.ts"]}` to the criterion. Other gates apply; `e2e:` proofs never defer; the next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

Stays Done, **delivered with failure**; revert via a new item, never backfill.

## Merged but not deployed

An unserved merge is a [`delivery.deployment-incident`](deployment.md#production-deployment-observation) until served.

## Merge bypass

An ungated merge is a permanent violation: repair access, file a follow-up, never backfill. Admin direct-merge window: `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate [`GRAPHYARD_PRINCIPALS`](deployment.md#variables), redeploy. Operator agents hold only listed capabilities, `graphyard operator-agent setup|list|rotate|revoke`.

## Proof authority grants

```sh
graphyard grants
graphyard grants grant|revoke ci "integration:*,unit:*" REASON
```

Only `admin` grants or revokes, to `producer` principals: exact name, `kind:*` or prefix (`manual:gy-43/*`).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json` (`--apply` applies); rescans and `doctor --profile through-merge|preview-validation|production-verification` report drift, never repair.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (250) sizes batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (8; `GRAPHYARD_DATABASE_POOL_SIZE` 16, ≥ twice workers) pace per token, merge path first (`observationThroughput`). Heartbeat, claim, `complete`, `blocked` own the lease pool (`leaseHealth` in `GET /api/status`). Reconcile evaluates moved rows (all every `GRAPHYARD_RECONCILE_FULL_MS`). Until startup validation finishes, `/healthz` reports `readiness: false`, `/healthz?ready` 503.

### Concurrent reconciliation

Ticks run every 2 s (target ≤5 s); slower ones log `reconciliation tick took N ms` with writes and longest lock wait. Locks, in order:

1. Opening: the coordination lock, briefly, reading row versions and sweeping direct merges.
2. Each batch evaluates ≤250 ms lock-free, planning ≤8 writes.
3. Each write is its own transaction: the coordination lock (≤500 ms wait, holding no row), the item's row (`FOR NO KEY UPDATE`), then commit. A moved read re-evaluates first. Job wakes follow commit in work-id order.

Three expired lock waits defer unwritten items a tick. A renewal takes only its item's lock. Before each evaluation and write, reconciliation yields to pending requests and waits ≤1 s for renewals (each waits on ≤1 evaluation). Stale observation snapshots retry after 2 s.
