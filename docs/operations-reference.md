<!-- page: Operate Graphyard | 9 | procedures, limits. -->
# Operations reference

## Master coordination loop

`master status` `daemon`: health, `cycleTime` (30-minute p50/p95); cycles >60s raise `loop`. Log: `journalctl --user -u graphyard-master`.

### Perpetual master loop

`master verify-deployment GY-N` emits instructions from served-commit checkout, refusing *unobserved*, *stale* (rerun), merge-missing or already-recorded releases; without `--deployment-url`, newest successful [`productionEnvironment`](deployment.md#production-environment-name) deployment counts.

## Lost worker before submission

Leases expire 120s after last heartbeat (one more lease period after recorded renewal fault); next, higher-epoch claim keeps worktree. Unexplained lapses raise [`lease-loss`](protocol/leases.md#how-a-lease-ends), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

On worker, `graphyard master settle-containment GY-N "reason"` verifies nothing survives; refused: confirm stop, then [`rework`, or `recover-containment` once delivered](operations.md#recovery-recipes) ([autosettle](protocol/leases.md#watch)).

## Submitted implementation needs rework

Stop worker; `graphyard rework GY-N --previous-worker-stopped "reason"`; next resubmits. `scripts/rework-causes.mjs` classifies last 100 deliveries' rounds (55% own-change, 33% conflicts; raw median 2); `master status` `speed.reworkRounds.ownChange` excludes out-of-item causes.

## Retro synthesis

Minutely scan (`GET /api/interventions` → `scan`; `GRAPHYARD_INTERVENTION_PATTERNS=0` disables) files item per crossed pattern, drafting `retro.drafted` changes per recurring refusal or rework cause; a non-drafting operator agent [approves](protocol/work-commands.md) (`decision:approve`)/refuses each. Approved: [`retroStanding`](protocol/read-endpoints.md) in `graphyard status GY-N`; checks refuse failing `complete`.

## Flaky CI check

[Reruns once](github.md#failed-checks) (`mergeQueue.rerunFailedChecks`, 0 disables); pass clears it. On main, no later merge is judged until reruns conclude. Cancelled or timed-out jobs rerun up to 3 times; then one `escalation:main-guard:SHA` infrastructure fault names run and step, reverting nothing. A real failure reruns once: a pass joins `mainGuardFlakes` (last 20); a second failure, refusal or hour without conclusion reverts.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes gate; that head's required checks no longer pass.

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

A `403`/`429` pause stops requests; gates read the last observation until it lifts; GitHub merges on branch protection, recorded on resume ([prioritized wakes](protocol/github-webhook.md#prioritized-wakes)).

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `billable` (also `master status`): REST-only `perHour` across replicas (`instances`), `limit`, `share`, `target` 0.6, `byEndpoint`. Immutable, per-cycle, webhook-driven reads [aren't repeated](protocol/github-webhook.md#reads-that-are-not-repeated).

### Webhook liveness

Silent webhook hour: `master status` cites `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

`resources` remedies: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow volume+`GRAPHYARD_DATABASE_MAX_BYTES` (10GiB); `tmp-inodes[:ROOT]`, one per `TMPDIR`/`/tmp` filesystem (<25% free: pass escalates, names root's consumers, flags partial census); `loaded-revision` counts code moves. No fault while remedy acts: owed restart within bound, pane unowned <10min (unnamed pane: reclaim pass's clock, kept through failed close), `/tmp` >10% free post-pass within 30min, unless a 0-removal pass named consumers. Loop age: host clock.

Session-started `npm test`, `test:browser`, typecheck, `tsc --noEmit` take one of max(2, floor(GB/8)) slots (`GRAPHYARD_VERIFICATION_SLOTS`; managed root's `.verification-slots`); CI unbounded. Under max(10% RAM, 4GB) available, launches defer (`escalation:dispatch:memory`; one `memory-pressure` fault per dip) until 1GB above.

## Storage retention

Receipts answer retries day; compaction deletes past `GRAPHYARD_LEDGER_RETENTION_DAYS` (14, min 1), appending `ledger.compacted`.

## Bootstrap mode for a self-proving change

`policy:bootstrap` holders add `"bootstrap":{"reason":"…","contractPaths":["src/herdr/recovery.ts"]}` to criterion; other gates apply, `e2e:` proofs never defer, next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

Stays Done, **delivered with failure**; revert via new item.

## Merge bypass

Ungated merges: permanent violations (never backfilled): repair access, file follow-up. Admin direct-merge window: `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate [`GRAPHYARD_PRINCIPALS`](deployment.md#variables), redeploy. Operator agents hold only listed capabilities (`graphyard operator-agent setup|list|rotate|revoke`).

## Proof authority grants

```sh
graphyard grants
graphyard grants grant|revoke ci "integration:*,unit:*" REASON
```

Only `admin` grants/revokes, to `producer` principals: exact name, `kind:*` or prefix (`manual:gy-43/*`).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json` (`--apply` applies); rescans and `doctor --profile through-merge|preview-validation|production-verification` report drift, never repair.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (250) sizes batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (8; `GRAPHYARD_DATABASE_POOL_SIZE` 16, ≥2× workers) pace per token, merge path first (`observationThroughput`). Heartbeat, claim, `complete`, `blocked` own a lease pool (`leaseHealth`). Reconcile evaluates moved rows, all every `GRAPHYARD_RECONCILE_FULL_MS` (10000). Until startup validation ends, `/healthz` reports `readiness: false`, `/healthz?ready` 503.

### Concurrent reconciliation

A 2s tick over 5s logs `reconciliation tick took N ms`. Batches evaluate lock-free, then write each item in its own transaction under the coordination and row locks; expired lock waits defer unwritten items. Heartbeats lock only their item; renewal waits ≤1s.
