<!-- page: Operate Graphyard | 7 | executors, GitHub. -->
# Master-agent reference

## Items, scope and human waits

Unplanned file: `scope-request GY-N EPOCH PATH… [--wait] -- REASON`; auto-granted if grounded: docs; files criteria, follow-ups or findings name; `web/`/`browser-tests/` for `docs/` planners; tests pinning planned text; symbol definitions; successors; companions (budget gate, timing baseline, importing tests, module imports). Else `approve-scope` executor replays standing decisions or asks approver; `master scope GY-N [--allow-broad-scope] REASON` applies refused requests save approver's (`master decisions`); `--wait` reads outcomes ≤15 min. Ending attempts close requests `attempt ended` (one awaiting the approver carries over, through claims, decision intact); `master unblock GY-N` closes stale or carried. Human decisions: `park GY-N EPOCH KIND NEEDED --ask ASK [--step STEP]… --recommend TEXT --why WHY [--choice LABEL]… -- REASON` ([Needs you](dashboard.md#needs-you)); `graphyard answer GY-N …`; [host-doable](deployment.md) asks refused.

## Promotion to autonomy

`graphyard master promote --admin-token-stdin` makes a supervised install autonomous; `master autonomy --apply` refuses on it, editing `master.json` skips checks. It refuses (naming missing steps) until a reviewer App and profile exist, its bot being none of your `gh` login, `operatorLogin`, worker App or principals; then logs who, reviewer, time to `.graphyard/master-actions/promotions.jsonl`, provisions operator-agent and approver, writes `supervision: autonomous`; reruns change nothing; no demotion.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`. Approvals survive base refreshes ([carry](github.md#bindings-and-carry)); one on current head dismissed `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`), never re-posted (`observation.dismissedReviewIds`). A branch must never keep another item's unlanded commits (build gate refuses): `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

`master protection --apply` reconciles protection; flows (`master browser app-permissions`, `master browser installation-accept`, `master browser protection`) drive the `master init --browser-profile` profile:

| Flow | Effect
| --- | ---
| `app-permissions` | Raise App permissions to declaration
| `installation-accept` | Accept pending requests
| `protection` | Reconcile branch protection

Flows read `GET /api/github/installation`, recording `.graphyard/master-actions/` `record.json`, `ledger.json` and redacted Confirm-access markup (`master browser fixtures`). Approving *Confirm access* GitHub Mobile code on device: human-only; master never stores cookies, uses merge bypass, pushes code, reads worker credentials. On classifier refusals `master harness claude --apply` (or `codex`) writes `.claude/settings.local.json` rules denying `gh pr merge`/`review`, merging, reviewing, token-minting or mutating `gh api`; missing or retired rules are `harness` drift the loop reapplies each cycle to its CLI's checkout, not research scratch (no units, its unit unreadable or elsewhere: waits naming `master init` or the unit); `master status` too, unless read-only (reports).

## Typed actions and executors

`nextAction` (one per item): `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`; judgements: `actions.needsHuman`. `graphyard init` starts `graphyard-executor@N`; `master executors restart` moves stale slots to the current release; verified deployments advance clean checkouts, restart executors and loop (dirty: `upgrade`; claim refusals 15 min: loop alone). Fenced (`POST /api/actions/presence`) or claim-renewing executors live; presence upserts from `serves`. `resync` (`POST /api/work/:id/resync` `{since}`) needs a newer observation. `dispatch`/`request-review` complete when a session already answers the head; busy profiles stall after 30min. Three failures with an unchanged reason mark a row stalled rather than retrying (a fleet that looks idle): in no count and no list, but in `actions.stalled` and on the item's own card; backoff never outlives it; eight escalate. Ticks requeue ownerless items (`liveness.violations`).

Declared slot not `active` (systemd, else `PRINCIPAL@HOST/N` presence): `resources` fault naming `journalctl --user -u graphyard-executor@N.service` unless stopped <2min. `--install` needs `Restart=always`, `RestartSec` ≤60s. Worker starts fenced <2min retry after lapse; longer fail, named.

## Recovery

Dead supervisor fences item; `containment` lists survivors' pid, cmdline and cwd: `settleable: true` → loop settles; past grace+10min `master settle-containment GY-N REASON`, else stop recorded scope unit (`containment.scope`), request `rework`. Unexplained lapses raise `lease-loss` (`blocked-awaiting-operator`, `stopped-by-attestation`: history); admins settle explained: `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns handler: `master decide GY-N resolve … --context FINGERPRINT REASON`. Named-reset exhaustion holds login twins fleet-wide, all roles (`agent-registry/observe`); same-named holds match registry home+runtime.

### Producer-runtime faults

Unacted producer requests (unstarted, refused, exited at launch) relaunch on untried profile, no rework.

## Fault classes

`faultClass` (`master status` `faults`): recurring classes file one item each; instances predating a delivered class item's landing (not opening) link there; triage proposes closing items holding only those, withdrawn on post-landing links; a resource at bound files `resource:ID`; also `fleet-capacity`, `unanswered-request` (past `settledAnswerGraceMs`), `configuration`, `decision-unanswered` (not `loop-silence`), and `unclassified` unless named (`plane-unavailable`, `fix-item`, `decision-stale`, `overlong-session`). Review unlaunched 15min: `concurrency-starved`, `review-settlement`, `launch-review`. Unanswering planes: `plane-unavailable`; `planeWaitMs` (control-plane time) is neither `loop-cost` nor `cycle-p90`. Pre-start launch failures: one dispatch fault, not `session`.

## Shadow merge gate

`run.shadowGate` (defaults: `enabled` true, `timeoutMinutes` 20): each cycle trial-merges, builds, affected-tests the oldest untried head credential-free in an empty, sticky, tmp-reclaimed `TMPDIR` (`gy-t*`), pushing nothing; `shadow.verdict` (failing: runner-ran files; 4000-character summary-keeping `logTail`) joins GitHub's outcome in `master status` `shadowGate` (`shadow-only-fail`/`shadow-missed`: one line each naming its failing test, shared-tmp contamination or missing evidence); errors, timeouts, mid-trial poisoning record nothing; third timeout, one line. `GET /api/shadow-disagreements`, `/api/shadow-explanations?pair=KEY:HEAD:BASETIP` (≤50).

## Pipeline speed

Target (10+ deliveries): submit→merge p50 ≤30 minutes, p90 ≤60 minutes. Row `speed`: `executionMs`, `waitMs`, `reworkRounds`, `interventions`; verdict `speed.submitToMerge`; `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.

Loop's decisions step stays within 10 s a cycle: one `decision.*` ledger read names moved items; a history whose ledger has not moved is kept, not read. Widenings refused by 5xx or stale revision and timed-out decision history reads retry next cycle (twice: fault) unless moot (delivered, answered, lease ended, head moved).
