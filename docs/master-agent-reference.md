<!-- page: Operate Graphyard | 7 | executors, GitHub. -->
# Master-agent reference

## Items, scope and human waits

Unplanned file: none — `scope-request` files nothing, the plan is not a lock (GY-1991); the legacy flow for a request still on the books auto-grants if grounded, refuses non-repository, else `approve-scope`; `master scope GY-N [--allow-broad-scope] REASON` applies refusals; attempt ends close requests, `master unblock GY-N` closes carried; `held`: applied at attempt end, never re-requested. Human: `park GY-N EPOCH KIND NEEDED --ask ASK --recommend TEXT --why WHY [--choice LABEL]… -- REASON` ([Needs you](dashboard.md#needs-you)); `answer GY-N …`; `master decide GY-N withdraw-park REASON`; [host-doable](deployment.md) and criterion-rewrite asks ([requirements decisions](glossary.md#who-decides)) refused; bare `requirements` (no AC-N, criteria, or key with tests/ path) names the rewrite as work: whether it lands, succeeds or is ordered parks; a change verb on the requirements or a named object refuses.

## Promotion to autonomy

`graphyard master promote --admin-token-stdin` makes supervised installs autonomous; `master autonomy --apply` refuses there; `master.json` edits skip checks. Refuses until a reviewer profile and a reviewer App bound before GY-2010 exist (`master reviewer setup`/`bind` are removed, so new installs cannot promote), its bot none of your `gh` login, `operatorLogin`, worker App or principals; logs `.graphyard/master-actions/promotions.jsonl`, provisions operator-agent and approver, writes `supervision: autonomous`.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing), smallest planned scope first ([rules](coordination.md#dispatch-optimistically-smallest-scope-first)); `git merge-tree` reports `conflicts`. Approvals survive base refreshes (carry); a current-head one dismissed `The merge-base changed after approval.` is restored, never re-posted. A branch must never keep another item's unlanded commits (build gate refuses): `git reset --hard REVIEWED_HEAD`, `sync GY-N`, `restore-branch GY-N EPOCH`.

## GitHub administration through the browser

Graphyard holds no GitHub App: its one GitHub credential is the merge writer's deploy key ([install](install.md)), and `/api/github/installation` is 404. `master browser app-permissions|installation-accept|capture` therefore refuse, naming the missing App credential; `master browser fixtures` lists the Confirm-access captures earlier flows kept under `.graphyard/master-actions/`. Approving *Confirm access* GitHub Mobile on device: human-only; master never stores cookies, uses merge bypass, pushes code, reads worker credentials. On classifier refusals `master harness claude|codex --apply` writes `.claude/settings.local.json` rules denying `gh pr merge`/`review`, token-minting or mutating `gh api`; missing/retired rules: `harness` drift, reapplied each cycle.

## Typed actions and executors

`nextAction` (one per item): `dispatch`/`request-review`/`request-rework`/`approve-scope`/`resync`/`reclaim`/`merge`/`escalate`; judgements: `actions.needsHuman`. `init` starts executors; `master executors restart` refreshes slots; verified deployments advance clean checkouts, restarting executors and loop. `resync` needs newer observation. `dispatch`/`request-review` complete if a session answers the head; busy profiles stall after 30min. Three failures, unchanged reason: stalled rather than retrying (fleet looks idle; plane-wide failures, human-only parks never stall); in no count and no list, but in `actions.stalled` and on the item's own card; backoff never outlives it; eight escalate. Permanent reasons the registry binds — `Deployment endpoint answered 4xx`, claim `A valid Graphyard bearer token is required`, refused reviewer launch `(4xx)` — raise installation `setup` attention (not per-item `stalled-action` / stalled-gate). Ticks requeue ownerless items (`liveness.violations`). One origin fetch per dispatch cycle builds worktrees; preparation times: `master status` `launches.prepare` (daily p50/p90).

Declared slot not `active`: `resources` fault naming `journalctl --user -u graphyard-executor@N.service` unless stopped <2min; `--install` needs `Restart=always`, `RestartSec` ≤60s. Worker starts fenced <2min retry after lapse.

## Recovery

Dead supervisor fences item; `containment` lists survivors' pid, cmdline and cwd: `settleable: true` → loop settles; past grace+10min `master settle-containment GY-N REASON`, else stop recorded scope unit (`containment.scope`), request `rework`. Unexplained lapses raise `lease-loss` (`blocked-awaiting-operator`/`stopped-by-attestation`: history); admins settle explained: `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` ([settling](delegation.md#who-may-settle-what)). `master escalation GY-N` spawns handler: `master decide GY-N resolve … --context FINGERPRINT REASON`.

### Producer-runtime faults

Unacted producer requests (unstarted/refused/launch-exited) relaunch on untried profile.

## Fault classes

`faultClass` (`master status` `faults`): recurring classes file one item each; a cycle over 60s is attention naming its slowest steps, never an item; an unbound [stall](operations-reference.md#master-coordination-loop) wakes the master session once per run at three failing cycles (bound: remedy refused, unverified or failing at six); `master status` lists each stall's signature, count, remedy, owner, filing nothing; an owed control-plane refusal (`… not trialled/pushed…`) of a queued/in-flight head is its motion, never `owed-decision`, through a live flight and until (retrials+1)×20min trial +1 cycle past its newest step, one `merge-writer` stall (`stalled-step`) for a queue it cannot move; `fleet-capacity`/`unanswered-request` (past `settledAnswerGraceMs`), `configuration`/`decision-unanswered`/`unclassified` unless (`plane-unavailable`/`fix-item`/`decision-stale`/`overlong-session`). Review unlaunched 15min: `concurrency-starved`/`review-settlement`/`launch-review`; normal-risk control-plane heads' designed post-merge wait raises none, still listed. `no master role` blockers group as `configuration`, not `stalled-gate`. Pre-start launch failures: one; a finished lease-holder files `session` past the orphan watch and gone-worker preserve.

## Merge trial

The merge writer's trial, the only trial: the merge commit's build and affected tests (dashboard changes: `npx playwright install chromium` into the host's shared cache, failure retried as the host's; then `npm run test:browser`), credential-free in a sticky tmp-reclaimed `TMPDIR` (`gy-t*`), checkout in `~/.gy/trials`, killed after 20 minutes. The shadow gate is gone (GY-2087): no `run.shadowGate`, and old cursor `shadow` verdicts drop on load.

## Pipeline speed

Target: submit→merge p50 ≤30 minutes, p90 ≤60 minutes. Row `speed`: `executionMs`/`waitMs`/`reworkRounds`/`interventions`; verdict `speed.submitToMerge`; `scripts/measure-pipeline-speed.mjs` feeds `manual:speed-target-met`.

Steps calling an approver, decision or session budget two-fifths of the interval (30s floor), each call 10s or what's left; a slower one is carried (`waiting`, no fault), retried next cycle, joining it or consuming its answer, kept while its row stands; spent, it starts none; one `decision.*` ledger read names moved items, an unmoved history is kept unread. Master/merge-mode/record/triage-phase calls too.
