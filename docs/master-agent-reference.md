<!-- page: Operate Graphyard | 7 | scheduling, executors, GitHub administration. -->
# Master-agent reference

## Master commands

| Command | Purpose |
| --- | --- |
| `master repair GY-N REASON` | Restore a contaminated branch to its reviewed head |
| `master settle-containment GY-N REASON` | Settle a quarantine whose supervisor is verified gone |
| `master scope GY-N [--allow-broad-scope] REASON` | Apply a scope request the loop refused |

## Items, scope and human waits

An unplanned file needs `scope-request GY-N EPOCH PATH… [--wait] -- REASON` (other flags before `--` are refused). Automatic, grounded: documentation; files criteria name; for items planning `docs/`, single `web/` and `browser-tests/` files; base files an unresolved reviewer or `run.awaitReviewers`-bot thread, or reviewer's current-head `CHANGES_REQUESTED` review, names literally (unnegated; rechecked every two minutes); tests pinning planned-file quotes or criterion labels; files defining a criterion's symbol or calling a rare one; planned files' successors (renames, copies, `Graphyard-Successor: OLD -> NEW` trailers, re-export barrels), also added to open items; companions: the docs-budget gate beside documentation, the test file the criteria's proofs live in (new when no base file holds them), tests importing a planned module or its barrel, single `web/` files a web-UI criterion describes. Paths are judged singly; the approver judges the rest (`--allow-broad-scope` needs a reason); workers keep leases (`--wait` reads the outcome). `master create`/`requirements` plan the proofs' test file and docs-budget gate up front. One decider per request (an executor holding `approve-scope`, else the loop); repeats get the standing decision. A request belongs to its attempt: when that ends (submit, release, lease lapse, rework, a requirements revision) an open or refused request closes with reason `attempt ended` (`scope.closed`) and the next attempt asks afresh; `master unblock GY-N` closes one whose attempt already ended, naming it in the unblock's history. A human-only decision needs `park GY-N EPOCH KIND NEEDED -- REASON`; the item waits under **Work → Needs you** for `graphyard answer GY-N …`.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first; `git merge-tree` reports candidate conflicts (`conflicts`) ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)).

### Speculative tips and branch protection

