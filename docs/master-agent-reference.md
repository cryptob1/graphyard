<!-- page: Operate Graphyard | 7 | scheduling, executors, GitHub administration. -->
# Master-agent reference

## Items, scope and human waits

An unplanned file needs `scope-request GY-N EPOCH PATH… [--wait] -- REASON` (other flags before `--` refused). Automatic, grounded: documentation; files criteria name; single `web/` or `browser-tests/` for items planning `docs/`; base files an unresolved reviewer or bot thread names literally; tests pinning quotes or labels; defining or rare symbols; successors (renames, copies, trailers, barrels); companions: the docs-budget gate, timing baseline, proofs test file, importing tests. Other paths are approver-judged (`--allow-broad-scope` needs a reason); workers keep leases (`--wait` reads the outcome). One decider per request; repeats get the standing decision. Open or refused requests close on attempt end (`scope.closed`, reason `attempt ended`); `master unblock GY-N` closes one whose attempt ended. A human-only decision needs `park GY-N EPOCH KIND NEEDED [--choice LABEL]… -- REASON`, waiting under [Needs you](dashboard.md#needs-you).

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`.

### Speculative tips and branch protection

**An approval must survive a tip publication.** [Carry rules](github.md#bindings-and-carry) apply.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** An approval of the current head dismissed with `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`); its re-post is no new verdict (`observation.dismissedReviewIds`).

**A branch must never keep another item's unlanded commits.** Tips build from reviewed heads; ejected branches restore onto base in one push (`baseRefresh.restore`: `restored` on GitHub, else `unpublished`; twice, `escalated`). A tip behind an unlanded departed entry waits (`Restoring after predecessor ejection`). Carried files (`Carried from another item's tip`) are neither rework nor ejection.

#### A contaminated branch

Listed under `branches.contaminated`:

| Command | Purpose |
| --- | --- |
| `master repair GY-N REASON` | Restore its reviewed head (`master repair GY-42 REASON`) |

or the worker runs `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, then `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

`master protection --apply` reconciles protection. Where only a page exists, `master browser app-permissions`, `master browser installation-accept` or `master browser protection` drives the `master init --browser-profile` profile:

| Flow | Effect |
| --- | --- |
| `app-permissions` | Raise App permissions |
| `installation-accept` | Accept pending requests |
| `protection` | Reconcile protection |

Permission flows read `GET /api/github/installation`, recording `record.json` under `.graphyard/master-actions/` and `ledger.json`. Approving the *Confirm access* GitHub Mobile code (in `master status`) on the device is human-only. The master never stores cookies, uses a merge bypass, pushes code or reads a worker credential.

`master harness claude --apply` (or `codex`) writes rules so the harness classifier allows routine administration.

## Typed actions and executors

Each item has one typed action (`nextAction`: `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`); `escalate` and `request-rework` are judgements (`actions.needsHuman`). `graphyard-executor@N` units claim rows under their credential; `master executors restart` moves them to the current release. A verified deployment moves a clean checkout to the base tip (else `upgrade` attention), restarting on runtime changes; `releaseLag` flags lag past 10 minutes.

A `resync` completes only on an observation newer than its claim: `POST /api/work/:id/resync` with `{ since }` wakes the observation job, answering `observed`, `observedAt` and its `job`; `wake: false` only reads. Unobserved, it fails (`no observation newer than the claim was saved`) and backs off, stalling after thirty minutes for a scheduled job, else three failures.

`dispatch`/`request-review` completes on a session already answering the head. Three failures with an unchanged reason mark a row stalled rather than retrying (a fleet that looks idle, with no count and no list): it shows in `actions.stalled` and on the item's own card; backoff, doubling from one minute, never outlives it. Eight escalate it; ticks requeue ownerless items (`liveness.violations`). A failed cycle backs off (min(interval, 30 s), doubling); one item's throw fails only its own action.

## Resources and disk

`resources` reports bounded resources (`resourceRegistry`; [remedies](operations-reference.md#control-plane-resources)). The loop removes clean finished worktrees after `run.reclaimIdleHours`, idle `/tmp` test entries and `tsx-<uid>`, and agentless launch [panes](master-agent-sessions.md#panes-are-closed-and-reclaimed); `disk` attention fires below `run.diskThresholdGb`. Review and proof checkouts live under `run.worktreeRoot`.

## Recovery

A dead supervisor fences its item; `containment` lists surviving processes' pid, cmdline and cwd. If `settleable: true`, `master settle-containment GY-N REASON`; else stop the recorded scope (`containment.scope`) and request `rework`.

An unexplained lapsed lease raises `lease-loss` (`blocked-awaiting-operator` and `stopped-by-attestation` lapses are history); any admin settles an explained one: `resolve GY-N lease-loss --attestation blocked|stopped-worker` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns a handler answering with `master decide GY-N resolve … --context FINGERPRINT REASON`.

Faults carry `faultClass` (`faults`); recurring classes file one item (`GRAPHYARD_FAULT_CLASS_*`), not reopened by moving hashes; sandbox or `workflows`-permission refusals are `configuration`; scope requests count past 15 minutes open or refused with no approver. Recurring-class and `invariant:` faults get a read-only diagnostician (`run.diagnostician`) whose fix approval releases or closes as duplicate. Restores owed under 30 minutes are not `merge` faults.

## Pipeline speed

Over ten-plus deliveries, `speed.submitToMerge` must reach p50 ≤ 30 and p90 ≤ 60 minutes; rows also carry `executionMs`, `waitMs`, `reworkRounds`, `interventions`. `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.
