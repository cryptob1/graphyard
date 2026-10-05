<!-- page: Operate Graphyard | 7 | executors, GitHub administration. -->
# Master-agent reference

## Items, scope and human waits

Unplanned file: `scope-request GY-N EPOCH PATH… [--wait] -- REASON` (flags before `--` refused). Auto-granted if grounded: docs; files criteria or follow-ups name; `web/`/`browser-tests/` for `docs/`-planning items; files review findings name; tests pinning planned text; symbol definitions; successors; companions (docs-budget gate, timing baseline, importing tests, planned modules' imports and importers). An `approve-scope` executor or the loop decides; standing decisions replay. Otherwise an approver judges (a partly grounded request's rest goes to it in the same cycle, against the widened revision; findings are not re-read while it judges); `master scope GY-N [--allow-broad-scope] REASON` applies refused requests (needs reason); leases stay (`--wait` reads outcome). A `requirements` revision against a stale policy revision is refused as stale before any lease or quarantine check; the loop's own widening or re-plan refused with a 5xx or a stale revision is retried next cycle and counts as an `action:scope` fault only on a second refusal in a row. Ending attempts (submit, release, lapse, rework, requirements) close open/refused requests as `attempt ended`; `master unblock GY-N` closes stale ones. Human decisions: `park GY-N EPOCH KIND NEEDED [--choice LABEL]… -- REASON` ([Needs you](dashboard.md#needs-you), answered via `graphyard answer GY-N …`).

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`.

### Speculative tips and branch protection

**An approval must survive a tip publication.** [Carry rules](github.md#bindings-and-carry) apply.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** Only a current-head approval dismissed with `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`); its re-post is no new verdict (`observation.dismissedReviewIds`).

**A branch must never keep another item's unlanded commits.** Tips build from reviewed heads; ejected branches restore onto the base tip in one push (`baseRefresh.restore`; a second failure → `escalated` in `master status`). Another item's carried files (`Carried from another item's tip`) are neither rework nor ejection.

#### A contaminated branch

Listed under `branches.contaminated`; run `master repair GY-42`.

| `master repair GY-N REASON` | Restore a contaminated branch to its reviewed head |

A worker restores its own: `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, then `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

`master protection --apply` reconciles protection; where only a page exists, `master browser FLOW` drives the `master init --browser-profile` profile  (`master browser app-permissions`, `master browser installation-accept`, `master browser protection`):

| Flow | Effect
| --- | ---
| `app-permissions` | Raise App permissions to declaration
| `installation-accept` | Accept pending requests
| `protection` | Reconcile branch protection

Flows read `GET /api/github/installation` (App credential) and record `.graphyard/master-actions/` `record.json`, `ledger.json`. Approving a *Confirm access* GitHub Mobile code on the device is human-only. The master never stores the profile's cookies, uses a merge bypass, pushes code or reads a worker credential.

If a harness classifier refuses routine administration, `master harness claude --apply` (Codex: `master harness codex`) writes rules to `.claude/settings.local.json`.

Denied, by endpoint: `gh pr merge`/`review`, `gh api` `pulls/N/merge`, `repos/R/merges`, `merge-upstream`, `pulls/N/reviews`, `access_tokens`, `PUT`/`POST`/`DELETE`; `gh api graphql` with `mutation` (merge, enqueue, auto-merge, approval) or `=@`/`--input`.

Missing or retired rules (`gh api *merge*`, `gh api graphql*`) are `harness` drift in `master status`; `--apply` rewrites them.

## Typed actions and executors

One typed action per item (`nextAction`: `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`); `escalate` and `request-rework` are judgements (`actions.needsHuman`). `graphyard init` starts `graphyard-executor@N` user units, claiming rows under their own credential; `master executors restart` moves them to the current release. Verified deployments move clean checkouts to the base tip and restart executors, then the loop (`upgrade` attention if dirty). A fenced executor (`POST /api/actions/presence`) or one renewing a claim still counts as alive, so it never reads as `Nothing can run KIND`.

A `resync` (`POST /api/work/:id/resync` `{ since }`) completes only on an observation newer than its claim.

A `dispatch` or `request-review` finding a session already answering the head completes on it; standing verdicts block a second reviewer until dismissed; busy or reserved worker profiles wait 30 minutes before stalling. Three failures with an unchanged reason mark a row stalled rather than retrying (a fleet that looks idle): in no count and no list, but in `actions.stalled` and on the item's own card; backoff never outlives it; eight escalate it. Ticks requeue ownerless items (`liveness.violations`).

## Recovery

A dead supervisor fences its item; `containment` lists survivors' pid, cmdline and cwd. With `settleable: true` run `master settle-containment GY-N REASON`; else stop the recorded scope unit (`containment.scope`), request `rework`.

An unexplained lapsed lease raises `lease-loss` (`blocked-awaiting-operator`, `stopped-by-attestation` lapses are history); any admin settles an explained one: `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns a handler answering `master decide GY-N resolve … --context FINGERPRINT REASON`.

### Producer-runtime faults

A producer request spent with no attempt acting (never started, launch refused, exited at launch) requests no rework; it relaunches on an independent profile none of them ran on.

## Fault classes

Faults carry `faultClass` (`master status` `faults`); recurring classes file one item (`GRAPHYARD_FAULT_CLASS_*`). Workless sessions raise `fleet-capacity`; settled requests unanswered past `settledAnswerGraceMs` (5 minutes) are `unanswered-request`; sandbox or `workflows`-permission refusals are `configuration`.

## Pipeline speed

Target (ten-plus deliveries): submit→merge p50 ≤30 minutes, p90 ≤60 minutes. Row `speed`: `executionMs`, `waitMs`, `reworkRounds`, `interventions`; `speed.submitToMerge` is the verdict. `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.

The loop's decisions step stays within 10 s a cycle at about 90 open items: one `decision.*` ledger read names moved items, rereading only those. A history whose ledger has not moved is kept, not read. Histories of items whose refused scope request awaits an approver are read ahead first, then open watches'. A request that fails only because its history read missed the 10 s deadline is retried next cycle, not on the backoff, and counts as an `action:decision` fault only on a second miss in a row.
