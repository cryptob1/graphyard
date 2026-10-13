<!-- page: Operate Graphyard | 7 | executors, GitHub. -->
# Master-agent reference

## Items, scope and human waits

Unplanned file: `scope-request GY-N EPOCH PATH… [--wait] -- REASON`; auto-granted if grounded (docs; criteria/follow-up/finding paths; `web/`/`browser-tests/` for `docs/` planners; pinning tests; symbol defs; successors; companions: budget, timing/wall-clock gates, `manual:fault-class-*`, importing tests, imports). Else `approve-scope`; `master scope GY-N [--allow-broad-scope] REASON` applies refused ones (`master decisions`); `--wait` ≤15 min. Transport-failed widens retry; under a live lease an approver refusal of an additive multi-path ask is no fault inside the 15-min bound; it stands past it, or at once for a non-additive or one-path ask. An ended lease's request is moot. Ending attempts close requests; `master unblock GY-N` closes carried. `held`: requirements approved mid-attempt apply when it ends; never re-request. Covering revision: watched. Human: `park GY-N EPOCH KIND NEEDED --ask ASK [--step STEP]… --recommend TEXT --why WHY [--choice LABEL]… -- REASON` ([Needs you](dashboard.md#needs-you)); `graphyard answer GY-N …`; [host-doable](deployment.md), refused.

## Promotion to autonomy

`graphyard master promote --admin-token-stdin` makes a supervised install autonomous; `master autonomy --apply` refuses on it, `master.json` edits skip checks. Refuses until a reviewer App and profile exist, its bot none of your `gh` login, `operatorLogin`, worker App or principals; then logs who, reviewer, time to `.graphyard/master-actions/promotions.jsonl`, provisions operator-agent and approver, writes `supervision: autonomous`; no demotion.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`. Approvals survive base refreshes ([carry](github.md#bindings-and-carry)); one on current head dismissed `The merge-base changed after approval.` is restored, never re-posted. A branch must never keep another item's unlanded commits (build gate refuses): `git reset --hard REVIEWED_HEAD`, `sync GY-N`, `restore-branch GY-N EPOCH`.

## GitHub administration through the browser

`master protection --apply` reconciles protection; flows (`master browser app-permissions`, `master browser installation-accept`, `master browser protection`) drive the `master init --browser-profile` profile:

| Flow | Effect
| --- | ---
| `app-permissions` | Raise App permissions to declaration
| `installation-accept` | Accept pending requests
| `protection` | Reconcile branch protection

Flows read `GET /api/github/installation`, recording `.graphyard/master-actions/` (`record.json`, `ledger.json`, redacted Confirm-access markup: `master browser fixtures`); a criterion needing a live one runs `master browser capture [--dry-run]` on the sudo-protected App permissions page, submitting nothing, never a human. Approving *Confirm access* GitHub Mobile on device: human-only; master never stores cookies, uses merge bypass, pushes code, reads worker credentials. On classifier refusals `master harness claude|codex --apply` writes `.claude/settings.local.json` rules denying `gh pr merge`/`review`, token-minting or mutating `gh api`; missing or retired rules are `harness` drift the loop reapplies each cycle to its CLI checkout (no unit record: self-recorded, else waits); `master status` too (read-only).

## Typed actions and executors

`nextAction` (one per item): `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`; judgements: `actions.needsHuman`. `init` starts executors; `master executors restart` updates stale slots; verified deployments advance clean checkouts, restart executors and loop. `resync` needs a newer observation. `dispatch`/`request-review` complete when a session already answers the head; busy profiles stall after 30min. Three failures, unchanged reason: stalled rather than retrying (fleet looks idle; a plane-wide failure or human-only park is no stall); in no count and no list, but in `actions.stalled` and on the item's own card; backoff never outlives it; eight escalate. Ticks requeue ownerless items (`liveness.violations`).

Declared slot not `active`: `resources` fault naming `journalctl --user -u graphyard-executor@N.service` unless stopped <2min. `--install` needs `Restart=always`, `RestartSec` ≤60s. Worker starts fenced <2min retry after lapse; longer fail, named.

## Recovery

Dead supervisor fences item; `containment` lists survivors' pid, cmdline and cwd: `settleable: true` → loop settles; past grace+10min `master settle-containment GY-N REASON`, else stop recorded scope unit (`containment.scope`), request `rework`. Unexplained lapses raise `lease-loss` (`blocked-awaiting-operator`, `stopped-by-attestation`: history); admins settle explained: `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns handler: `master decide GY-N resolve … --context FINGERPRINT REASON`. Named-reset exhaustion holds login twins fleet-wide.

### Producer-runtime faults

Unacted producer requests (unstarted, refused, launch-exited) relaunch on untried profile.

## Fault classes

`faultClass` (`master status` `faults`): recurring classes file one item each; instances predating a delivered class item's landing (not opening) link there; triage proposes closing items holding only those, withdrawn on post-landing links; doctor matches standing/cover; a resource at bound files `resource:ID`; also `fleet-capacity`, `unanswered-request` (past `settledAnswerGraceMs`), `configuration`, `decision-unanswered`, and `unclassified` unless (`plane-unavailable`, `fix-item`, `decision-stale`, `overlong-session`). Review unlaunched 15min: `concurrency-starved`, `review-settlement`, `launch-review`. Unanswering planes: `plane-unavailable`. A `no master role` blocker groups as `configuration`, not `stalled-gate`. Pre-start launch failures: one.

## Shadow merge gate

`run.shadowGate` (`enabled` true, `timeoutMinutes` 20): each cycle trial-merges, builds, affected-tests oldest untried head credential-free in sticky tmp-reclaimed `TMPDIR` (`gy-t*`) pushing nothing; `shadow.verdict` (failing: runner-ran files, 4000-char `logTail`) joins GitHub's outcome in `shadowGate` (`shadow-only-fail`/`shadow-missed`: a line each, merger `github` only); errors/timeouts/poisoning record nothing; third timeout one line. `GET /api/shadow-disagreements`, `/api/shadow-explanations?pair=KEY:HEAD:BASETIP`.

## Pipeline speed

Target (10+ deliveries): submit→merge p50 ≤30 minutes, p90 ≤60 minutes. Row `speed`: `executionMs`, `waitMs`, `reworkRounds`, `interventions`; verdict `speed.submitToMerge`; `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.

Loop's decisions step keeps its two-fifths interval budget (30 s floor): each approver call is bound to 10 s or the budget left, a slower one stays owed; one `decision.*` ledger read names moved items; a history whose ledger has not moved is kept, not read. Standing/held/approved-resume waits stay live (no fault); quarantine pauses matching held asks; covering fail clears; 5xx/stale retries unless moot.
