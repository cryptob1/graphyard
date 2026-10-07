<!-- page: Operate Graphyard | 9 | procedures, limits. -->
# Operations reference

## Master coordination loop

`master status` → `daemon`: health, `cycleTime` (30-minute p50/p95); cycles >60s raise `loop`. Log: `journalctl --user -u graphyard-master`.

### Perpetual master loop

`master verify-deployment GY-N` refuses *unobserved*, *stale* (rerun), unserving or already-recorded releases; without `--deployment-url`, the newest successful `productionEnvironment` deployment counts.

## Lost worker before submission

Leases expire 120s after the last heartbeat (one more lease period after recorded renewal fault); next, higher-epoch claim keeps the worktree. Unexplained lapses raise [`lease-loss`](protocol/leases.md#how-a-lease-ends), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

On worker, `graphyard master settle-containment GY-N "reason"` verifies nothing survives; refused: confirm stop, then [`rework`, or `recover-containment` once delivered](operations.md#recovery-recipes) ([autosettle](protocol/leases.md#watch)).

## Submitted implementation needs rework

Stop worker; `graphyard rework GY-N --previous-worker-stopped "reason"`; the next worker resubmits. `scripts/rework-causes.mjs` classifies the last 100 deliveries' rounds by cause (55% own-change, 33% conflicts; raw median 2); `master status` `speed.reworkRounds.ownChange` excludes out-of-item causes.

## Retro synthesis

Each minute scan (`GET /api/interventions` → `scan`; `GRAPHYARD_INTERVENTION_PATTERNS=0` disables, and `master status` then flags crossed patterns as configuration faults) files item per crossed pattern and drafts `retro.drafted` changes (wording, check, producer method, fault-catalogue entry) per recurring refusal or rework cause; non-drafting operator agent [approves](protocol/work-commands.md) (`decision:approve`) or refuses each. Approved: [`retroStanding`](protocol/read-endpoints.md) in `graphyard status GY-N`; checks refuse failing `complete`.

## Flaky CI check

A failing check [reruns](github.md#failed-checks) once (`mergeQueue.rerunFailedChecks`, 0 disables); passing clears it, failing again means rework.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes the gate; required checks fail on that head.

## GitHub request budget

### The live budget

`x-ratelimit-remaining`/`-limit`/`-reset` project `projectedExhaustionAt`.

### Observation cadence by state

| Band | Cadence
| --- | ---
| `merge` | gates pass, GitHub may merge: 20s
| `active` | awaiting check, review, base refresh, rework: 1min
| `steady` | unchanged: 5min, stretched by fleet bound; review requests ≤10min
| `idle` | awaiting dispatch/escalation: 5min, stretched if unchanged

Unchanged non-merge candidates spend **at most 40%** (`steadyStateShare`).

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations await reset (`githubBudget.deferrals`); token (`githubBudget.tokens`) projected below reserve at reset raises `github`.

### What an observation costs

~10 requests uncached; unchanged, none.

### What a pause means for gates

A `403`/`429` pause stops requests: gates read the last observation until it lifts; GitHub keeps merging on branch protection, recorded on resume ([prioritized wakes](protocol/github-webhook.md#prioritized-wakes)).

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `billable` (also `master status`): REST-only `perHour` across replicas (`instances`), `limit`, `share`, `target` 0.6, `byEndpoint`. Immutable, per-cycle and webhook-driven reads [aren't repeated](protocol/github-webhook.md#reads-that-are-not-repeated).

### Webhook liveness

A silent webhook hour: `master status` cites `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

`resources` remedies: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow volume and `GRAPHYARD_DATABASE_MAX_BYTES` (10GiB); `tmp-inodes`, free `TMPDIR`/`/tmp`; `loaded-revision` counts code moves. No fault while remedy acts: owed restart retried within bound, pane unowned <10min, the loop's own lag, `/tmp` >10% free after pass within 30min.

Session-started `npm test`, `test:browser`, typecheck, `tsc --noEmit` take one of max(2, floor(GB/8)) slots (`GRAPHYARD_VERIFICATION_SLOTS`; managed root's `.verification-slots`); CI unbounded. Under max(10% RAM, 4GB) available, launches defer (`escalation:dispatch:memory`; item `memory` names top consumers; one `memory-pressure` fault per dip) until 1GB above.

## Storage retention

Receipts answer retries a day; compaction deletes past `GRAPHYARD_LEDGER_RETENTION_DAYS` (14, min 1), appending `ledger.compacted`.

## Bootstrap mode for a self-proving change

A `policy:bootstrap` holder adds `"bootstrap":{"reason":"…","contractPaths":["src/herdr/recovery.ts"]}` to criterion; other gates apply, `e2e:` proofs never defer, and the next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

Stays Done, **delivered with failure**; revert via new item, never backfill.

## Merge bypass

Ungated merges are permanent violations: repair access, file follow-up, never backfill. Admin direct-merge window: `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate [`GRAPHYARD_PRINCIPALS`](deployment.md#variables), redeploy. Operator agents hold only listed capabilities (`graphyard operator-agent setup|list|rotate|revoke`).

## Proof authority grants

```sh
graphyard grants
graphyard grants grant|revoke ci "integration:*,unit:*" REASON
```

Only `admin` grants or revokes, to `producer` principals: exact name, `kind:*` or prefix (`manual:gy-43/*`).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json` (`--apply` applies); rescans and `doctor --profile through-merge|preview-validation|production-verification` report drift, never repair.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (250) sizes batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (8; `GRAPHYARD_DATABASE_POOL_SIZE` 16, ≥2× workers) pace per token, merge path first (`observationThroughput`). Heartbeat, claim, `complete`, `blocked` own the lease pool (`leaseHealth`). Reconcile evaluates moved rows, all every `GRAPHYARD_RECONCILE_FULL_MS` (2000..300000ms, default 10000). Until startup validation ends, `/healthz` reports `readiness: false`, `/healthz?ready` 503.

### Concurrent reconciliation

A 2s tick should end within 5s, else logs `reconciliation tick took N ms` (writes, longest lock wait). It opens briefly under the coordination lock (row versions, direct-merge sweep); batches evaluate ≤250ms lock-free, planning ≤8 writes, each one transaction: coordination lock (≤500ms wait, no row held), item row (`FOR NO KEY UPDATE`), commit; moved read re-evaluates first; job wakes follow in work-id order. Three expired lock waits defer unwritten items a tick. Writes read whole only their item, overlaps and dependencies (<500ms at 1,000 items); heartbeat locks only its item. Reconciliation yields to pending requests, waiting ≤1s for renewals, before each evaluation and write: a renewal waits on ≤1 evaluation. Stale observation snapshots retry after 2s.
