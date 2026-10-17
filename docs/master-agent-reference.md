<!-- page: Operate Graphyard | 7 | executors, GitHub. -->
# Master-agent reference

## Items, scope and human waits

Unplanned file: `scope-request GY-N EPOCH PATH… [--wait] -- REASON`; auto-granted if grounded; non-repository paths refused; else `approve-scope`; `master scope GY-N [--allow-broad-scope] REASON` applies refusals; transport-failed widens retry, never stands; a live lease's additive multi-path refusal waits 15min, others stand at once; ending attempts close requests, `master unblock GY-N` closes carried; `held`: mid-attempt requirements approvals apply post-attempt. Human: `park GY-N EPOCH KIND NEEDED --ask ASK --recommend TEXT --why WHY [--choice LABEL]… -- REASON` ([Needs you](dashboard.md#needs-you)); `answer GY-N …`; `master decide GY-N withdraw-park REASON` out of band; [host-doable](deployment.md) and criterion-rewrite asks ([requirements decisions](glossary.md#who-decides)) refused; bare `requirements` (no AC-N, criteria, or tests/ key) parks the rewrite as work; a change verb on the requirements or a named object refuses.

## Promotion to autonomy

`graphyard master promote --admin-token-stdin` makes supervised installs autonomous; `master autonomy --apply` refuses there. Refuses until reviewer App and profile exist, its bot none of your `gh` login, `operatorLogin`, worker App or principals; logs promotions, provisions operator-agent and approver, writes `supervision: autonomous`; no demotion.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`. Approvals survive base refreshes ([carry](github.md#bindings-and-carry)); a dismissed merge-base change is restored. A branch must never keep another item's unlanded commits: `git reset --hard REVIEWED_HEAD`, `sync GY-N`, `restore-branch GY-N EPOCH`.

## GitHub administration through the browser

`master protection --apply` reconciles protection; flows (`master browser app-permissions`, `master browser installation-accept`, `master browser protection`) drive the `master init --browser-profile` profile:

| Flow | Effect
| --- | ---
| `app-permissions` | Permissions raised
| `installation-accept` | Requests accepted
| `protection` | Protection reconciled

Flows read `GET /api/github/installation`, recording `.graphyard/master-actions/` (`record.json`, `ledger.json`, redacted Confirm-access markup: `master browser fixtures`); a criterion needing a live one runs `master browser capture [--dry-run]` on the sudo-protected App permissions page, submitting nothing, never a human, following each offered method's control as a button or a link; a refused capture's record names the controls it saw. Approving *Confirm access* GitHub Mobile on device: human-only; master never stores cookies, merge-bypass, pushes code, or worker credentials. On classifier refusals `master harness claude|codex --apply` writes `.claude/settings.local.json` rules denying `gh pr merge`/`review`, token-minting or mutating `gh api`; missing/retired rules: `harness` drift, reapplied each cycle; `master status` too.

## Typed actions and executors

`nextAction` (one per item): `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`; judgements: `actions.needsHuman`. `init` starts executors; `master executors restart` refreshes; verified deployments advance clean checkouts, restart executors and loop. `resync` needs newer observation. `dispatch`/`request-review` complete if a session answers the head; busy profiles stall after 30min. Three failures, unchanged reason: stalled (not plane-wide, human-only parks, or promotion `verify-deployment` within `promotionWaitBoundMs`); in `actions.stalled`; eight escalate. Ticks requeue ownerless items (`liveness.violations`). One origin fetch per cycle; `launches.prepare` records daily p50/p90.

Declared slot not `active`: `resources` fault naming `journalctl --user -u graphyard-executor@N.service` unless stopped <2min; `--install` needs `Restart=always`, `RestartSec` ≤60s. Worker starts fenced <2min after lapse; longer fail.

## Recovery

Dead supervisor fences item; `containment` lists survivors' pid, cmdline and cwd: `settleable: true` → loop settles; past grace+10min `master settle-containment GY-N REASON`, else stop recorded scope unit (`containment.scope`), request `rework`. Unexplained lapses raise `lease-loss`; admins settle: `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns: `master decide GY-N resolve … --context FINGERPRINT REASON`. Named-reset exhaustion holds login twins.

### Producer-runtime faults

Unacted producer requests (unstarted/refused/launch-exited) relaunch on untried profile.

## Fault classes

`faultClass` (`master status` `faults`): recurring classes file one item each; instances predating a delivered class's fix-running landing link there; triage proposes closing items holding only those, withdrawn on post-running links; doctor matches standing/cover; a resource at bound files `resource:ID`; three straight >60s cycles (restart-safe) file `slow-loop:RELEASE:STEP` naming p50/p95, step, call; filings outlive releases; asks replay per key, backing off; `fleet-capacity`/`unanswered-request` (past `settledAnswerGraceMs`), `configuration`/`decision-unanswered`/`unclassified` unless (`plane-unavailable`/`fix-item`/`decision-stale`/`overlong-session`). Review unlaunched 15min: `concurrency-starved`/`review-settlement`/`launch-review`; gh pauses `github-budget`. Fleet-held claimable items past 20min file `concurrency-starved` (`capacity:<id>`). `no master role` → `configuration`, not `stalled-gate`. Pre-start launch failures: one; finished lease-holder files `session` past orphan watch.

## Shadow merge gate

`run.shadowGate` (`enabled` true, `timeoutMinutes` 20): trial-merges/builds/affected-tests oldest untried head credential-free in sticky tmp-reclaimed `TMPDIR` (`gy-t*`), pushing nothing; `shadow.verdict` (failing: runner-ran files, 4000-char `logTail`) joins GitHub's outcome in `shadowGate` (`shadow-only-fail`/`shadow-missed`); errors/timeouts record nothing; third timeout one line. `GET /api/shadow-disagreements`, `/api/shadow-explanations?pair=KEY:HEAD:BASETIP`.

## Pipeline speed

Target: submit→merge p50 ≤30min, p90 ≤60min. Row `speed`: `executionMs`, `waitMs`, `reworkRounds`, `interventions`; verdict `speed.submitToMerge`; `scripts/measure-pipeline-speed.mjs` feeds `manual:speed-target-met`.

Steps calling an approver, decision or session budget two-fifths of the interval (30s floor), each call 10s or what's left; a slower one is carried (`waiting`, no fault), retried next cycle, joining it or consuming its answer, kept while its row stands; spent, it starts none; one `decision.*` ledger read names moved items, an unmoved history is kept unread. Master/merge-mode/record/triage-phase calls too.

## Loop-step stalls

A loop step or dispatcher call failing with one normalised signature on three consecutive cycles is one stall (`daemon.stepStalls`); while it stands its failing call is retried at most once per five minutes, a bound remedy is applied once and verified, and a stall needing the master wakes it with signature, step, count. Past six uncleared cycles the loop files exactly one upstream item per signature, into the install `.graphyard/master.json` names as `upstream` or into itself, deduplicated by signature; `master status` lists each stall with signature, count, remedy and owner.
