<!-- page: Operate Graphyard | 7 | executors, GitHub. -->
# Master-agent reference

## Items, scope and human waits

Unplanned file: `scope-request GY-N EPOCH PATH… [--wait] -- REASON`; grounded requests (docs, files criteria or findings name) are auto-granted, others an approver judges, and `master scope GY-N [--allow-broad-scope] REASON` applies refused ones. Human decisions: `park GY-N EPOCH KIND NEEDED [--choice LABEL]… -- REASON` ([Needs you](dashboard.md#needs-you)), answered via `graphyard answer GY-N …`.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`. An approval must survive a base refresh ([carry rules](github.md#bindings-and-carry)). A branch must never keep another item's unlanded commits: the build gate refuses their files, and the worker restores its branch with `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, then `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

`master protection --apply` reconciles protection; where only a page exists, `master browser FLOW` drives the `master init --browser-profile` profile (`master browser app-permissions`, `master browser installation-accept`, `master browser protection`):

| Flow | Effect
| --- | ---
| `app-permissions` | Raise App permissions to declaration
| `installation-accept` | Accept pending requests
| `protection` | Reconcile branch protection

Flows read `GET /api/github/installation` and record `.graphyard/master-actions/` `record.json` and `ledger.json`. Approving a *Confirm access* GitHub Mobile code on the device is human-only. The master never stores the profile's cookies, uses a merge bypass, pushes code or reads a worker credential. If a harness classifier refuses routine administration, `master harness claude --apply` (or `master harness codex`) writes rules to `.claude/settings.local.json` denying merges, reviews, token minting and GraphQL mutations through `gh`; missing rules are `harness` drift.

## Typed actions and executors

One typed action per item (`nextAction`: `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`). `graphyard init` starts `graphyard-executor@N` user units claiming rows under their own credential (`POST /api/actions/presence`); `master executors restart` moves them to the current release. A `resync` (`POST /api/work/:id/resync`) completes only on an observation newer than its claim. Three failures with an unchanged reason mark a row stalled rather than retrying (a fleet that looks idle): in no count and no list, but in `actions.stalled` and on the item's own card; backoff never outlives it.

## Recovery

A dead supervisor fences its item; `containment` lists survivors' pid, cmdline and cwd: if `settleable`, run `master settle-containment GY-N REASON`, else stop the recorded scope unit and request `rework`. An unexplained lapsed lease raises `lease-loss` (`blocked-awaiting-operator`, `stopped-by-attestation` lapses are history); any admin settles an explained one: `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns a handler answering `master decide GY-N resolve … --context FINGERPRINT REASON`.

### Producer-runtime faults

A producer request spent with no attempt acting requests no rework; it relaunches on a profile none of them ran on.

## Fault classes

Faults carry `faultClass` (`master status` `faults`); recurring classes file one item (`GRAPHYARD_FAULT_CLASS_*`), an unanswering control plane one `plane-unavailable` fault.

## Pipeline speed

Target (ten-plus deliveries): submit→merge p50 ≤30 minutes, p90 ≤60 minutes. Row `speed`: `executionMs`, `waitMs`, `reworkRounds`, `interventions`; `speed.submitToMerge` is the verdict; `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.

The loop's decisions step stays within 10 s a cycle at about 90 open items: one `decision.*` ledger read names moved items, rereading only those. A history whose ledger has not moved is kept, not read.
