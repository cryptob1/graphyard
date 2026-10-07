<!-- page: Operate Graphyard | 7 | executors, GitHub administration. -->
# Master-agent reference

## Items, scope and human waits

Unplanned file: `scope-request GY-N EPOCH PATH… [--wait] -- REASON` (flags before `--` refused). Auto-granted if grounded: docs; files criteria or follow-ups name; `web/`/`browser-tests/` for `docs/`-planning items; files review findings name; tests pinning planned text; symbol definitions; successors; companions (docs-budget gate, timing baseline, importing tests, planned modules' imports and importers). An `approve-scope` executor or the loop decides (standing decisions replay), else approvers judge (a partial grant's rest: same cycle). `master scope GY-N [--allow-broad-scope] REASON` applies refused requests save one the approver holds (routed, or refused <15 min ago: `master decisions`); leases stay (`--wait` reads it). Ending attempts (submit, release, lapse, rework, requirements) close open/refused requests (`attempt ended`); `master unblock GY-N` closes stale ones. Human decisions: `park GY-N EPOCH KIND NEEDED --ask ASK [--step STEP]… --recommend TEXT --why WHY [--choice LABEL]… -- REASON` ([Needs you](dashboard.md#needs-you), `answer`); refused if host-doable ([deployment](deployment.md)).

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`.

### Base refreshes and branch protection

**An approval must survive a base refresh.** [Carry rules](github.md#bindings-and-carry) apply.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** Only a current-head approval dismissed with `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`); its re-post is no new verdict (`observation.dismissedReviewIds`).

**A branch must never keep another item's unlanded commits.** The build gate refuses their files as out-of-scope regressions; a worker restores its own branch: `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, then `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

`master protection --apply` reconciles protection; where only a page exists, `master browser FLOW` drives the `master init --browser-profile` profile (`master browser app-permissions`, `master browser installation-accept`, `master browser protection`):

| Flow | Effect
| --- | ---
| `app-permissions` | Raise App permissions to declaration
| `installation-accept` | Accept pending requests
| `protection` | Reconcile branch protection

Flows read `GET /api/github/installation` (App credential) and record `.graphyard/master-actions/` `record.json`, `ledger.json`. Approving a *Confirm access* GitHub Mobile code on the device is human-only. The master never stores the profile's cookies, uses a merge bypass, pushes code or reads a worker credential.

If a harness classifier refuses administration, `master harness claude --apply` (Codex: `master harness codex`) writes rules to `.claude/settings.local.json`.

Denied, by endpoint: `gh pr merge`/`review`, `gh api` `pulls/N/merge`, `repos/R/merges`, `merge-upstream`, `pulls/N/reviews`, `access_tokens`, `PUT`/`POST`/`DELETE`; `gh api graphql` with `mutation` (merge, enqueue, auto-merge, approval) or `=@`/`--input`.

Missing/retired rules (`gh api *merge*`, `gh api graphql*`) are `harness` drift; `master status` reapplies it, reporting only unrepaired drift.

## Typed actions and executors

One typed action per item (`nextAction`: `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`); `escalate` and `request-rework` are judgements (`actions.needsHuman`). `graphyard init` starts `graphyard-executor@N` user units, claiming rows under their own credential; `master executors restart` moves them to the current release. Verified deployments move clean checkouts to the base tip, restart executors, then the loop (`upgrade` attention if dirty). A fenced executor (`POST /api/actions/presence`) or one renewing a claim still counts as alive, never reading as `Nothing can run KIND`. Every poll and renewal upserts the executor's row in `executor_presence` (never an event), so a redeployed control plane reads the fleet at once; an empty fleet is judged only on evidence — a poll heard, or rows in that table older than the 120s window (an empty table counts once recording that long, per its first read's marker) — never by process age.

A `resync` (`POST /api/work/:id/resync` `{ since }`) completes only on an observation newer than its claim.

A `dispatch` or `request-review` finding a session already answering the head completes on it; standing verdicts block a second reviewer until dismissed; busy or reserved worker profiles wait 30 minutes before stalling. Three failures with an unchanged reason mark a row stalled rather than retrying (a fleet that looks idle): in no count and no list, but in `actions.stalled` and on the item's own card; backoff never outlives it; eight escalate it. Ticks requeue ownerless items (`liveness.violations`).

## Recovery

A dead supervisor fences its item; `containment` lists survivors' pid, cmdline and cwd. With `settleable: true` run `master settle-containment GY-N REASON`; else stop the recorded scope unit (`containment.scope`), request `rework`.

An unexplained lapsed lease raises `lease-loss` (`blocked-awaiting-operator`, `stopped-by-attestation` lapses are history); any admin settles an explained one: `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns a handler answering `master decide GY-N resolve … --context FINGERPRINT REASON`.

### Producer-runtime faults

A producer request spent with no attempt acting (never started, launch refused, exited at launch) requests no rework; it relaunches on a profile none of them ran on.

## Fault classes

Faults carry `faultClass` (`master status` `faults`); recurring classes file one item (`GRAPHYARD_FAULT_CLASS_*`); a resource at its bound is one fault on `resource:ID`. Workless sessions raise `fleet-capacity`; settled requests unanswered past `settledAnswerGraceMs` (5 minutes) are `unanswered-request`; sandbox or `workflows`-permission refusals are `configuration`. A decision silently awaiting its approver is `decision-unanswered` (`decision`), not `loop-silence`; a doctor command its allowlist refused is recorded done; a failed `action:fault`/`action:diagnosis` is `unclassified` unless its site names the cause (`plane-unavailable`, `fix-item`, `decision-stale`). A review unlaunched after 15 minutes is `concurrency-starved` (capacity) when every reviewer profile is busy, `review-settlement` (review-convergence) when a reviewer already answered (aged from the verdict; the tick wakes the observation), else `launch-review`. An unanswering control plane (502-504, refused, timeout) is one `plane-unavailable` fault (`deployment`); what met it retries faultlessly; its `planeWaitMs` wait is not `loop-cost`.

## Pipeline speed

Target (ten-plus deliveries): submit→merge p50 ≤30 minutes, p90 ≤60 minutes. Row `speed`: `executionMs`, `waitMs`, `reworkRounds`, `interventions`; `speed.submitToMerge` is the verdict. `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.

The loop's decisions step stays within 10 s a cycle at about 90 open items: one `decision.*` ledger read names moved items, rereading only those. A history whose ledger has not moved is kept, not read. Loop widenings refused by 5xx or stale revision, and decisions or withdrawals whose history read times out, retry next cycle (two in a row: a fault); moot ones (delivered, request answered, lease ended, head moved) count none.
