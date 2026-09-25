<!-- page: Operate Graphyard | 7 | scheduling, executors, GitHub administration. -->
# Master-agent reference

## Master commands

These need judgement:

| Command | Purpose |
| --- | --- |
| `master repair GY-N REASON` | Restore a contaminated branch to its reviewed head |
| `master settle-containment GY-N REASON` | Settle a quarantine whose supervisor is verified gone |
| `master scope GY-N [--allow-broad-scope] REASON` | Apply a scope request the loop refused |

## Items, scope and human waits

A worker needing a file outside `plannedFiles` runs `scope-request GY-N EPOCH PATH… -- REASON`. Documentation, files the criteria name and, for items planning `docs/`, single files under `web/` and `browser-tests/` widen automatically; so do existing base files an unresolved reviewer or `run.awaitReviewers`-bot thread, or the reviewer's current-head `CHANGES_REQUESTED` review, names literally (unnegated; rechecked every two minutes), and tests whose quoted failing assertion a planned file holds. The independent approver judges the rest (`--allow-broad-scope` needs a stated reason); the worker keeps its lease, reading the outcome via `scope-request GY-N EPOCH --wait`. A human-only decision needs `park GY-N EPOCH KIND NEEDED -- REASON`; the item waits under **Work → Needs you** for `graphyard answer GY-N …`.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first; `git merge-tree` reports conflicts between candidates under `conflicts` ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)).

### Speculative tips and branch protection

**An approval must survive a tip publication.** It carries when the predecessor changed no reviewed file.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** An approval of the current head dismissed with `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`); no other dismissal is.

**A branch must never keep another item's unlanded commits.** Tips are built from the reviewed head, and an ejection restores the branches it leaves behind (`baseRefresh.restore`).

#### A contaminated branch

A branch carrying another item's unlanded commits is listed under `branches.contaminated`: run `master repair GY-42 REASON`.

A worker restores its own branch with `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, then `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

Protection reconciles through `master protection --apply`; where GitHub offers only a page, `master browser FLOW` drives the profile from `master init --browser-profile`: `master browser app-permissions`, `master browser installation-accept` or `master browser protection`.

| Flow | What it does |
| --- | --- |
| `app-permissions` | Raises the App's permissions to the declaration |
| `installation-accept` | Accepts the pending permission request |
| `protection` | Reconciles branch protection |

Each flow records `record.json` under `.graphyard/master-actions/` and appends to `ledger.json`. Approving its *Confirm access* GitHub Mobile code on the device is human-only. The master never stores the profile's cookies, and must never use a merge bypass, push code or read a worker credential.

## Harness permissions

A harness classifier refuses routine administration, so `master harness claude --apply` writes allow and deny rules to `.claude/settings.local.json` (Codex: `master harness codex`).

## Typed actions and executors

The control plane names one typed action per item (`nextAction`): `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment` or `escalate`. Executors claim rows under their own credential; `escalate` and `request-rework` are judgements, listed under `actions.needsHuman`.

Three failures with an unchanged reason mark a row stalled rather than retrying: a fleet that looks idle and is not. Once in no count and no list, it shows in `actions.stalled` and on the item's own card; backoff never outlives it, doubling from one minute. Eight escalate it, retried half-hourly; ticks requeue ownerless items (`liveness.violations`).

### Loop failure recovery

A failed snapshot read retries once after 0.5–1.5 s jitter; a failed cycle waits min(interval, 30 s), doubling to the ceiling. One item's throw fails only its `isolated:KIND:ITEM-ID` action.

### Running executors under supervision

`graphyard init` on a coordinator host starts `graphyard-executor@N` systemd user units; `master executors restart` moves them onto the current release.

## Resources and disk

`resourceRegistry` declares every bounded resource, reported under `resources` ([remedies](operations-reference.md#control-plane-resources)). The loop removes dependency directories of finished worktrees (`run.reclaimIdleHours`) and raises `disk` attention below `run.diskThresholdGb`.

### The managed worktree root

Review and proof checkouts live under `run.worktreeRoot` (default `~/.local/share/graphyard/worktrees/REPOSITORY-ID`).

## Recovery

A dead supervisor leaves its item fenced; `containment` lists each surviving process with pid, cmdline and cwd. With `settleable: true` run `master settle-containment GY-N REASON`; otherwise stop the recorded scope unit (`containment.scope`) and request `rework`.

A lease that lapsed unexplained raises `lease-loss`; `blocked-awaiting-operator` and `stopped-by-attestation` lapses are history. Any admin settles an explained one with `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([who may settle what](delegation.md#who-may-settle-what)). 

`master escalation GY-N` spawns a handler that answers with `master decide GY-N resolve … --context FINGERPRINT REASON`.

## Pipeline speed

The target is submit→merge p50 ≤ 30 minutes and p90 ≤ 60 minutes over at least ten deliveries. Each row's `speed` carries `executionMs`, `waitMs`, `reworkRounds` and `interventions`; `speed.submitToMerge` gives the verdict. `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.
