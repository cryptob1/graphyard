<!-- page: Operate Graphyard | 9 | every recovery procedure and limit. -->
# Operations reference

## Master coordination loop

Restart `graphyard master run` freely: it never dispatches twice. `master status` → `daemon` gives health; `journalctl --user -u graphyard-master` the log. `daemon.metrics.timings` and status `timings` time steps and calls over 1s; logs name slowest; status reads a cached intervention report.

### Perpetual master loop

`master verify-deployment GY-N` refuses a release that is *unobserved* (set `--deployment-url`), *stale* (rerun), not yet serving the merge (keep cycling), or *already records deployment* (use a follow-up item).

Between cycles, a verified deployment moves a clean, detached loop checkout to the base tip (otherwise: an `upgrade` attention item). Code changes (`src/`, `scripts/`, `bin/`, `package.json`) restart the executors, then the loop via systemd. `master status` → `releaseLag` compares each process's startup release with the base tip, flagging >1 delivery behind for 10 minutes.

## Lost worker before submission

The next claim gets a higher epoch, keeping the old worktree. An unexplained lapse raises `lease-loss` ([classification](protocol/leases.md#how-a-lease-ends)), blocking merge until settled ([settling](delegation.md#who-may-settle-what)).

## Supervisor died leaving a containment quarantine

On the worker's machine, `graphyard master settle-containment GY-N "reason"` verifies no process survives (`containment.held` lists them). If refused, confirm the stop, then `graphyard rework GY-N --previous-worker-stopped "reason"`, or `graphyard recover-containment` likewise once delivered.

## Submitted implementation needs rework

Stop the worker, then `graphyard rework GY-N --previous-worker-stopped "reason"`; the next worker resubmits the same PR.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` ([body](protocol/evidence.md#revocation)) closes the gate at once; the queue ejects the entry.

## GitHub request budget

Observation spends the App's hourly limit, webhook-first.

### The live budget

The `x-ratelimit-remaining`, `-limit` and `-reset` headers project exhaustion (`projectedExhaustionAt`).

### Observation cadence by state

| Band | State | Cadence |
| --- | --- | --- |
| `merge` | queue head, or all other gates pass | 20 seconds |
| `active` | waiting on a check, review, base refresh or rework | 1 minute |
| `steady` | unchanged since last observation | 5 minutes, stretched by the fleet bound |
| `idle` | next action: dispatch or escalation | 5 minutes, stretched when unchanged |

Unchanged non-merge candidates together spend **at most 40%** (`steadyStateShare`) of the hourly limit.

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE` on the deployment, non-merge observations wait for the reset (`githubBudget.deferrals`).

### What an observation costs

About ten requests uncached; unchanged, none.

### What a pause means for gates

A rate-limit `403`/`429` pauses all requests until the reset; gates read stale until it lifts: nothing merges on observations over two minutes old.

### Reading the budget

`graphyard status` (or `GET /api/status`) → `githubBudget`; `master status` attention items with subject `github`.

### Webhook liveness

After an hour without deliveries, `master status` points to `https://github.com/settings/apps/APP-SLUG`.

## Control-plane resources

Per `resources` entry: ledgers, `graphyard master run --once`; `agent-names:PROFILE`, `herdr pane close PANE`; `session-slots:ROLE`, raise `concurrency`; `database-capacity`, grow the volume and `GRAPHYARD_DATABASE_MAX_BYTES`.

## Bootstrap mode for a self-proving change

A change shipping its own proof harness cannot prove itself: a `policy:bootstrap` holder adds `"bootstrap": {"reason": "…", "contractPaths": ["src/herdr/recovery.ts"]}` to that criterion. Other gates apply; `e2e:` proofs cannot be deferred; the next item touching those paths owes the proof (`graphyard obligations`).

## Delivered with a failed smoke proof

The item stays Done, marked **delivered with failure**. Revert through a new item; never backfill evidence.

## Merged but not deployed

An unserved merge is a `delivery.deployment-incident` ([observation](deployment.md#production-deployment-observation)): fix the deployment; it recovers once a release serves the merge.

## Merge bypass

An ungated merge is a permanent violation: never backfill evidence; repair access and open a follow-up item. An admin opens a deliberate direct-merge window: `graphyard operator direct-merges on --since ISO REASON`.

## Credentials

Rotate principals in `GRAPHYARD_PRINCIPALS` and redeploy. Operator agents hold only listed capabilities: `graphyard operator-agent setup|list|rotate|revoke`.

## Proof authority grants

```sh
graphyard grants                                   # live authority
graphyard grants grant ci "integration:*,unit:*" "CI proves integration and unit"
graphyard grants revoke ci "integration:claim-safety" "Runner decommissioned"
```

Only an `admin` grants or revokes, only to `producer` principals. A pattern is an exact name, `kind:*`, or a prefix like `manual:gy-43/*`.

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json`; `--apply` applies exactly it. Later scans and `doctor --profile through-merge|preview-validation|production-verification` report drift, never repairing it.

## Scale limits

Four provider jobs per tick per replica; watch lock wait, job lag and request budget.

### Concurrent reconciliation

A stale observation snapshot is retried after two seconds.
