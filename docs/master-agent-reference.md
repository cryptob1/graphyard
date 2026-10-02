<!-- page: Operate Graphyard | 7 | scheduling, executors, GitHub administration. -->
# Master-agent reference

## Items, scope and human waits

An unplanned file needs `scope-request GY-N EPOCH PATH… [--wait] -- REASON` (other flags before `--` are refused). Automatic, grounded: documentation; files criteria name; for items planning `docs/`, single `web/` and `browser-tests/` files; base files an unresolved reviewer or `run.awaitReviewers`-bot thread, or reviewer's current-head `CHANGES_REQUESTED` review, names literally (unnegated; rechecked every two minutes); tests pinning planned-file quotes or criterion labels; files defining a criterion's symbol or calling a rare one; planned files' successors (renames, copies, `Graphyard-Successor: OLD -> NEW` trailers, re-export barrels), also added to open items. The approver judges the rest (`--allow-broad-scope` needs a reason); workers keep leases (`scope-request GY-N EPOCH --wait` reads the outcome). A request belongs to its attempt: when that ends (submit, release, lease lapse, rework, a requirements revision) an open or refused request closes with reason `attempt ended` (`scope.closed`), no longer holding the ready gate, and the next attempt asks afresh; `master unblock GY-N` closes one whose attempt already ended, naming it in the unblock's history. A human-only decision needs `park GY-N EPOCH KIND NEEDED -- REASON`; the item waits under **Work → Needs you** for `graphyard answer GY-N …`.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`.

### Speculative tips and branch protection

**An approval must survive a tip publication.** [Carry rules](github.md#bindings-and-carry) apply.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** An approval of the current head dismissed with `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`); its re-post is no new verdict (`observation.dismissedReviewIds`).

**A branch must never keep another item's unlanded commits.** Tips build from reviewed heads; ejected branches restore onto the base (`baseRefresh.restore`: `restored` once GitHub shows it, else `unpublished`; twice, `escalated`). A tip behind an unlanded departed entry waits (`Restoring after predecessor ejection`). Another item's carried files (`Carried from another item's tip`) are neither rework nor ejection. Landed peers deliver at once (`landing.landed`).

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

Permission flows read `GET /api/github/installation` (App credential, not gh), recording `record.json` under `.graphyard/master-actions/` and `ledger.json`. Approving the *Confirm access* GitHub Mobile code (in `master status`) on the device is human-only. The master never stores cookies, uses a merge bypass, pushes code or reads a worker credential.

A harness classifier refuses routine administration; `master harness claude --apply` (Codex: `master harness codex`) writes rules to `.claude/settings.local.json`.

## Typed actions and executors

Each item has one typed action (`nextAction`: `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`); the last and `request-rework` are judgements (`actions.needsHuman`). `graphyard-executor@N` units claim rows under their own credential; `master executors restart` moves them to the current release. After a verified deployment a clean detached checkout moves to the base tip (else `upgrade` attention), restarting executors, then the loop, on `src/`, `scripts/`, `bin/` or `package.json` changes; `releaseLag` flags a >1-delivery lag past 10 minutes.

A `resync` completes only on an observation newer than its claim: `POST /api/work/:id/resync` with `{ since }` wakes the observation job, answering `observed`, `observedAt` and its `job` (hold, error, attempts); `wake: false` only reads. Unobserved, it fails (`no observation newer than the claim was saved`) and backs off; a scheduled job with no hold or error stalls the row only after thirty minutes, a held, failed or missing one after three failures. Row bookkeeping never refuses an observation read before it.

A `dispatch` or `request-review` finding a session already answering the head completes on it. Three failures with an unchanged reason mark a row stalled rather than retrying (a fleet that looks idle, with no count and no list): it shows in `actions.stalled` and on the item's own card; backoff, doubling from one minute, never outlives it. Eight escalate it; ticks requeue ownerless items (`liveness.violations`). A failed snapshot read retries once after 0.5–1.5 s; a failed cycle waits min(interval, 30 s), doubling; one item's throw fails only its `isolated:KIND:ITEM-ID` action.

## Resources and disk

`resourceRegistry` declares bounded resources, reported in `resources` ([remedies](operations-reference.md#control-plane-resources)). The loop removes finished worktrees after `run.reclaimIdleHours` (never dirty or unpushed; `run.worktreeRemovalLimit` per cycle; `.graphyard/worktree-reclaim.jsonl`) and stale `/tmp/graphyard-*` and `tsx-<uid>` directories; `disk` attention fires below `run.diskThresholdGb`. Review and proof checkouts: `run.worktreeRoot` (`~/.local/share/graphyard/worktrees/REPOSITORY-ID`).

## Recovery

A dead supervisor fences its item; `containment` lists surviving processes' pid, cmdline and cwd. If `settleable: true`, `master settle-containment GY-N REASON`; else stop the recorded scope (`containment.scope`) and request `rework`.

An unexplained lapsed lease raises `lease-loss` (`blocked-awaiting-operator` and `stopped-by-attestation` lapses are history); any admin settles an explained one: `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns a handler answering with `master decide GY-N resolve … --context FINGERPRINT REASON`.

Faults carry `faultClass` (`faults`); a recurring class files one item (`GRAPHYARD_FAULT_CLASS_*`), not reopened by moving hashes; failed status sections list in `unavailable`. `Recurring <class> faults` and `invariant:` faults past `invariantBoundMinutes` get a read-only diagnostician (`run.diagnostician`) whose fix approval releases or closes as duplicate.

## Pipeline speed

Target over ten-plus deliveries: submit→merge p50 ≤ 30 minutes, p90 ≤ 60 minutes. Each row's `speed` carries `executionMs`, `waitMs`, `reworkRounds` and `interventions`; `speed.submitToMerge` is the verdict. `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.
