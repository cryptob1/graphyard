<!-- page: Operate Graphyard | 7 | every procedure in full, credentials, proof authority, drift, and scale limits. -->
# Operations reference

The detail behind the [operations page](operations.md). Terms follow the [glossary](glossary.md).

## Perpetual master loop

Keep a master coordinator cycling (status, dispatch, review and proof, guarded merge,
deployment verification) until (1) every in-scope item is Done or has a genuinely external
blocker recorded in Graphyard, and (2) every merged change is deployed and live-verified against
the exact deployed release, or a deployment blocker is recorded as a follow-up item naming the
delivered item, its merge commit and the external cause. Review findings, rework, idle workers
and proof setup are not stopping conditions.

Verify each delivery with `master verify-deployment GY-N` after the merge. Refusals:
*unobserved* (configure `master init --deployment-url` or wait), *stale* (rerun), *does not serve
the merge yet* (keep cycling), *local checkout* (check out the deployed commit cleanly),
*already records deployment* (use a follow-up item).

## Master coordination loop

`graphyard master run` is the durable coordinator; run it under systemd or Herdr
([`examples/master/graphyard-master.service`](../examples/master/graphyard-master.service),
[durable loop](master-agent.md#durable-loop)).

- **Health:** `master status` → `daemon` (`running`, `lagMs`, `unresolved`, `escalations`);
  `journalctl --user -u graphyard-master` has the log.
- **Restart** freely; never edit the cursor file. A second loop refuses while the first lives; a
  lost host's lock clears after three intervals.
- **Stuck at a stage:** the loop holds only the coordinator credential; see `escalations`.
- **Deployment lag:** `daemon.deployment` lists `pending` deliveries; `unavailable` means no probe answered.
- **Post-deploy proof:** with `deploySmoke`, `delivered` shows `awaiting-deployment`,
  `awaiting-smoke`, `smoke-passed` or `delivered-with-failure`.
- **Worker profiles:** a failed launch cools a profile for ten minutes (`daemon.profiles`).
- **GitHub administration:** `administration` shows audit entries and any *Confirm access*
  code; records are under `.graphyard/master-actions/`.

## Daily checks

- `/healthz` returns `healthy: true` with the expected `commit` and schema.
- `master status` → `resources.summary` within warning lines.
- `/api/status`: no persistent job errors, `delegationLimits.attention` or `production.incidents`.
- Backups verified periodically ([backup, upgrade, rollback](deployment.md#backup-upgrade-rollback)).

## Lost worker before submission

The lease expires after 120 seconds without a heartbeat; a new worker claims with a higher
epoch. Keep the old worktree; use a new branch and path. A lapse explained by a `blocked` report
or a `--previous-worker-stopped` attestation is plain history; an unexplained one raises
`lease-loss`, which blocks merge. Settle it with
`graphyard resolve GY-N lease-loss --attestation stopped-worker|blocked "reason"`
([who may settle what](delegation.md#who-may-settle-what)).

## Supervisor died leaving a containment quarantine

The fence stays up on purpose. On the worker's machine run
`graphyard master settle-containment GY-N "reason"`; it verifies the lease and launch authority
expired and no process survives (`master status` → `containment.held` lists survivors). If it
refuses or the host is unreachable, confirm the stop yourself, then
`graphyard rework GY-N --previous-worker-stopped "reason"` (undelivered) or
`graphyard recover-containment GY-N --previous-worker-stopped "reason"` (delivered). Never attest
a stop you have not confirmed.

## Blocked item with no owner

`graphyard unblock GY-N "reason"` clears a blocker; `graphyard ready GY-N "reason"` releases
backlog work. An escalation is cleared per trigger with `graphyard resolve GY-N TRIGGER "reason"`
by a `sessionKind: "human"` credential (the `lease-loss` citation above excepted).
`security-concern`, `requirement-weakening` and `evidence-policy-conflict` stay human-only.

## Submitted implementation needs rework

The active owner may push more commits. To reassign: stop the worker, then
`graphyard rework GY-N --previous-worker-stopped "reason"`. A new worker claims with a higher
epoch, registers the existing PR branch in a fresh workspace, and resubmits the same PR. Merged
work needs a follow-up item.

## Accepted evidence turns out to be wrong

```sh
cat > revoke.json <<'JSON'
{ "proof": "integration:claim-safety", "sha": "HEAD_SHA", "baseSha": "BASE_SHA", "policyRevision": 1,
  "reason": "Producer retracted the reported run" }
JSON
graphyard revoke GY-N revoke.json
```

Run as `admin` or the producer whose [grant](#proof-authority-grants) covers the proof. The gate
closes at once, merge authorization drops and the [merge queue](github.md#merge-queue) ejects the
entry; a new candidate is what lands. Delivered work needs a follow-up item.

## Worktree creation failed

The reservation is retained. Inspect Git state; use a new attempt and path if ownership expired.
Never bulk-delete worktrees on worker machines.

## GitHub job fails

Jobs retry after 45 seconds; expired job leases recover after 90. Check installation access,
protection and the registered branch. A missing [App permission](github.md#app-permissions) holds
the jobs that need it (`diagnose GY-N` shows `integration-held`); accept it with
`github-setup --update-permissions` ([migration](github.md#migrating-an-existing-app)) and the next
preflight releases them.

## GitHub request budget

Observation spends the App installation's hourly limit by state, webhook-first.

### The live budget

From `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset` the plane tracks
remaining requests, reset, `perMinute`, `projectedExhaustionAt` and `exhaustsBeforeReset`. `304`
answers are free. `master status` warns when the projection lands before the reset.

### Observation cadence by state

| Band | State | Cadence |
| --- | --- | --- |
| `merge` | heads the merge queue or passes every other gate | 20 seconds at the head |
| `active` | waiting on a check, review or base refresh | 5 minutes |
| `steady` | active and unchanged since the last observation | 5 minutes, stretched by the fleet bound |
| `idle` | next action is dispatch, rework or escalation | 5 minutes, stretched when unchanged |

Webhooks wake the named jobs at once. Unchanged non-merge candidates together spend
**at most 40%** (`steadyStateShare`) of the hourly limit.

### The merge-path reserve

Below **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE` on the deployment, non-merge
observations are deferred past the reset (`githubBudget.deferrals`); merge candidates, webhook
wakes and merge verification continue.

### What an observation costs

About ten requests uncached; unchanged candidates usually cost none thanks to `ETag`s
(`githubBudget.observations.meanRequests`).

### What a pause means for gates

A rate-limit `403`/`429` pauses every request until the reset. `master status` shows one
attention item: requests are paused, until when, what spent the budget, and that
gates read stale until it lifts. Nothing merges on observations older than two minutes.

### Reading the budget

- `graphyard status` (or `GET /api/status`) → `githubBudget`: `remaining`, `limit`, `resetAt`,
  `perMinute`, `projectedExhaustionAt`, `reserve`, `paused`, `steadyState`, `deferrals`.
- `master status` → attention items with subject `github`.

### Webhook liveness

`/api/status` → `webhooks` (`lastDeliveryAt`, `lastHour`). With no delivery for an hour while PRs
are open, `master status` names the App settings page (`https://github.com/settings/apps/APP-SLUG`)
and the URL `https://YOUR-HOST/api/github/webhook`.

## Control-plane resources

`master status` → `resources.summary` and `resources.readings`; the registry is in the
[master-agent guide](master-agent.md#resource-observation).

- **`review-ledger` / `producer-ledger`:** `graphyard master run --once` reclaims settled records.
- **`agent-names:PROFILE`:** confirm the finished pane posted its result, then `herdr pane close PANE`.
- **`session-slots:ROLE`:** raise `concurrency` or add a profile in `.graphyard/master.json`.
- **`github-budget`:** wait for the reset; merges need fresh observations.
- **`executor-liveness` / `loaded-revision`:** `graphyard master restart`.
- **`database-capacity`:** grow the volume, raise `GRAPHYARD_DATABASE_MAX_BYTES`.
- **`worktree-disk`:** see [worktree disk](master-agent.md#worktree-disk).

`/healthz` `healthy: false` lists `causes` (writes refused, or a resource at its bound); the loop
dispatches nothing until healthy. Alert on `/healthz?strict` (503).

## GitHub or Graphyard outage

The merge gate refuses observations older than two minutes. A direct GitHub merge cannot complete
its work item; restrict other merge identities in repository rules.

## Bootstrap mode for a self-proving change

When a change introduces the harness its own proof needs, the human operator marks that one
criterion (requires `policy:bootstrap`):

```json
{
  "expectedPolicyRevision": 3,
  "reason": "The herdr-recovery harness ships in this change",
  "criteria": [
    {"id": "AC-1", "text": "Herdr recovery is proven end to end", "proofs": ["integration:herdr-recovery"],
     "bootstrap": {"reason": "This candidate introduces the harness the proof needs",
                   "contractPaths": ["src/herdr/recovery.ts"]}}
  ],
  "dependencies": [],
  "plannedFiles": ["src/herdr/", "tests/"],
  "exclusiveResources": []
}
```

Apply with `graphyard requirements GY-N revision.json`. `e2e:` proofs cannot be deferred. Review,
checks and other proofs stay in force. The deferred proof becomes an obligation inherited by the
next item touching the contract paths; list them with `graphyard obligations`.

## Delivered with a failed smoke proof

The item stays Done, marked **delivered with failure**, with `rollback` guidance in `master
status`. Roll back the deployment or revert through a new work item; never backfill evidence.
Graphyard does not execute rollbacks itself.

## Merged but not deployed

A merge production never served becomes a `delivery.deployment-incident`
([observation](deployment.md#production-deployment-observation)). Read the provider's failure,
fix the deployment (e.g. `set GRAPHYARD_MAX_REVIEWERS=4 on the deployment`), and the incident
recovers when a release serves the merge. `deploy main first` from `master merge` means deploy
main and retry.

## Capacity variables no longer cover the principals

`delegationLimits.attention` names the variable and value; set it and redeploy. Only a principal
added beyond an explicit limit refuses start-up.

## Merge bypass

An ungated merge is a permanent violation. Never backfill evidence; repair access rules and
create a follow-up item.

## Credentials

Add or rotate principals in `GRAPHYARD_PRINCIPALS`, then redeploy; use a unique ID and secret per
principal. Scoped operator agents use the [credential registry](operator-automation.md), never an
`admin` entry. The `coordinator` credential may only read, run the bounded merge, settle verified
containment and record deployment observations. If a secret is committed, revoke it first.

## Proof authority grants

```
graphyard grants                                   # live authority per principal
graphyard grants grant ci "integration:*,unit:*" "CI runner produces integration and unit proof"
graphyard grants grant witness "manual:gy-43/*" "Designated acceptance witness for GY-43"
graphyard grants revoke ci "integration:claim-safety" "Runner decommissioned"
graphyard grants history ci
```

Only an `admin` grants or revokes. Patterns: an exact name, `kind:*`, or `manual:gy-43/*`.
`worker`, `reader`, `coordinator` and `operator-agent` principals can never hold a grant.
`GRAPHYARD_PRINCIPALS[].proofs` only seeds grants once; the grant ledger then decides.

## Readiness checklist per completion profile

`graphyard doctor --profile through-merge|preview-validation|production-verification` lists each
requirement with what was observed and the command that fixes a `missing` or `unknown` item.
`unknown` is never `ready`.

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json` (checks, commands, proofs,
environment topology, profiles, App registration) and changes nothing else.
`graphyard init --scan --apply` applies exactly the reviewed proposal, idempotently, and refuses
if the repository changed since. Drift is reported by later scans and `doctor`, never auto-repaired.

## Scale limits

Four provider jobs per tick per replica; the event API returns the latest 300 events. Watch
latency, lock wait, job lag and the [GitHub request budget](#github-request-budget) before scaling.

### Concurrent reconciliation

A stale snapshot during observation is rejected and retried after two seconds; it is not shown as
an integration error.

## Coordination diagnosis and recovery drills

Use `graphyard diagnose GY-N`; see [coordination](coordination.md).
