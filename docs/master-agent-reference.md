<!-- page: Operate Graphyard | 7 | executors, GitHub. -->
# Master-agent reference

## Items, scope and human waits

Unplanned file: `scope-request GY-N EPOCH PATH… [--wait] -- REASON` (flags before `--` refused); auto-granted if grounded: docs; files criteria, follow-ups or findings name; `web/`/`browser-tests/` for `docs/` planners; tests pinning planned text; symbol definitions; successors; companions (docs-budget gate, timing baseline, importing tests, planned modules' imports/importers). Else an `approve-scope` executor or loop replays standing decisions or asks an approver (partial grant's rest same cycle); `master scope GY-N [--allow-broad-scope] REASON` applies refused requests save approver's (routed, or refused <15 min ago: `master decisions`). Leases stay (`--wait` reads outcome). Ending attempts (submit, release, lapse, rework, requirements) close requests `attempt ended`; `master unblock GY-N` closes stale ones. Human decisions: `park GY-N EPOCH KIND NEEDED --ask ASK [--step STEP]… --recommend TEXT --why WHY [--choice LABEL]… -- REASON` ([Needs you](dashboard.md#needs-you)); `graphyard answer GY-N …`.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`. Approvals survive base refreshes ([carry](github.md#bindings-and-carry)); one on the current head dismissed `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`), re-post no verdict (`observation.dismissedReviewIds`). A branch must never keep another item's unlanded commits (build gate refuses); the worker runs `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

`master protection --apply` reconciles protection; page-only flows, `master browser FLOW` (`master browser app-permissions`, `master browser installation-accept`, `master browser protection`), drive the `master init --browser-profile` profile:

| Flow | Effect
| --- | ---
| `app-permissions` | Raise App permissions to declaration
| `installation-accept` | Accept pending requests
| `protection` | Reconcile branch protection

Flows read `GET /api/github/installation`, recording `.graphyard/master-actions/` `record.json`, `ledger.json`. Approving *Confirm access* GitHub Mobile code on device is human-only; the master never stores profile's cookies, uses merge bypass, pushes code or reads a worker credential. On classifier refusals `master harness claude --apply` (or `master harness codex`) writes `.claude/settings.local.json` rules denying `gh pr merge`/`review`; `gh api` `pulls/N/merge`, `repos/R/merges`, `merge-upstream`, `pulls/N/reviews`, `access_tokens`, `PUT`/`POST`/`DELETE`; `gh api graphql` with `mutation` or `=@`/`--input`. Missing/retired rules (`gh api *merge*`, `gh api graphql*`): `harness` drift, repaired by `master status`.

## Typed actions and executors

`nextAction` (one per item): `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`; judgements (`escalate`, `request-rework`): `actions.needsHuman`. `graphyard init` starts `graphyard-executor@N` user units (own credentials), moved to a release by `master executors restart` or a verified deployment (clean checkouts to base tip, then loop; dirty: `upgrade` attention). Fenced (`POST /api/actions/presence`) or claim-renewing executors live (never `Nothing can run KIND`); polls, renewals upsert `executor_presence` (no event; read at once after restarts); an empty fleet needs evidence (a poll; rows, or an empty table recording since its first read's marker, older than 120s), not process age. `resync` (`POST /api/work/:id/resync` `{ since }`) completes only on an observation newer than its claim. `dispatch`/`request-review` complete on a session already answering the head; standing verdicts block second reviewers until dismissed; busy/reserved profiles stall after 30 minutes. Three failures with an unchanged reason mark a row stalled rather than retrying (a fleet that looks idle): in no count and no list, but in `actions.stalled` and on the item's own card; backoff never outlives it; eight escalate. Ticks requeue ownerless items (`liveness.violations`).

## Recovery

A dead supervisor fences its item; `containment` lists survivors' pid, cmdline and cwd: with `settleable: true` run `master settle-containment GY-N REASON`, else stop the recorded scope unit (`containment.scope`) and request `rework`. Unexplained lapses raise `lease-loss` (`blocked-awaiting-operator`, `stopped-by-attestation` lapses are history); any admin settles explained one with `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns handler answering `master decide GY-N resolve … --context FINGERPRINT REASON`.

### Producer-runtime faults

Unacted producer requests (never started, launch refused, exited at launch) relaunch on an untried profile, requesting no rework.

## Fault classes

`faultClass` (`master status` `faults`): recurring classes file one item (`GRAPHYARD_FAULT_CLASS_*`); resource at bound is one `resource:ID` fault; `fleet-capacity`, workless sessions; `unanswered-request`, settled requests unanswered past `settledAnswerGraceMs` (5 min); `configuration`, sandbox or `workflows`-permission refusals; `decision-unanswered` (`decision`), not `loop-silence`, decision silently awaiting its approver; doctor commands its allowlist refused: done; failed `action:fault`/`action:diagnosis`: `unclassified` unless site names the cause (`plane-unavailable`, `fix-item`, `decision-stale`). A review unlaunched 15 min: `concurrency-starved` (capacity) if every reviewer profile is busy, `review-settlement` (review-convergence) if one answered (aged from the verdict; the tick wakes the observation), else `launch-review`. Unanswering planes (502-504, refused, timeout) raise one `plane-unavailable` (`deployment`) fault; what met it retries faultlessly; `planeWaitMs` isn't `loop-cost`.

## Pipeline speed

Target (ten-plus deliveries): submit→merge p50 ≤30 minutes, p90 ≤60 minutes. Row `speed`: `executionMs`, `waitMs`, `reworkRounds`, `interventions`; verdict `speed.submitToMerge`; `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.

The loop's decisions step stays within 10 s a cycle at ~90 open items: one `decision.*` ledger read names moved items, rereading only those; a history whose ledger has not moved is kept, not read. Widenings refused by 5xx or stale revision, and decisions or withdrawals whose history read times out, retry next cycle (two running: fault); moot ones (delivered, request answered, lease ended, head moved) count none.
