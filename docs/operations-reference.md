<!-- page: Operate Graphyard | 9 | procedures, limits. -->
# Operations reference

## Master coordination loop

`master status` `daemon`: health, `cycleTime` (30-minute p50/p95); cycles >60s raise `loop`.

### Perpetual master loop

`master verify-deployment GY-N` emits instructions, refusing *unobserved*, *stale* (rerun), merge-missing or recorded releases; without `--deployment-url`, newest successful [`productionEnvironment`](deployment.md#production-environment-name) deployment counts.

## Lost worker before submission

Leases expire 120s after last heartbeat (recorded renewal fault, plane stall: 30s `stallRenewalWindowMs`, not another lease period); higher-epoch claim keeps worktree. Unexplained lapses raise [`lease-loss`](protocol/leases.md#how-a-lease-ends), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

[`master settle-containment`](operations.md#recovery-recipes) verifies nothing survives; refused: confirm stop, then rework, or `recover-containment` once delivered ([autosettle](protocol/leases.md#watch)).

## Submitted implementation needs rework

Stop worker; [rework](operations.md) `--previous-worker-stopped`; next resubmits. `scripts/rework-causes.mjs` classifies last 100 deliveries' rounds (55% own-change, 33% conflicts; raw median 2); `master status` `speed.reworkRounds.ownChange` excludes out-of-item causes.

## Retro synthesis

Minutely scan (`GET /api/interventions` → `scan`; `GRAPHYARD_INTERVENTION_PATTERNS=0` disables) files item per crossed pattern, drafting `retro.drafted` changes per recurring refusal/rework cause; a non-drafting operator agent [approves](protocol/work-commands.md) (`decision:approve`)/refuses each. Approved: [`retroStanding`](protocol/read-endpoints.md) in `graphyard status GY-N`.

## Flaky CI check

[Reruns once](github.md#failed-checks) (`mergeQueue.rerunFailedChecks`, 0 disables); a pass clears it; main merges wait for reruns. Cancelled/timed-out jobs rerun ≤3 times, then one `escalation:main-guard:SHA` infrastructure fault names run and step, reverting nothing. A real failure reruns once: a pass joins `mainGuardFlakes` (last 20); a second failure, refusal or unconcluded hour reverts.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes gate; that head's required checks stop passing.

## GitHub request budget

### The live budget

`x-ratelimit-remaining`/`-limit`/`-reset` project `projectedExhaustionAt`.

### Observation cadence by state

| Band | Cadence
| --- | ---
| `merge` | gates pass: 20s
| `active` | awaiting check/review/refresh/rework: 1min
| `steady` | unchanged: 5min, stretched by fleet bound; review requests ≤10min
| `idle` | awaiting dispatch/escalation: 5min, stretched

Unchanged non-merge candidates spend **at most 40%** (`steadyStateShare`).

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations await reset (`githubBudget.deferrals`); token (`githubBudget.tokens`) projected below reserve at reset raises `github`.

### What an observation costs

~10 requests uncached; unchanged, none.

### What a pause means for gates

`403`/`429` pauses stop requests; gates read the last observation until it lifts; GitHub merges on branch protection ([prioritized wakes](protocol/github-webhook.md#prioritized-wakes)).

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `billable` (also `master status`): REST-only `perHour` across replicas (`instances`), `limit`/`share`/`target` 0.6/`byEndpoint`; `lastHour` (also `master status`): hourly requests by kind. Immutable, per-cycle, webhook-driven reads [aren't repeated](protocol/github-webhook.md#reads-that-are-not-repeated).

### Reading under control-plane

`master merger control-plane`: control-plane-observed candidates are observed from its checkout, GitHub polled for none of their pull request, reviews or checks; a person-opened one is still observed. Diagnostician and doctor read `graphyard status GY-N`, not `gh pr view`.

### Webhook liveness

`webhooks` checks receipts against GitHub's delivery log (cached 5min/15; merged by delivery id into persisted 48h attempts): `lastAttemptAt`/`windowSince`/`coveredFrom`/`attemptsInWindow`/`failedAttempts`/`failedStatusCodes`/`deliveryLogAt`/`deliveryLogError`. `state`: `delivering` (<1h), `failing` (non-2xx; proved-foreign 403 excused), `quiet`, `answered` (2xx), `unverified` (read failed/`coveredFrom` after `windowSince`). Open PRs cite `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

`resources` remedies: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow volume+`GRAPHYARD_DATABASE_MAX_BYTES` (10GiB); `tmp-inodes[:ROOT]`, per `TMPDIR`/`/tmp` (any-name checkout/worktree unheld and unregistered 24h; <25% free: escalates, naming consumers); `loaded-revision`: code moves. No fault: owed restart within bound, pane unowned <10min, `/tmp` >10% free <30min past a ≥25% pass.

Session-started `npm test`/`test:browser`/typecheck/`tsc --noEmit` take one of max(2, floor(GB/8)) slots (`GRAPHYARD_VERIFICATION_SLOTS`). Under max(10% RAM, 4GB) available, launches defer (`escalation:dispatch:memory`; one fault per dip) until 1GB above.

## Storage retention

Compaction deletes past `GRAPHYARD_LEDGER_RETENTION_DAYS` (14), appending `ledger.compacted`.

## Bootstrap mode for a self-proving change

`policy:bootstrap` holders add `"bootstrap":{"reason":"…","contractPaths":["src/herdr/recovery.ts"]}` to criterion; `e2e:` proofs never defer, next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

Stays Done, **delivered with failure**; revert via new item.

## Merge bypass

Ungated merges are permanent violations: repair access, file follow-up. Admin direct-merge window: `graphyard operator direct-merges on --since ISO REASON`.

## Merge-intent withdrawal

`graphyard master withdraw [--repo OWNER/NAME] [--apply] [--json] --admin-token-stdin` (admin, loop stopped, managed repository only) dequeues or disarms each item's unmerged pull request, reporting number, head, mode, result; reruns write nothing; failures exit 1; without `--apply`, plans.

## Credentials

Rotate [`GRAPHYARD_PRINCIPALS`](deployment.md#variables), redeploy. Operator agents hold only listed capabilities (`graphyard operator-agent setup|list|rotate|revoke`); `setup` reinstates a revoked ID (`lastMutation.reinstatedAfter`).

## Proof authority grants

```sh
graphyard grants
graphyard grants grant|revoke ci "integration:*,unit:*" REASON
```

Only `admin` grants/revokes, to `producer` principals: exact name, `kind:*` or prefix (`manual:gy-43/*`).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json`; rescans and `doctor --profile through-merge|preview-validation|production-verification` report drift, never repair.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (250) sizes batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (8; `GRAPHYARD_DATABASE_POOL_SIZE` 16, ≥2× workers) pace per token, merge path first (`observationThroughput`). Heartbeat/claim/`complete`/`blocked` own a lease pool (`leaseHealth`). During startup validation `/healthz` reports `readiness: false`, `/healthz?ready` 503.

### Concurrent reconciliation

Reconcile evaluates moved rows, all ≥ max(`GRAPHYARD_RECONCILE_FULL_MS` (10000), 3× last full pass); ticks >5s log `reconciliation tick took N ms`: moved key+fields/interval, event-loop lag p50/max. Batches evaluate lock-free, writing each under coordination+row locks; heartbeats lock only their item.