**An approval must survive a tip publication.** [Carry rules](github.md#bindings-and-carry) apply.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** An approval of the current head dismissed with `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`); no other dismissal is. Its re-post is no new verdict (`observation.dismissedReviewIds`).

**A branch must never keep another item's unlanded commits.** Tips build from reviewed heads; ejected branches restore onto the current base tip (`baseRefresh.restore`): `restored` once GitHub shows it, else `unpublished` (`failure`); a second, candidate unchanged, escalates (`escalated`, `master status`). A tip behind an unlanded departed entry waits (`Restoring after predecessor ejection`) for its restored head; another item's carried files (`Carried from another item's tip`) are not rework, nor an ejection (GY-871). Git decides landing (`landing.landed`); landed peers deliver immediately.

#### A contaminated branch

Listed under `branches.contaminated`; run `master repair GY-42 REASON`.

A worker restores its own: `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, then `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

Protection reconciles via `master protection --apply`; where only a page exists, `master browser FLOW` drives the `master init --browser-profile` profile: `master browser app-permissions`, `master browser installation-accept` or `master browser protection`.

| Flow | Effect |
| --- | --- |
| `app-permissions` | Raises App permissions to the declaration |
| `installation-accept` | Accepts pending requests |
| `protection` | Reconciles branch protection |

Permission flows read `GET /api/github/installation` (App credential, not gh). Each flow records `record.json` under `.graphyard/master-actions/`, appending to `ledger.json`. Approving its *Confirm access* GitHub Mobile code on the device is human-only. The master never stores the profile's cookies, and must never use a merge bypass, push code or read a worker credential.

## Harness permissions

A harness classifier refuses routine administration; `master harness claude --apply` (Codex: `master harness codex`) writes rules to `.claude/settings.local.json`.

## Typed actions and executors

Each item has one typed action (`nextAction`): `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment` or `escalate`. Executors claim rows under their own credential; `escalate` and `request-rework` are judgements (`actions.needsHuman`). `graphyard init` starts `graphyard-executor@N` user units; `master executors restart` moves them to the current release. After a verified deployment the loop moves a clean detached checkout to the base tip (else `upgrade` attention); `src/`, `scripts/`, `bin/` or `package.json` changes restart executors, then the loop. `releaseLag` flags >1-delivery lag past 10 minutes. A moved checkout exits the executor 0 for systemd to restart; one killed mid-action is named with its item in `master status`.

A rework or guarded merge awaiting freshness wakes its observation job and retries once that observation lands, not on backoff: a merge the gate calls stale is not asked; one the server refuses (`Merge authorization is no longer current`) awaits its wake's observation. A wake stands five minutes (a failed one retries next cycle); GitHub pauses suppress wakes.

A `resync` completes only on a fresh observation. The executor calls `POST /api/work/:id/resync` with `{ since }`, its claim time; the server wakes the item's observation job, answering `observed`, `observedAt` and its `job` (`availableAt`, `lockedUntil`, `attempts`, `error`, `heldUntil`, `heldReason`). `wake: false` only reads. Unobserved, the claim fails at once with `no observation newer than the claim was saved` and its job's condition, then backs off. A job that is scheduled with no hold or error is a wait in progress: its failures stall the row only once they span thirty minutes, the bound any wait on an event is given; a held, failed or missing job stalls it after three. Row bookkeeping (claim, renew, settle) never refuses an observation read before it; other changes do.

A `dispatch` or `request-review` whose launch finds a producer or reviewer session already answering the requested head completes on that session instead of failing. Three failures with an unchanged reason mark a row stalled rather than retrying (a fleet that looks idle): once in no count and no list, it shows in `actions.stalled` and on the item's own card; backoff, doubling from one minute, never outlives it. Eight escalate it (half-hourly); ticks requeue ownerless items (`liveness.violations`).

### Loop failure recovery

A failed snapshot read retries once after 0.5–1.5 s; a failed cycle waits min(interval, 30 s), doubling to the ceiling. One item's throw fails only its `isolated:KIND:ITEM-ID` action.

## Resources and disk

`resourceRegistry` declares every bounded resource, reported under `resources` ([remedies](operations-reference.md#control-plane-resources)). The loop `git worktree remove`s finished worktrees (`run.reclaimIdleHours`; never dirty/unpushed), `run.worktreeRemovalLimit`/cycle, logging `.graphyard/worktree-reclaim.jsonl`, and stale `/tmp/graphyard-*`, `tsx-<uid>` directories (dead owner or 6h idle; unheld; ≤100/cycle, one pass in flight); `disk` attention below `run.diskThresholdGb`. Review and proof checkouts live under `run.worktreeRoot` (default `~/.local/share/graphyard/worktrees/REPOSITORY-ID`). Agentless panes a Graphyard launch on this host left behind are swept each cycle ([panes](master-agent-sessions.md#panes-are-closed-and-reclaimed)).

## Recovery

A dead supervisor fences its item; `containment` lists each surviving process's pid, cmdline and cwd. With `settleable: true` run `master settle-containment GY-N REASON`; otherwise stop the recorded scope unit (`containment.scope`) and request `rework`.

An unexplained lapsed lease raises `lease-loss` (`blocked-awaiting-operator` and `stopped-by-attestation` lapses are history); any admin settles an explained one with `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). 

`master escalation GY-N` spawns a handler answering with `master decide GY-N resolve … --context FINGERPRINT REASON`.

## Fault classes

Faults carry `faultClass` (`master status` `faults`); recurring classes file one item (`GRAPHYARD_FAULT_CLASS_*`); moving hashes never reopen a standing fault. A failed section is listed only in `unavailable`.

## Pipeline speed

Target: submit→merge p50 ≤ 30 minutes and p90 ≤ 60 minutes over ten-plus deliveries. Each row's `speed` carries `executionMs`, `waitMs`, `reworkRounds` and `interventions`; `speed.submitToMerge` gives the verdict. `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.
