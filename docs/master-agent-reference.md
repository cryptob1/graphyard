<!-- page: Operate Graphyard | 7 | scheduling, executors, GitHub administration. -->
# Master-agent reference

## Items, scope and human waits

Unplanned file: `scope-request GY-N EPOCH PATH… [--wait] -- REASON` (flags before `--` refused). Auto-granted if grounded: docs; files criteria name; `web/`/`browser-tests/` for `docs/`-planning items; files named by unresolved review threads or `CHANGES_REQUESTED`; tests pinning planned quotes/labels; symbol definitions; successors (renames, copies, trailers, barrels); companions (docs-budget gate, timing baseline, importing tests). Proof test files, baselines, and docs-budget gate are planned up front. Decided by an executor holding `approve-scope` or the loop; standing decisions replay. Otherwise an approver judges; `master scope GY-N [--allow-broad-scope] REASON` applies refused requests (needs reason); leases stay (`--wait` reads outcome). Ending attempts (submit, release, lapse, rework, requirements) close open/refused requests as `attempt ended`, freeing ready; `master unblock GY-N` closes stale ones. Human decisions: `park GY-N EPOCH KIND NEEDED -- REASON` (**Needs you**, answered via `graphyard answer GY-N …`).

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`.

### Speculative tips and branch protection

**An approval must survive a tip publication.** [Carry rules](github.md#bindings-and-carry) apply.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** Only a current-head approval dismissed with `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`); its re-post is no new verdict (`observation.dismissedReviewIds`).

**A branch must never keep another item's unlanded commits.** Tips build from reviewed heads; ejected branches restore onto the base tip in one push (`baseRefresh.restore`: `restored` once GitHub shows it, else `unpublished` (`failure`); a second, candidate unchanged → `escalated` in `master status`). A tip behind an unlanded departed entry awaits its restored head (`Restoring after predecessor ejection`); another item's carried files (`Carried from another item's tip`) are neither rework nor ejection. Landed peers deliver at once (`landing.landed`).

#### A contaminated branch

Listed under `branches.contaminated`; run `master repair GY-42`:

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

Flows read `GET /api/github/installation` (App credential, not gh), record `record.json` under `.graphyard/master-actions/` and append `ledger.json`. Approving its *Confirm access* GitHub Mobile code on the device is human-only. The master never stores the profile's cookies, uses a merge bypass, pushes code or reads a worker credential.

If a harness classifier refuses routine administration, `master harness claude --apply` (Codex: `master harness codex`) writes rules to `.claude/settings.local.json`.

## Typed actions and executors

One typed action per item (`nextAction`: `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`); `escalate` and `request-rework` are judgements (`actions.needsHuman`). `graphyard init` starts `graphyard-executor@N` user units, claiming rows under their own credential; `master executors restart` moves them to current release. Verified deployments move clean detached checkouts to the base tip (`upgrade` attention if dirty); `src/`, `scripts/`, `bin/`, `package.json` changes restart executors, then the loop. `releaseLag`: >1-delivery lag past 10 min; `master status` names executors killed mid-action.

A `resync` completes only on observations newer than claim: `POST /api/work/:id/resync` with `{ since }` wakes the observation job, reporting `observed`, `observedAt`, `job` (`wake: false` only reads); unobserved fails with `no observation newer than the claim was saved`. Scheduled jobs with no hold/error stall after 30 min; held, failed or missing stall after three. Row bookkeeping (claim, renew, settle) never refuses prior observation reads.

A `dispatch` or `request-review` finding a session already answering the head completes on it; a settled standing verdict blocks a second reviewer until dismissed. Three failures with an unchanged reason mark a row stalled rather than retrying (a fleet that looks idle, in no count and no list), shown in `actions.stalled` and on the item's own card; backoff never outlives it; eight escalate it. Ticks requeue ownerless items (`liveness.violations`). A failed snapshot read retries once after 0.5–1.5 s; a failed cycle waits min(interval, 30 s), doubling to the ceiling. An item's throw fails only its `isolated:KIND:ITEM-ID` action.

## Resources and disk

`resourceRegistry` declares bounded resources, reported in `resources` ([remedies](operations-reference.md#control-plane-resources)). The loop `git worktree remove`s finished worktrees after `run.reclaimIdleHours` (never dirty or unpushed; `run.worktreeRemovalLimit` per cycle) and stale, unheld [test temp entries](operations-reference.md#control-plane-resources) in `/tmp`; `disk` attention below `run.diskThresholdGb`. Review and proof checkouts: `run.worktreeRoot` (default `~/.local/share/graphyard/worktrees/REPOSITORY-ID`).

## Recovery

A dead supervisor fences its item; `containment` lists survivors' pid, cmdline and cwd. With `settleable: true` run `master settle-containment GY-N REASON`; else stop the recorded scope unit (`containment.scope`), request `rework`.

An unexplained lapsed lease raises `lease-loss` (`blocked-awaiting-operator`, `stopped-by-attestation` lapses are history); any admin settles an explained one: `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns a handler answering `master decide GY-N resolve … --context FINGERPRINT REASON`.

## Fault classes

Faults carry `faultClass` (`master status` `faults`); recurring classes file one item (`GRAPHYARD_FAULT_CLASS_*`); moving hashes never reopen a standing fault. Full roles are slot waits; workless sessions raise `fleet-capacity` (capacity). Scope requests count past 15 minutes open, or refused with no approver left. A failed section is listed only in `unavailable`. Sandbox or `workflows`-permission refusal blockers are `configuration`.

## Pipeline speed

Target (ten-plus deliveries): submit→merge p50 ≤30 minutes, p90 ≤60 minutes. Row `speed`: `executionMs`, `waitMs`, `reworkRounds`, `interventions`; `speed.submitToMerge` is the verdict. `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.
