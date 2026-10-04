<!-- page: Operate Graphyard | 7 | scheduling, executors, GitHub administration. -->
# Master-agent reference

## Master commands

| Command | Purpose |
| --- | --- |
| `master repair GY-N REASON` | Restore a contaminated branch to its reviewed head |
| `master settle-containment GY-N REASON` | Settle a quarantine whose supervisor is verified gone |
| `master scope GY-N [--allow-broad-scope] REASON` | Apply a scope request the loop refused |

## Items, scope and human waits

An unplanned file needs `scope-request GY-N EPOCH PATH… [--wait] -- REASON` (other flags before `--` refused). Automatic, grounded: documentation; files criteria name; for `docs/` items, single `web/` and `browser-tests/` files; base files named literally in an unresolved thread or `CHANGES_REQUESTED` review (rechecked every 2 min); tests pinning planned quotes or criterion labels; files defining or calling rare criterion symbols; successors (renames, copies, `Graphyard-Successor` trailers, barrels); companions: docs-budget gate, timing baseline (beside top-level `tests/*.test.ts`), proofs' test file, test imports, web-UI files. Approver judges the rest (`--allow-broad-scope` needs reason); workers keep leases (`--wait` reads outcome). `master create`/`requirements` plan proofs' test file, baseline and docs-budget gate up front. One decider per request (`approve-scope` executor, else loop); repeats get standing decisions. Attempt-bound: ending (submit, release, lapse, rework, revision) closes requests as `attempt ended`; next attempt asks afresh; `master unblock GY-N` closes ended requests. Human decisions need `park GY-N EPOCH KIND NEEDED [--choice LABEL]… -- REASON` ([Needs you](dashboard.md#needs-you)).

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first; `git merge-tree` reports candidate conflicts (`conflicts`) ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)).

### Speculative tips and branch protection

