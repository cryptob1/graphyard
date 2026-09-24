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

A worker needing a file outside `plannedFiles` runs `scope-request GY-N EPOCH PATH… -- REASON`: documentation, files the criteria name and, for items planning `docs/`, single files under `web/` and `browser-tests/` widen automatically; refusals are re-decided per policy revision. Refused additive requests widen, as operator-agent, to files an unresolved reviewer or `run.awaitReviewers`-bot thread, or the reviewer's current-head `CHANGES_REQUESTED` review, names literally, citing its id, during the asker's lease (rechecked every two minutes); only files on the freshly fetched base: never directories or new files. One needing a human-only decision runs `park GY-N EPOCH KIND NEEDED -- REASON`, and the item waits under **Work → Needs you** for `graphyard answer GY-N …`.

## Conflict avoidance

Dispatch takes smallest planned scope first and holds overlapping items (`--allow-overlap` overrides); `git merge-tree` reports real conflicts between open candidates under `conflicts` ([rules](coordination.md#schedule-by-overlap-smallest-scope-first)).

### Speculative tips and branch protection

**An approval must survive a tip publication.** It carries when the predecessor changed no reviewed file.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** An approval of the current head dismissed with `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`); no other dismissal is.

**A branch must never keep another item's unlanded commits.** Tips are built from the reviewed head, and an ejection restores the branches it leaves behind (`baseRefresh.restore`).

#### A contaminated branch

A branch carrying another item's unlanded commits is listed under `branches.contaminated`: run `master repair GY-42 The branch carries GY-40's ejected tip`.

A worker restores its own branch with `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, then `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

The master reconciles protection through the API (`master protection --apply`); where GitHub offers only a page, `master browser FLOW` drives the browser profile from `master init --browser-profile`: `master browser app-permissions`, `master browser installation-accept` or `master browser protection`.

| Flow | What it does |
| --- | --- |
| `app-permissions` | Raises the App's permissions to the declaration |
| `installation-accept` | Accepts the pending permission request |
| `protection` | Reconciles branch protection |

Each flow records `record.json` under `.graphyard/master-actions/` and appends to `ledger.json`. On *Confirm access* it shows the GitHub Mobile two-digit code; approving it on the device is the human-only part. The master never stores the profile's cookies, and must never use a merge bypass, push code or read a worker credential.

## Harness permissions

A harness classifier refuses routine administration, so `master harness claude --apply` writes allow and deny rules to `.claude/settings.local.json` (Codex: `master harness codex`).

## Typed actions and executors

The control plane names one typed action per item (`nextAction`): `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment` or `escalate`. Executors claim rows under their own credential; `escalate` and `request-rework` are judgements, listed under `actions.needsHuman`.

Three consecutive failures with an unchanged reason mark a row stalled rather than retrying: the signal for a fleet that reads as idle and is not. Once in no count and no list, it shows in `actions.stalled` and on the item's own card, rechecking every minute: backoff never outlives its cause.

### Running executors under supervision

`graphyard init` on a coordinator host starts `graphyard-executor@N` systemd user units; `master executors restart` moves them onto the current release.

## Resources and disk

`resourceRegistry` declares every bounded resource, reported under `resources` ([remedies](operations-reference.md#control-plane-resources)). The loop removes dependency directories of finished worktrees (`run.reclaimIdleHours`) and raises `disk` attention below `run.diskThresholdGb`.

### The managed worktree root

Review and proof checkouts live under `run.worktreeRoot` (default `~/.local/share/graphyard/worktrees/REPOSITORY-ID`, never tmpfs).

## Recovery

A dead supervisor leaves its item fenced; `containment` lists each surviving process with pid, cmdline and cwd. With `settleable: true` run `master settle-containment GY-N REASON`; otherwise stop the recorded scope unit (`containment.scope`) and request `rework`.

A lease that lapsed unexplained raises `lease-loss`; `blocked-awaiting-operator` and `stopped-by-attestation` lapses are history. Any admin settles an explained one with `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([who may settle what](delegation.md#who-may-settle-what)). 

`master escalation GY-N` spawns a handler that answers with `master decide GY-N resolve … --context FINGERPRINT REASON` (`master context GY-N` prints the context).

## Pipeline speed

The target is submit→merge p50 ≤ 30 minutes and p90 ≤ 60 minutes over at least ten deliveries. Each row's `speed` carries `executionMs`, `waitMs`, `reworkRounds` and `interventions`; `speed.submitToMerge` gives the verdict. `node scripts/measure-pipeline-speed.mjs [--split GY-N] [--record DIR]` records what `manual:speed-target-met` reads. Never trade a gate or proof for the number.
