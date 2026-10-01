<!-- page: Operate Graphyard | 7 | scheduling, executors, GitHub. -->
# Master-agent reference

## Master commands

| Command | Purpose |
| --- | --- |
| `master repair GY-N REASON` | Restore a contaminated branch to its reviewed head |
| `master scope GY-N [--allow-broad-scope] REASON` | Apply a scope request the loop refused |

## Items, scope and human waits

An unplanned file needs `scope-request GY-N EPOCH PATH… [--wait] -- REASON` (other flags before `--` refused). Auto-granted when grounded: documentation; files criteria name; single `web/` and `browser-tests/` files for items planning `docs/`; base files an unresolved reviewer or `run.awaitReviewers`-bot thread, or the reviewer's current-head `CHANGES_REQUESTED` review, names literally (unnegated; rechecked every two minutes); tests pinning planned-file quotes or criterion labels; files defining a criterion's symbol or calling a rare one; planned files' successors (renames, copies, `Graphyard-Successor: OLD -> NEW` trailers, re-export barrels), also added to open items. The approver judges the rest (`--allow-broad-scope` needs a reason); workers keep leases, `scope-request GY-N EPOCH --wait` reading the outcome. When its attempt ends (submit, release, lease lapse, rework, requirements revision), an open or refused request closes `attempt ended` (`scope.closed`), freeing the ready gate. `master unblock GY-N` closes one whose attempt already ended, named in the unblock's history. A human-only decision needs `park GY-N EPOCH KIND NEEDED -- REASON`; the item waits under **Work → Needs you** for `graphyard answer GY-N …`.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first; `git merge-tree` reports candidate `conflicts` ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)).

### Speculative tips and branch protection

**An approval must survive a tip publication.** [Carry rules](github.md#bindings-and-carry) apply.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** Only a current-head approval dismissed with `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`); its re-post is no new verdict (`observation.dismissedReviewIds`).

**A branch must never keep another item's unlanded commits.** Tips build from reviewed heads; ejection restores branches (`baseRefresh.restore`). A tip behind an unlanded departed entry waits for its restored head (`Restoring after predecessor ejection`); another item's carried files (`Carried from another item's tip`) are neither rework nor ejection. Git decides landing (`landing.landed`); landed peers deliver at once.

#### A contaminated branch

Listed under `branches.contaminated`: run `master repair GY-42 REASON`, or the worker runs `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, then `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

Protection reconciles via `master protection --apply`; where only a page exists, `master browser FLOW` (`master browser app-permissions`, `master browser installation-accept`, `master browser protection`) drives the `master init --browser-profile` profile:

| Flow | Effect |
| --- | --- |
| `app-permissions` | Raises App permissions to the declaration |
| `installation-accept` | Accepts pending requests |
| `protection` | Reconciles branch protection |

Permission flows read `GET /api/github/installation` with the App credential, not gh. Each records `record.json` under `.graphyard/master-actions/`, appended to `ledger.json`. *Confirm access* in GitHub Mobile on the device is human-only. The master never stores the profile's cookies, and must never use a merge bypass, push code or read a worker credential.

When a harness classifier refuses routine administration, `master harness claude --apply` (Codex: `master harness codex`) writes rules to `.claude/settings.local.json`.

## Typed actions and executors

Each item has one typed action (`nextAction`): `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment` or `escalate`, claimed by executors (own credential); `escalate` and `request-rework` are judgements (`actions.needsHuman`). `graphyard init` starts `graphyard-executor@N` user units; `master executors restart` moves them to the current release. After a verified deployment the loop moves a clean detached checkout to the base tip (else `upgrade` attention), restarting executors, then itself, on `src/`, `scripts/`, `bin/` or `package.json` changes; `releaseLag` flags >1-delivery lag past 10 minutes. A moved checkout exits the executor 0 for systemd to restart; `master status` names one killed mid-action with its item.

A `resync` completes only on a fresh observation: the executor's `POST /api/work/:id/resync` `{ since }` (its claim time) wakes the item's observation job, answering `observed`, `observedAt` and `job` (`availableAt`, `lockedUntil`, `attempts`, `error`, `heldUntil`, `heldReason`); `wake: false` only reads. Unobserved, the claim fails at once (`no observation newer than the claim was saved`, with the job's condition) and backs off; three stall it. Row bookkeeping (claim, renew, settle) never refuses an earlier observation read; other changes do.

Three failures with an unchanged reason mark a row stalled rather than retrying: instead of in no count and no list (a fleet that looks idle), it shows in `actions.stalled` and on the item's own card; its backoff, doubling from one minute, never outlives it. Eight escalate it (half-hourly); ticks requeue ownerless items (`liveness.violations`).

A failed snapshot read retries once after 0.5–1.5 s; a failed cycle waits min(interval, 30 s), doubling to the ceiling; one item's throw fails only its `isolated:KIND:ITEM-ID` action; a failed status section is listed only in `unavailable`. Faults carry `faultClass` (`master status` `faults`); a recurring class files one item (`GRAPHYARD_FAULT_CLASS_*`), never reopened by moving hashes.

## Resources and disk

`resourceRegistry` declares every bounded resource, reported under `resources` ([remedies](operations-reference.md#control-plane-resources)). Each cycle the loop `git worktree remove`s up to `run.worktreeRemovalLimit` finished worktrees (`run.reclaimIdleHours`; never dirty/unpushed), logging `.graphyard/worktree-reclaim.jsonl`, removes stale `/tmp/graphyard-*`, `tsx-<uid>` directories (dead owner or 6h idle; unheld; ≤100, one pass in flight) and sweeps [agentless panes](master-agent-sessions.md#panes-are-closed-and-reclaimed) a Graphyard launch left on this host; `disk` attention fires below `run.diskThresholdGb`. Review and proof checkouts live under `run.worktreeRoot` (default `~/.local/share/graphyard/worktrees/REPOSITORY-ID`).

## Recovery

A dead supervisor fences its item; `containment` lists each surviving process's pid, cmdline and cwd. With `settleable: true` run `master settle-containment GY-N REASON`; otherwise stop the recorded scope unit (`containment.scope`) and request `rework`.

Lapses classified `blocked-awaiting-operator` or `stopped-by-attestation` are history; an explained `lease-loss` takes `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns a handler answering with `master decide GY-N resolve … --context FINGERPRINT REASON`.

## Pipeline speed

Target: submit→merge p50 ≤ 30 minutes, p90 ≤ 60 minutes over ten-plus deliveries. Each row's `speed` carries `executionMs`, `waitMs`, `reworkRounds` and `interventions`; `speed.submitToMerge` gives the verdict. `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.
