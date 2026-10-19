<!-- page: Operate Graphyard | 9 | procedures, limits. -->
# Operations reference

## Master coordination loop

`master status` `daemon`: health, `cycleTime` (30-minute p50/p95); cycles >60s raise `loop`. Wakes dismiss autocompact suggestions (`esc`/"Not now"), re-read; unconfirmed/unanswerable dialogs hold (`wake:master:held`). `daemon.stepStalls`: 3-cycle signatures: one verified remedy (unknown-profile/401/merge-key-reuse), else master wake; 5min retries.

### Dispatch order

Within a priority: a submitted attempt (returned rework) precedes unsubmitted items, ahead of starvation/cold/scope; `master status`'s schedule follows.

### Perpetual master loop

Release health is one status line; without `--deployment-url`, newest successful [`productionEnvironment`](deployment.md#production-environment-name) deployment counts.

## Lost worker before submission

Leases expire 120s after last heartbeat (recorded renewal fault, plane stall: 30s `stallRenewalWindowMs`, not another lease period); higher-epoch claim keeps worktree. Unexplained lapses raise [`lease-loss`](protocol/leases.md#how-a-lease-ends), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

[`master settle-containment`](operations.md#recovery-recipes) verifies nothing survives; refused: confirm stop, then rework, or `recover-containment` once delivered ([autosettle](protocol/leases.md#watch)).

## Submitted implementation needs rework

Stop worker; [rework](operations.md) `--previous-worker-stopped`; next resubmits. `scripts/rework-causes.mjs` classifies 100 deliveries' rounds (55% own-change/33% conflicts; raw median 2); `speed.reworkRounds.ownChange` excludes out-of-item causes.

## Base-sync conflicts

`graphyard sync GY-N` resolves a conflicted `tests/helpers/timing-baseline.json`: base tip's file plus branch test-file lines, staged under `regenerated`.

## Retro synthesis

Minutely scan (`GET /api/interventions` → `scan`; `GRAPHYARD_INTERVENTION_PATTERNS=0` disables) raises each crossed pattern as attention, never an item, drafting `retro.drafted` changes per recurring cause; a non-drafting operator agent [approves](protocol/work-commands.md) (`decision:approve`)/refuses; approved: [`retroStanding`](protocol/read-endpoints.md).

## Flaky test

The merge writer reruns a trial's failing files on the same merge commit; a pass on the rerun lands, filing nothing. No CI check or job log is read (GY-2010).

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes gate; that head's required checks stop passing.

## Observation

Graphyard observes no pull request, check run or commit status through GitHub's API (directly or through `gh api`), so there is no request budget, rate-limit pause, webhook or observation cadence to read. Every candidate is observed from the shared checkout; the merge writer's ledger decides the test and merge gates. Diagnostician/doctor read `graphyard status GY-N`, not `gh pr view`.

## Control-plane resources

`resources` remedies: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow volume+`GRAPHYARD_DATABASE_MAX_BYTES` (10GiB); `tmp-inodes[:ROOT]`, per `TMPDIR`/`/tmp` (any checkout/worktree unheld/unregistered 24h; <25% free: escalates, naming consumers; foreign-namespace markers judge ownerless, 6h unheld, preview checkouts too, GY-1896); `loaded-revision`: code moves. No fault: owed restart within bound, pane unowned <10min, `/tmp` >10% free <30min past a ≥25% pass.

Session-started `npm test`/`test:browser`/typecheck/`tsc --noEmit` take one of max(2, floor(GB/8)) slots (`GRAPHYARD_VERIFICATION_SLOTS`). Under max(10% RAM, 4GB) available, launches defer (`escalation:dispatch:memory`; one fault/dip) until 1GB above.

## Storage retention

Compaction deletes past `GRAPHYARD_LEDGER_RETENTION_DAYS` (14), appending `ledger.compacted`.

## Bootstrap mode for a self-proving change

`policy:bootstrap` holders add `"bootstrap":{"reason":"…","contractPaths":["src/herdr/recovery.ts"]}` to criterion; `e2e:` proofs never defer, next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

Stays Done and delivered; fix forward in a follow-up item.

## Merge bypass

Ungated merges are permanent violations: repair access, file follow-up. Admin direct-merge window: `graphyard operator direct-merges on --since ISO REASON`.

## Merge-intent withdrawal

No pull request is queued or armed, so there is nothing to withdraw: the [merge writer](delivery-redesign.md#merge-writer) pushes the base itself; with automatic merging off each merge is a [two-party decision](glossary.md#who-decides), and `master withdraw GY-N DECISION REASON` takes one back.

## Credentials

Rotate [`GRAPHYARD_PRINCIPALS`](deployment.md#variables), redeploy. Operator agents hold only listed capabilities (`graphyard operator-agent setup|list|rotate|revoke`); `setup` reinstates a revoked ID.

## Proof authority grants

```sh
graphyard grants
graphyard grants grant|revoke ci "integration:*,unit:*" REASON
```

Only `admin` grants/revokes, to `producer` principals: exact name, `kind:*` or prefix (`manual:gy-43/*`).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json`; rescans and `doctor --profile through-merge|preview-validation|production-verification` report drift, never repair.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (250) sizes batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (8; `GRAPHYARD_DATABASE_POOL_SIZE` 16, ≥2× workers) pace per token, merge path first (`observationThroughput`). Heartbeat/claim/`complete`/`blocked` own a lease pool.

### Concurrent reconciliation

Reconcile evaluates moved rows, due-past items, and each moved fleet face's item plus readers; empty views, configuration changes, ≥ max(`GRAPHYARD_RECONCILE_FULL_MS` (300000), 3× length) run full. Batches evaluate lock-free, write under coordination+row locks; heartbeats lock their item.
