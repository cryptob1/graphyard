<!-- page: Operate Graphyard | 9 | recovery procedures and limits. -->
# Operations reference

## Master coordination loop

Restart `graphyard master run` freely; it never dispatches twice. `master status` `daemon` shows health, `cycleTime` p50/p95 and `metrics.timings`; a cycle over 60 s raises `loop` attention. Log: `journalctl --user -u graphyard-master`. `run.launchConcurrency` (default 3) bounds launches.

### Perpetual master loop

`master verify-deployment GY-N` refuses a release *unobserved*, *stale* (rerun), not serving the merge, or *already recording deployment* (follow-up item).

## Lost worker before submission

A lease expires 120 seconds after the last heartbeat, or one further lease period after a recorded renewal fault; the next claim keeps the worktree. An unexplained lapse raises `lease-loss` ([classification](protocol/leases.md#how-a-lease-ends)), blocking merge until [settled](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

On the worker, `graphyard master settle-containment GY-N "reason"` verifies nothing survives but an idle pane shell. If refused, confirm the stop, then [`rework` or `recover-containment`](operations.md#recovery-recipes).

## Submitted implementation needs rework

Stop the worker, then `graphyard rework GY-N --previous-worker-stopped "reason"`. `scripts/rework-causes.mjs` classifies rework rounds by reason; `speed.reworkRounds.ownChange` excludes out-of-item causes. Measured: 55% own-change, 33% conflicts; raw median 2, 0 excluding them.

## Retro synthesis

With `GRAPHYARD_INTERVENTION_PATTERNS=1`, recurring refusal and rework causes get drafts (`retro.drafted`), never applied or filed as work: a wording update, mechanical check, producer-method correction or catalogue entry. [Approval](protocol/work-commands.md) applies one: requirements show as `retroStanding` in `graphyard status GY-N`, checks (`planned-files`, `merges-onto-base`, `checks-passed`) refuse a failing `complete` (`409`), catalogue entries classify later instances. A recurrence after application is redrafted (`recurredAfter`).

## Flaky CI check

A failing required check reruns once per sha (Actions:write), keeping position, approval and proofs, with no rework; a second failure or refusal ejects (`check.rerun.*`). `mergeQueue.rerunFailedChecks`: default 1, 0 disables.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes the gate and ejects it.

## GitHub request budget

### The live budget

`x-ratelimit-remaining`/`-reset` project `projectedExhaustionAt`.

### Observation cadence by state

| Band | Cadence |
| --- | --- |
| `merge` | within two of the queue head (or a parallel tip), passing: 20 s |
| `active` | awaiting check, review or rework: 1 min |
| `steady` | unchanged: 5 min or longer |
| `idle` | awaiting dispatch or escalation: 5 min |

Unchanged non-merge candidates spend **at most 40%** (`steadyStateShare`).

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE`, non-merge observations wait for the reset (`githubBudget.deferrals`). Each token (`githubBudget.tokens`) projected below it raises `github`.

### What an observation costs

About ten requests; unchanged, none.

### What a pause means for gates

A `403`/`429` pauses requests; gates read stale until it lifts, and nothing merges on an observation over two minutes old.

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`.

### Webhook liveness

After an hour without deliveries, check `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Per `resources` entry: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow the volume and `GRAPHYARD_DATABASE_MAX_BYTES` (unset: the readable data volume's size, else an advisory 10 GiB).

## Storage retention

- **Receipts** answer retries for one day.
- **Routine ledger rows** (`github.observed`, `heartbeat`, `reconciled`, `action.*`, `github.queue`, `session`) store only the change.
- **Compaction** deletes routine rows older than `GRAPHYARD_LEDGER_RETENTION_DAYS` (default 14, minimum 1), keeping what delivery or the flow projection needs, and logs `ledger.compacted`. Only `VACUUM FULL` frees disk.

## Bootstrap mode for a self-proving change

A `policy:bootstrap` holder adds `"bootstrap": {"reason": "…", "contractPaths": ["src/herdr/recovery.ts"]}` to the criterion. Other gates apply; `e2e:` proofs cannot be deferred; the next item touching those paths owes it (`graphyard obligations`).

## Delivered with a failed smoke proof

It stays Done, **delivered with failure**; revert through a new item, never backfill evidence.

## Merged but not deployed

An unserved merge is a `delivery.deployment-incident` ([observation](deployment.md#production-deployment-observation)) until served.

## Merge bypass

An ungated merge is a permanent violation: repair access, open a follow-up item, never backfill evidence. Admin direct-merge window: `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate `GRAPHYARD_PRINCIPALS`, redeploy. Operator agents hold only listed capabilities: `graphyard operator-agent setup|list|rotate|revoke`.

## Proof authority grants

```sh
graphyard grants
graphyard grants grant ci "integration:*,unit:*" "CI proofs"
graphyard grants revoke ci "integration:claim-safety" "Decommissioned"
```

Only an `admin` grants or revokes, to `producer` principals: exact name, `kind:*` or prefix.

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json`; `--apply` applies it. Later scans and `doctor --profile through-merge|preview-validation|production-verification` report drift, never repair it.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (default 250) sizes reconcile batches. `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (default 4, at most half the pool) pace each token's budget above the reserve to the reset, queue head first; when tight, idle items await webhooks. `observationThroughput` reports pace and head lag; `master status` raises `github` past two minutes. The lease pool serves heartbeat, claim, `complete` and `blocked`; `leaseHealth` reports heartbeat p50/p95 (raised past 5 s).

### Concurrent reconciliation

A stale snapshot retries after two seconds.
