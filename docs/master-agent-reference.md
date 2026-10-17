<!-- page: Operate Graphyard | 7 | executors, GitHub. -->
# Master-agent reference

## Items, scope and human waits

Unplanned file: `scope-request GY-N EPOCH PATH… [--wait] -- REASON`; auto-granted if grounded (fault-class machinery; trusted failed-check `PATH:LINE` quoted); non-repository paths refused; else `approve-scope`; `master scope GY-N [--allow-broad-scope] REASON` applies refusals; transport-failed widens retry, never stands; a live lease's additive multi-path refusal waits 15min, others stand; attempt ends close requests, `master unblock GY-N` closes carried; `held`: applied at attempt end, never re-requested; covering revision watched. Human: `park GY-N EPOCH KIND NEEDED --ask ASK --recommend TEXT --why WHY [--choice LABEL]… -- REASON` ([Needs you](dashboard.md#needs-you)); `answer GY-N …`; `master decide GY-N withdraw-park REASON`; [host-doable](deployment.md) and criterion-rewrite asks ([requirements decisions](glossary.md#who-decides)) refused; bare `requirements` (no AC-N, criteria, or key with tests/ path) names the rewrite as work: whether it lands, succeeds or is ordered parks; a change verb on the requirements or a named object refuses.

## Promotion to autonomy

`graphyard master promote --admin-token-stdin` makes supervised installs autonomous; `master autonomy --apply` refuses there, `master.json` edits skip checks. Refuses until reviewer App and profile exist, its bot none of your `gh` login, `operatorLogin`, worker App or principals; logs `.graphyard/master-actions/promotions.jsonl`, provisions operator-agent and approver, writes `supervision: autonomous`; no demotion.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`. Approvals survive base refreshes ([carry](github.md#bindings-and-carry)); a current-head one dismissed `The merge-base changed after approval.` is restored, never re-posted. A branch must never keep another item's unlanded commits (build gate refuses): `git reset --hard REVIEWED_HEAD`, `sync GY-N`, `restore-branch GY-N EPOCH`.

## GitHub administration through the browser

`master protection --apply` reconciles protection; flows (`master browser app-permissions`, `master browser installation-accept`, `master browser protection`) drive the `master init --browser-profile` profile:

| Flow | Effect
| --- | ---
| `app-permissions` | Permissions raised
| `installation-accept` | Requests accepted
| `protection` | Protection reconciled

Flows read `GET /api/github/installation`, recording `.graphyard/master-actions/` (`record.json`, `ledger.json`, redacted Confirm-access markup: `master browser fixtures`); a criterion needing a live one runs `master browser capture [--dry-run]` on the sudo-protected App permissions page, submitting nothing, never a human, following each offered method's control as a button or a link; a refused capture's record names the controls it saw. Approving *Confirm access* GitHub Mobile on device: human-only; master never stores cookies, uses merge bypass, pushes code, reads worker credentials. On classifier refusals `master harness claude|codex --apply` writes `.claude/settings.local.json` rules denying `gh pr merge`/`review`, token-minting or mutating `gh api`; missing/retired rules: `harness` drift, reapplied each cycle to the loop's CLI checkout; `master status` too.

## Typed actions and executors

`nextAction` (one per item): `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`; judgements: `actions.needsHuman`. `init` starts executors; `master executors restart` refreshes slots; verified deployments advance clean checkouts, restart executors and loop. `resync` needs newer observation. `dispatch`/`request-review` complete if a session answers the head; busy profiles stall after 30min. Three failures, unchanged reason: stalled rather than retrying (fleet looks idle; plane-wide failures, human-only parks, a promotion's `verify-deployment` failure within `promotionWaitBoundMs` (60min), never stall); in no count and no list, but in `actions.stalled` and on the item's own card; backoff never outlives it; eight escalate. Ticks requeue ownerless items (`liveness.violations`). One origin fetch per dispatch cycle builds its worktrees, even late-launched; each dispatch records preparation time (`master status` `launches.prepare`: daily p50/p90).

Declared slot not `active`: `resources` fault naming `journalctl --user -u graphyard-executor@N.service` unless stopped <2min; `--install` needs `Restart=always`, `RestartSec` ≤60s. Worker starts fenced <2min retry after lapse; longer fail, named.

## Recovery

Dead supervisor fences item; `containment` lists survivors' pid, cmdline and cwd: `settleable: true` → loop settles; past grace+10min `master settle-containment GY-N REASON`, else stop recorded scope unit (`containment.scope`), request `rework`. Unexplained lapses raise `lease-loss` (`blocked-awaiting-operator`/`stopped-by-attestation`: history); admins settle explained: `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns handler: `master decide GY-N resolve … --context FINGERPRINT REASON`. Named-reset exhaustion holds login twins fleet-wide.

### Producer-runtime faults

Unacted producer requests (unstarted/refused/launch-exited) relaunch on untried profile.

## Fault classes

`faultClass` (`master status` `faults`): recurring classes file one item each; instances predating a delivered class's fix-running landing link there; triage proposes closing items holding only those, withdrawn on post-running links; doctor matches standing/cover; a resource at bound files `resource:ID`; three straight >60s cycles (restart-safe) file `slow-loop:RELEASE:STEP` naming p50/p95, step, call; filings outlive releases; asks replay per key, backing off; `fleet-capacity`/`unanswered-request` (past `settledAnswerGraceMs`), `configuration`/`decision-unanswered`/`unclassified` unless (`plane-unavailable`/`fix-item`/`decision-stale`/`overlong-session`). Review unlaunched 15min: `concurrency-starved`/`review-settlement`/`launch-review`; gh pauses `github-budget`. Fleet-held claimable items past 20min file `concurrency-starved` (`capacity:<id>`), keeping their age. `no master role` blockers group as `configuration`, not `stalled-gate`. Pre-start launch failures: one; a finished lease-holder files `session` past the orphan watch and gone-worker preserve.

## Shadow merge gate

`run.shadowGate` (`enabled` true, `timeoutMinutes` 20): each cycle trial-merges/builds/affected-tests oldest untried head credential-free in sticky tmp-reclaimed `TMPDIR` (`gy-t*`), pushing nothing; `shadow.verdict` joins GitHub's outcome in `shadowGate` (`shadow-only-fail`/`shadow-missed`: a line each, merger `github`); errors/timeouts record nothing; third timeout one line. `GET /api/shadow-disagreements`, `/api/shadow-explanations?pair=KEY:HEAD:BASETIP`.

## Pipeline speed

Target: submit→merge p50 ≤30 minutes, p90 ≤60 minutes. Row `speed`: `executionMs`, `waitMs`, `reworkRounds`, `interventions`; verdict `speed.submitToMerge`; `scripts/measure-pipeline-speed.mjs` feeds `manual:speed-target-met`.

Steps calling an approver, decision or session budget two-fifths of the interval (30s floor), each call 10s or what's left; a slower one is carried (`waiting`, no fault), retried next cycle, joining it or consuming its answer, kept while its row stands; spent, it starts none; one `decision.*` ledger read names moved items, an unmoved history is kept unread. Master/merge-mode/record/triage-phase calls too.