**An approval must survive a tip publication.** [Carry rules](github.md#bindings-and-carry) apply.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** An approval dismissed with `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`); no other dismissal is. Re-post is no new verdict (`observation.dismissedReviewIds`). Merge-base dismissals in motion (tips republishing, approvals restoring) are review-convergence faults only past 30 min (`mergeBaseDismissalWaitBoundMs`).

**A branch must never keep another item's unlanded commits.** Tips build from reviewed heads; ejected branches restore onto the base tip in one push (`baseRefresh.restore`): `restored` once GitHub shows it, else `unpublished` (`failure`); a second, candidate unchanged, escalates (`escalated`, `master status`). A tip behind an unlanded departed entry waits (`Restoring after predecessor ejection`) for its restored head; another item's carried files (`Carried from another item's tip`) are neither rework nor ejection. Git decides landing (`landing.landed`); landed peers deliver immediately.

#### A contaminated branch

Listed under `branches.contaminated`; run `master repair GY-42`.

A worker restores its own: `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, then `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

Protection reconciles via `master protection --apply`; where only a page exists, `master browser FLOW` drives the `master init --browser-profile` profile: `master browser app-permissions`, `master browser installation-accept` or `master browser protection`.

| Flow | Effect |
| --- | --- |
| `app-permissions` | Raises App permissions to the declaration |
| `installation-accept` | Accepts pending requests |
| `protection` | Reconciles branch protection |

Permission flows read `GET /api/github/installation` (App credential, not gh). Each flow records `.graphyard/master-actions/` `record.json`, appending to `ledger.json`. Approving its *Confirm access* GitHub Mobile code on the device is human-only. The master never stores the profile's cookies, uses a merge bypass, pushes code or reads a worker credential.

## Harness permissions

A harness classifier refuses routine administration; `master harness claude --apply` (or `codex`) writes rules to `.claude/settings.local.json`.

## Typed actions and executors

Each item has one typed action (`nextAction`): `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment` or `escalate`. Executors claim rows under their own credential; `escalate` and `request-rework` are judgements (`actions.needsHuman`). `graphyard init` starts `graphyard-executor@N` user units; `master executors restart` moves them to the current release. After a verified deployment the loop moves a clean detached checkout to the base tip (else `upgrade` attention); `src/`, `scripts/`, `bin/` or `package.json` changes restart executors, then the loop. `releaseLag` flags >1-delivery lag past 10 minutes. A moved checkout exits the executor 0 for systemd; one killed mid-action is named in `master status`. `Nothing can run KIND` skips `merge` beside a merging loop, empty fleets ≤120 s post-restart, `deactivating` units.

A `resync` needs a fresh observation: `POST /api/work/:id/resync` with `{ since }` (claim time) wakes the item's observation job, answering `observed`, `observedAt` and its `job`; `wake: false` only reads. Unobserved, the claim fails at once (`no observation newer than the claim was saved`, plus its condition). Failures against a scheduled job with no hold or error stall after thirty minutes; held, failed or missing, after three. Row bookkeeping never refuses a prior observation read.

A `dispatch` or `request-review` finding a session already answering the requested head completes on it; a settled standing verdict blocks a second reviewer until dismissed; busy or reserved worker profiles wait thirty minutes before stalling. Three failures with an unchanged reason mark a row stalled rather than retrying (a fleet that looks idle): in no count and no list, it shows in `actions.stalled` and on the item's own card; backoff, doubling from one minute, never outlives it. Eight escalate it (half-hourly); ticks requeue ownerless items (`liveness.violations`).

A failed snapshot read retries once (0.5–1.5 s); a failed cycle waits min(interval, 30 s), doubling. One item's throw fails only its `isolated:KIND:ITEM-ID` action.

## Resources and disk

`resourceRegistry` declares every bounded resource, reported under `resources` ([remedies](operations-reference.md#control-plane-resources)). The loop `git worktree remove`s finished worktrees (`run.reclaimIdleHours`; never dirty/unpushed), `run.worktreeRemovalLimit`/cycle, logging `.graphyard/worktree-reclaim.jsonl`, stale [test temp entries](operations-reference.md#control-plane-resources) and `tsx-<uid>` in `/tmp` (dead owner or 2h/6h idle; unheld; ≤100/cycle, one pass in flight); `disk` attention below `run.diskThresholdGb`. Review and proof checkouts live under `run.worktreeRoot` (default `~/.local/share/graphyard/worktrees/REPOSITORY-ID`). Agentless panes Graphyard launched are swept each cycle ([panes](master-agent-sessions.md#panes-are-closed-and-reclaimed)). The resource reclaim closes any unowned, non-`working` pane on a profile's name — `unknown` status or a recordless reviewer/producer included — once two passes 60 s apart saw it.

## Recovery

A dead supervisor fences its item; `containment` lists each surviving process's pid, cmdline and cwd. With `settleable: true` run `master settle-containment`; otherwise stop the recorded scope unit (`containment.scope`) and request `rework`.

An unexplained lapsed lease raises `lease-loss` (`blocked-awaiting-operator` and `stopped-by-attestation` lapses are history); any admin settles an explained one with `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). 

`master escalation GY-N` spawns a handler answering with `master decide GY-N resolve … --context FINGERPRINT REASON`.

## Research and diagnosis

With `run.research`, features (or `"research": true`) get one read-only Pi briefing per revision; build follows it, failure never blocks; product questions need humans.

`Recurring <class> faults` and `invariant:` faults past `invariantBoundMinutes` get a read-only diagnostician (`run.diagnostician`); approved decisions release its fix or close-as-duplicate; recurrences re-file. Branch restores under 30m and restart-resumed merges are not `merge` faults.

## Fault classes

Faults carry `faultClass` (`master status` `faults`); recurring classes file one item (`GRAPHYARD_FAULT_CLASS_*`); moving hashes never reopen, nor pruning retire, a standing fault. Full roles are slot waits; workless sessions raise `fleet-capacity` (capacity); unnamed master roles are no `configuration` fault. Scope requests count past 15 minutes open, or refused with no approver left. A failed section is listed only in `unavailable`. Sandbox or `workflows`-permission refusal blockers are `configuration`.

## Pipeline speed

Target: submit→merge p50 ≤ 30 minutes and p90 ≤ 60 minutes over ten-plus deliveries. Rows' `speed` carries `executionMs`, `waitMs`, `reworkRounds` and `interventions`; `speed.submitToMerge` gives the verdict. `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.
