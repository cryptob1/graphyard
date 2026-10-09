<!-- page: Operate Graphyard | 7 | executors, GitHub. -->
# Master-agent reference

## Items, scope and human waits

Unplanned file: `scope-request GY-N EPOCH PATH… [--wait] -- REASON`; auto-granted if grounded: docs; files criteria, follow-ups or findings name; `web/`/`browser-tests/` for `docs/` planners; tests pinning planned text; symbol definitions; successors; companions (budget gate, timing baseline, importing tests, module imports). Else `approve-scope` executor replays standing decisions or asks approver; `master scope GY-N [--allow-broad-scope] REASON` applies refused requests save approver's (`master decisions`); `--wait` reads outcomes ≤15 min. Ending attempts close requests `attempt ended` (one awaiting the approver carries over, through claims, decision intact); `master unblock GY-N` closes stale or carried. Human decisions: `park GY-N EPOCH KIND NEEDED --ask ASK [--step STEP]… --recommend TEXT --why WHY [--choice LABEL]… -- REASON` ([Needs you](dashboard.md#needs-you)); `graphyard answer GY-N …`; [host-doable](deployment.md) asks refused.

## Promotion to autonomy

`graphyard master promote --admin-token-stdin` makes a supervised install autonomous; `master autonomy --apply` refuses on it, editing `master.json` skips every check. It refuses, naming each missing step, until a reviewer App and profile exist and the App's bot is neither your `gh` login, `operatorLogin`, the worker App nor a worker principal; then it logs who, reviewer and time to `.graphyard/master-actions/promotions.jsonl`, provisions operator-agent and approver, writes `supervision: autonomous`; reruns change nothing; no demotion.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`. Approvals survive base refreshes ([carry](github.md#bindings-and-carry)); one on current head dismissed `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`), never re-posted (`observation.dismissedReviewIds`). A branch must never keep another item's unlanded commits (build gate refuses): `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

`master protection --apply` reconciles protection; flows (`master browser app-permissions`, `master browser installation-accept`, `master browser protection`) drive the `master init --browser-profile` profile:

| Flow | Effect
| --- | ---
| `app-permissions` | Raise App permissions to declaration
| `installation-accept` | Accept pending requests
| `protection` | Reconcile branch protection

Flows read `GET /api/github/installation`, recording `.graphyard/master-actions/` `record.json`, `ledger.json` and redacted Confirm-access form markup (values, tokens, codes stripped), listed by `master browser fixtures`. Approving *Confirm access* GitHub Mobile code on device: human-only; master never stores profile cookies, uses merge bypass, pushes code or reads worker credentials. On classifier refusals `master harness claude --apply` (or `codex`) writes `.claude/settings.local.json` rules denying `gh pr merge`/`review` and merging, reviewing, token-minting or mutating `gh api` calls; missing or retired rules are `harness` drift `master status` reapplies, reporting only unrepaired.

## Typed actions and executors

`nextAction` (one per item): `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`; judgements: `actions.needsHuman`. `graphyard init` starts `graphyard-executor@N`; `master executors restart` moves stale slots to the current release; verified deployments advance clean checkouts, restart executors and loop (dirty: `upgrade`; claim refusals 15 min: loop alone). Fenced (`POST /api/actions/presence`) or claim-renewing executors live; presence upserts from `serves`. `resync` (`POST /api/work/:id/resync` `{since}`) needs a newer observation. `dispatch`/`request-review` complete when a session already answers the head; busy profiles stall after 30 min. Three failures with an unchanged reason mark a row stalled rather than retrying (a fleet that looks idle): in no count and no list, but in `actions.stalled` and on the item's own card; backoff never outlives it; eight escalate. Ticks requeue ownerless items (`liveness.violations`).

Declared slot not `active` (systemd, else `PRINCIPAL@HOST/N` presence): `resources` fault naming `journalctl --user -u graphyard-executor@N.service` unless stopped <2 minutes. `--install` needs `Restart=always`, `RestartSec` ≤60s. Worker starts fenced <2min retry after lapse; longer fail naming it.

## Recovery

Dead supervisor fences item; `containment` lists survivors' pid, cmdline, cwd: `settleable: true` → `master settle-containment GY-N REASON`, else stop recorded scope unit (`containment.scope`), request `rework`. Unexplained lapses raise `lease-loss` (`blocked-awaiting-operator`, `stopped-by-attestation`: history); admins settle explained: `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns handler: `master decide GY-N resolve … --context FINGERPRINT REASON`. Named-reset exhaustion holds login twins fleet-wide, all roles (`agent-registry/observe`); same-named holds match registry home+runtime.

### Producer-runtime faults

Unacted producer requests (never started, launch refused, exited at launch) relaunch on untried profile without rework.

## Fault classes

`faultClass` (`master status` `faults`): recurring classes file one item; a resource at bound files `resource:ID`; also `fleet-capacity`, `unanswered-request` (past `settledAnswerGraceMs`), `configuration`, `decision-unanswered` (not `loop-silence`), and `unclassified` unless named (`plane-unavailable`, `fix-item`, `decision-stale`, `overlong-session`). Review unlaunched 15min: `concurrency-starved`, `review-settlement`, `launch-review`. Unanswering planes raise one `plane-unavailable`; `planeWaitMs` (control-plane time in flight) is neither `loop-cost` nor `cycle-p90`. A launch failing before its session starts is one dispatch fault, not a `session` fault.

## Shadow merge gate

`run.shadowGate` (defaults: `enabled` true, `timeoutMinutes` 20): each cycle trial-merges, builds, affected-tests the oldest untried head credential-free with its own empty, tmp-reclaimed `TMPDIR` (`gy-t*`), pushing nothing; `shadow.verdict` (failing: 4000-character `logTail`) joins GitHub's outcome in `master status` `shadowGate` (`shadow-only-fail`/`shadow-missed`: one line each naming its log's failing test, shared-tmp contamination or missing evidence until explained); errors, timeouts, mid-trial tmp poisoning record nothing; third timeout, one line. `GET /api/shadow-disagreements`, `/api/shadow-explanations?pair=KEY:HEAD:BASETIP` (≤50).

## Pipeline speed

Target (10+ deliveries): submit→merge p50 ≤30 minutes, p90 ≤60 minutes. Row `speed`: `executionMs`, `waitMs`, `reworkRounds`, `interventions`; verdict `speed.submitToMerge`; `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.

Loop's decisions step stays within 10 s a cycle: one `decision.*` ledger read names moved items; a history whose ledger has not moved is kept, not read. Widenings refused by 5xx or stale revision and timed-out decision history reads retry next cycle (twice: fault) unless moot (delivered, answered, lease ended, head moved).
