<!-- page: Operate Graphyard | 7 | scheduling, executors, GitHub administration. -->
# Master-agent reference

## Items, scope and human waits

Unplanned file: `scope-request GY-N EPOCH PATH… [--wait] -- REASON` (other flags before `--` refused). Auto-granted if grounded: documentation; files criteria name; single `web/`/`browser-tests/` files for `docs/`-planning items; base files named by an unresolved review thread or a reviewer's current-head `CHANGES_REQUESTED` review; tests pinning planned-file quotes or criterion labels; files defining a criterion's symbol; planned files' successors (renames, copies, `Graphyard-Successor: OLD -> NEW` trailers, re-export barrels); companions such as the docs-budget gate beside documentation or tests importing a planned module. Paths are judged singly. `master create`/`requirements` plan the proofs' test file and docs-budget gate up front. One decider per request (an executor holding `approve-scope`, else the loop); repeats get the standing decision. Else the approver judges; `master scope GY-N [--allow-broad-scope] REASON` applies a refused request (flag needs a reason); leases stay (`scope-request GY-N EPOCH --wait` reads the outcome). When its attempt ends (submit, release, lease lapse, rework, requirements revision), an open or refused request closes as `attempt ended`, freeing the ready gate; `master unblock GY-N` closes one whose attempt ended. A human-only decision: `park GY-N EPOCH KIND NEEDED -- REASON`; the item waits in **Needs you** for `graphyard answer GY-N …`.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`.

### Speculative tips and branch protection

**An approval must survive a tip publication.** [Carry rules](github.md#bindings-and-carry) apply.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** Only a current-head approval dismissed with `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`); its re-post is no new verdict (`observation.dismissedReviewIds`).

**A branch must never keep another item's unlanded commits.** Tips build from reviewed heads; ejected branches restore onto the base tip (`baseRefresh.restore`: `restored` once GitHub shows it, else `unpublished` (`failure`); a second, candidate unchanged → `escalated` in `master status`). A tip behind an unlanded departed entry awaits its restored head (`Restoring after predecessor ejection`); another item's carried files (`Carried from another item's tip`) are neither rework nor ejection. Git decides landing (`landing.landed`); landed peers deliver at once.

#### A contaminated branch

Listed under `branches.contaminated` (`master repair GY-42 REASON`):

| Command | Purpose
| --- | ---
| `master repair GY-N REASON` | Restore its reviewed head

or the worker runs `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, then `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

`master protection --apply` reconciles protection; where only a page exists, `master browser FLOW` drives the `master init --browser-profile` profile (`master browser app-permissions`, `master browser installation-accept`, `master browser protection`):

| Flow | Effect
| --- | ---
| `app-permissions` | Raise App permissions to declaration
| `installation-accept` | Accept pending requests
| `protection` | Reconcile branch protection

Flows read `GET /api/github/installation` (App credential, not gh), record `record.json` under `.graphyard/master-actions/` and append `ledger.json`. Approving GitHub Mobile's *Confirm access* code (in `master status`) on the device is human-only. The master never stores the profile's cookies and must never use a merge bypass, push code or read worker credentials.

If a harness classifier refuses routine administration, `master harness claude --apply` (Codex: `master harness codex`) writes rules to `.claude/settings.local.json`.

## Typed actions and executors

One typed action per item (`nextAction`: `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`); `escalate` and `request-rework` are judgements (`actions.needsHuman`). `graphyard init` starts `graphyard-executor@N` user units, claiming rows under their own credential; `master executors restart` moves them to the current release. After a verified deployment a clean detached checkout moves to the base tip (else `upgrade` attention); `src/`, `scripts/`, `bin/`, `package.json` changes restart executors (exit 0 for systemd), then the loop. `releaseLag`: >1-delivery lag past 10 minutes; `master status` names executors killed mid-action, with item.

A `resync` completes only on an observation newer than its claim: `POST /api/work/:id/resync` with `{ since }` (claim time) wakes the item's observation job and reports whether it observed (`wake: false` only reads); unobserved, it fails and backs off, stalling after repeated failures.

A `dispatch` or `request-review` finding a session already answering the head completes on it. Three failures with an unchanged reason mark a row stalled rather than retrying (a fleet that looks idle, in no count and no list), shown in `actions.stalled` and on the item's own card; backoff never outlives it; eight escalate it. An item's throw fails only its `isolated:KIND:ITEM-ID` action.

## Resources, disk and recovery

`resourceRegistry` declares bounded resources, reported in `resources` ([remedies](operations-reference.md#control-plane-resources)). The loop `git worktree remove`s finished worktrees after `run.reclaimIdleHours` (never dirty or unpushed; `run.worktreeRemovalLimit` per cycle; `.graphyard/worktree-reclaim.jsonl`) and stale, unheld [test temp entries](operations-reference.md#control-plane-resources) in `/tmp`; `disk` attention below `run.diskThresholdGb`. Review and proof checkouts: `run.worktreeRoot` (default `~/.local/share/graphyard/worktrees/REPOSITORY-ID`).

A dead supervisor fences its item; `containment` lists survivors' pid, cmdline and cwd. `settleable: true` → `master settle-containment GY-N REASON`; else stop the recorded scope unit (`containment.scope`), request `rework`.

An unexplained lapsed lease raises `lease-loss` (`blocked-awaiting-operator`, `stopped-by-attestation` lapses are history); any admin settles an explained one: `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns a handler answering `master decide GY-N resolve … --context FINGERPRINT REASON`.

Faults carry `faultClass` (`master status` `faults`); a recurring class files one item (`GRAPHYARD_FAULT_CLASS_*`), not reopened by moving hashes; failed status sections appear only in `unavailable`. Sandbox or `workflows`-permission refusal blockers are `configuration`.

## Pipeline speed

Target (ten-plus deliveries): submit→merge p50 ≤30 minutes, p90 ≤60 minutes. Row `speed`: `executionMs`, `waitMs`, `reworkRounds`, `interventions`; `speed.submitToMerge` is the verdict. `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.
