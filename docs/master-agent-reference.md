<!-- page: Operate Graphyard | 7 | executors, GitHub. -->
# Master-agent reference

## Items, scope and human waits

Unplanned file: `scope-request GY-N EPOCH PATH… [--wait] -- REASON`; auto-granted if grounded: docs; files criteria, follow-ups or findings name; `web/`/`browser-tests/` for `docs/` planners; tests pinning planned text; symbol definitions; successors; companions (docs-budget gate, timing baseline, importing tests, planned modules' imports/importers). Else `approve-scope` executor or loop replays standing decisions or asks approver; `master scope GY-N [--allow-broad-scope] REASON` applies refused requests save approver's (`master decisions`). Leases stay; `--wait` reads the outcome ≤15 min. Ending attempts close requests `attempt ended`; one awaiting the approver carries to the next attempt; `master unblock GY-N` closes stale and carried ones. Human decisions: `park GY-N EPOCH KIND NEEDED --ask ASK [--step STEP]… --recommend TEXT --why WHY [--choice LABEL]… -- REASON` ([Needs you](dashboard.md#needs-you)); `graphyard answer GY-N …`; [host-doable](deployment.md) asks refused.

## Promotion to autonomy

A supervised install becomes autonomous through `graphyard master promote --admin-token-stdin`; `master autonomy --apply` refuses on it, and editing `master.json` skips every check. It refuses, naming each missing step and its command, until a reviewer App is registered, a reviewer profile exists, and the App's bot is neither your `gh` login, the recorded `operatorLogin`, the worker App nor any worker's principal. Then it appends who ran it, the reviewer and the time to `.graphyard/master-actions/promotions.jsonl`, provisions the operator-agent and approver through `master autonomy`'s apply and writes `supervision: autonomous`; `master status` drops its supervised line. A rerun on an autonomous install changes nothing; there is no demotion.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`. Approvals survive base refreshes ([carry](github.md#bindings-and-carry)); one on current head dismissed `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`), re-post no verdict (`observation.dismissedReviewIds`). Branches must never keep another item's unlanded commits (build gate refuses); worker runs `git reset --hard REVIEWED_HEAD`, `graphyard sync GY-N`, `graphyard restore-branch GY-N EPOCH`.

## GitHub administration through the browser

`master protection --apply` reconciles protection; page-only flows, `master browser FLOW` (`master browser app-permissions`, `master browser installation-accept`, `master browser protection`), drive `master init --browser-profile` profile:

| Flow | Effect
| --- | ---
| `app-permissions` | Raise App permissions to declaration
| `installation-accept` | Accept pending requests
| `protection` | Reconcile branch protection

Flows read `GET /api/github/installation`, recording `.graphyard/master-actions/` `record.json`, `ledger.json`, plus redacted Confirm-access form markup (`sudoForms`, `confirm-access/confirm-access-<method>.html`, `confirmAccess`; values, tokens, codes stripped), listed by `master browser fixtures`. Approving *Confirm access* GitHub Mobile code on device: human-only; master never stores profile cookies, uses merge bypass, pushes code or reads worker credentials. On classifier refusals `master harness claude --apply` (or `master harness codex`) writes `.claude/settings.local.json` rules denying `gh pr merge`/`review` and merging, reviewing, token-minting or mutating `gh api` calls; missing or retired rules are `harness` drift `master status` reapplies, reporting only unrepaired.

## Typed actions and executors

`nextAction` (one per item): `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment`, `escalate`; judgements (`escalate`, `request-rework`): `actions.needsHuman`. `graphyard init` starts `graphyard-executor@N` user units (own credentials), `master executors restart` moves stale ones to current release (`--all`: every slot); verified deployments move clean checkouts to base tip, stale executors, then loop (dirty: `upgrade` attention; claims refusing executors 15 min: loop re-executes alone); unverified, owed restarts retry each cycle, stalling in `loaded-revision`. Fenced (`POST /api/actions/presence`) or claim-renewing executors live (never `Nothing can run KIND`); polls and renewals upsert `executor_presence`; empty fleet needs evidence (poll, or rows older than 120s), not process age. `resync` (`POST /api/work/:id/resync` `{since}`) completes only on observation newer than claim. `dispatch`/`request-review` complete on a session already answering the head; standing verdicts block second reviewers until dismissed; busy/reserved profiles stall after 30 minutes. Three failures with unchanged reason mark a row stalled rather than retrying (fleet looks idle): in no count and no list, but in `actions.stalled` and on the item's own card; backoff never outlives it; eight escalate it. Ticks requeue ownerless items (`liveness.violations`).

Declared slot not `active` (systemd, else `PRINCIPAL@HOST/N` presence): `resources` fault naming `journalctl --user -u graphyard-executor@N.service` unless stopped under 2 minutes (unserved lines: slots down, not saturated). `graphyard-executor.mjs --install` needs `Restart=always`, `RestartSec` ≤60s. Worker starts fenced <2min retry after lapse; longer fail naming it.

## Recovery

Dead supervisor fences its item; `containment` lists survivors' pid, cmdline and cwd: `settleable: true` → `master settle-containment GY-N REASON`, else stop recorded scope unit (`containment.scope`), request `rework`. Unexplained lapses raise `lease-loss` (`blocked-awaiting-operator`, `stopped-by-attestation` lapses: history); any admin settles explained ones: `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns handler answering `master decide GY-N resolve … --context FINGERPRINT REASON`.

### Producer-runtime faults

Unacted producer requests (never started, launch refused, exited at launch) relaunch on untried profile, no rework.

## Fault classes

`faultClass` (`master status` `faults`): recurring classes file one item (`GRAPHYARD_FAULT_CLASS_*`); resource at bound: one `resource:ID` fault; `fleet-capacity`, workless sessions; `unanswered-request`, settled requests unanswered past `settledAnswerGraceMs` (5min); `configuration`, sandbox or `workflows`-permission refusals; `decision-unanswered` (`decision`), not `loop-silence`, decision silently awaiting approver; doctor commands its allowlist refused: done; failed `action:fault`/`action:diagnosis`: `unclassified` unless site names cause (`plane-unavailable`, `fix-item`, `decision-stale`). Review unlaunched 15min: `concurrency-starved` (capacity) if every reviewer profile busy, `review-settlement` (review-convergence) if one answered, else `launch-review`. Unanswering planes raise one `plane-unavailable` (`deployment`) fault; `planeWaitMs` isn't `loop-cost`.

## Pipeline speed

Target (10+ deliveries): submit→merge p50 ≤30 minutes, p90 ≤60 minutes. Row `speed`: `executionMs`, `waitMs`, `reworkRounds`, `interventions`; verdict `speed.submitToMerge`; `node scripts/measure-pipeline-speed.mjs` records what `manual:speed-target-met` reads.

Loop's decisions step stays within 10 s a cycle at ~90 open items: one `decision.*` ledger read names moved items; a history whose ledger has not moved is kept, not read. Widenings refused by 5xx or stale revision, and timed-out decision history reads, retry next cycle (twice running: fault) unless moot (delivered, answered, lease ended, head moved).
