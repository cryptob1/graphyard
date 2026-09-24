<!-- page: Operate Graphyard | 5 | commands, executors, GitHub administration, and recovery. -->
# Master-agent reference

## Master commands

| Command | Purpose |
| --- | --- |
| `master init --token-stdin [--browser-profile PROFILE] [--no-auto-merge]` | Install the operating mode and the loop's unit |
| `master start KIND` | Launch the visible master session with its harness rules |
| `master status` | Work truth, sessions, reviews, queue, schedule, conflicts, disk, executors and attention |
| `master run [--once]` / `master restart` | The durable loop, with the dispatcher that launches reviews and producers |
| `master dispatch GY-N PROFILE [--allow-overlap]` | Invite a worker to claim ready work |
| `master create FILE REASON`, `master release GY-N REASON`, `master unblock GY-N REASON`, `master requirements GY-N FILE REASON` | Non-weakening intent, as the operator-agent identity |
| `master scope GY-N [--allow-broad-scope] REASON` | Apply a scope request the loop refused |
| `master close GY-N REASON --duplicate-of GY-M\|--superseded-by COMMIT\|GY-M\|--obsolete` | End work that will never ship; refused under a live lease or merge. Never counted as delivered |
| `master decide GY-N ACTION [JSON\|@FILE] REASON` | Request a two-party decision: `requirements`, `resolve`, `attest`, `merge`, `rework`, `recover`, `grant`, … |
| `master approver GY-N DECISION [KIND]` | Launch the independent approver for one decision |
| `master approve\|refuse GY-N DECISION REASON` | The approver's verdict, from its own session only |
| `master decisions GY-N` | An item's decisions, reasons and outcomes |
| `master merge GY-N\|--all` | Guarded merge of authorized candidates |
| `master verify-deployment GY-N` | Record the exact deployed release serving a delivery |
| `master review GY-N [PROFILE]` | Launch the reviewer on the exact candidate (recovery path) |
| `master worker add FILE`, `master reviewer add FILE`, `master producer add\|replace FILE`, `master producer\|reviewer remove NAME` | Manage launch profiles |
| `master environments [--create KINDS] [--apply]`, `master registry …` | Provider accounts and the agent registry |
| `master repair GY-N REASON` | Restore a contaminated branch to the item's reviewed head ([a contaminated branch](#a-contaminated-branch)) |
| `master settle-containment GY-N REASON` | Settle a quarantine whose supervisor is verified gone |
| `master context GY-N [TRIGGER]`, `master escalation GY-N [TRIGGER] [KIND]` | Escalation context, and a handler spawned on it alone |
| `master protection [--apply]`, `master browser FLOW`, `master harness [KIND] [--apply]` | GitHub administration and harness rules |
| `master config FIELD=VALUE…` | Tune the settings the master owns; `autoMerge` and credential paths stay operator-only |
| `master executors [restart]`, `master principals [--apply]`, `master autonomy --admin-token-stdin --apply` | Executors, principal rotation, and one-time identity provisioning |

## Sizing an item

Write two or three acceptance criteria per item; split a fourth into a dependent item. Put documentation inside the behavioural criterion it describes: a standalone docs criterion usually becomes a `manual:` proof, the costliest evidence.

## Scope requests

A worker that needs a file outside `plannedFiles` runs `scope-request GY-N EPOCH PATH… -- REASON` and keeps its lease. The control plane approves documentation and files the criteria name as an additive widening, and escalates anything else; the master applies a refused request with `master scope`.

## Human-only waits

A worker needing a human-only decision runs `park GY-N EPOCH KIND NEEDED -- REASON`, `KIND` being `goals-and-priorities`, `money-or-accounts` or `credentials-for-people`. That releases the lease and lists the request under **Work → Needs you** and `humanRequests`; an `admin` answers with `graphyard answer GY-N …`, and the loop redispatches.

## Scheduling and the merge queue

### Conflict avoidance

An item whose planned files overlap an in-flight item is held for at most two hours, then dispatched with the overlap recorded; `master dispatch --allow-overlap` overrides the hold sooner. Once a candidate exists, overlap is judged on the files it changed. `master create` refuses a root-level directory scope without `--allow-broad-scope`. `git merge-tree` probes every pair of open candidates and reports real conflicts under `conflicts`; `graphyard sync` regenerates generated files.

### Speculative tips and branch protection

A queued candidate's tip is its reviewed head merged onto the predicted base, published on its PR branch.

**An approval must survive a tip publication.** It carries onto the tip when the predecessor changed no reviewed file; `master merge` re-posts it through the reviewer App.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** An approval of the current head that GitHub dismissed with `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`, `restoredApproval`); no other dismissal is. Status names it; a queue head lacking the base tip commit is republished.

**A branch must never keep another item's unlanded commits.** Tips are built from the reviewed head, and an ejection restores the branches it leaves behind (`baseRefresh.restore`).

## GitHub administration through the browser

The master owns control-plane App permission updates, installation permission acceptance, and branch-protection reconciliation, API first (`master protection --apply`). Where GitHub offers only a page (App manifest confirmation, permission acceptance, a sudo prompt), `master browser FLOW` drives the operator's browser profile (`master init --browser-profile`) headless.

| Flow | What it does |
| --- | --- |
| `app-permissions` | Raises the control-plane App's permissions to what Graphyard needs |
| `installation-accept` | Accepts the installation's pending permission request |
| `protection` | Reconciles branch protection (`--dry-run` previews) |

Run each as `master browser app-permissions`, `master browser installation-accept` or `master browser protection`. Each records its steps and screenshots in `record.json` under `.graphyard/master-actions/`, verifies the result through the API, and appends to the audit ledger `ledger.json`, shown in `master status`. On a *Confirm access* page it triggers GitHub Mobile and reports the two-digit code in `master status`; approving it on the device is the operator's part.

The master never drives the profile outside these flows, never stores, exports or reuses its cookies, and never bypasses a merge, pushes code, posts a verdict, or reads a worker credential.

`master protection` keeps GitHub's approval rules consistent with open items' review policies, refusing a mix of native and non-native providers; the merge queue needs `strict` off.

## Harness permissions

A harness command classifier would refuse routine administration. `master harness claude --apply` writes rules to `.claude/settings.local.json`, and `master harness codex` prints a trust block. The rules allow the master's CLI, `herdr`, read-only `gh`, protection reads and subresource `PATCH`, `master config`, and restarts of the `graphyard-master.service` unit. They deny merges, verdicts, token minting, `git push`, direct `agent-browser` and credential reads. Each other Claude session runs with `--setting-sources user --settings .graphyard/harness/ROLE-PROFILE.json`. A harness allowlist is a prompt policy; branch protection and the App-bound check are the enforcement.

## Typed next actions and stateless executors

The control plane computes one typed action per item: `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment` or `escalate`. Stateless executors claim and run them ([architecture](architecture.md#inverted-coordination-typed-actions-and-stateless-executors)). `master status` reports them under `actions`. An item with no action carries a named wait; an `unaccounted` one is a control-plane defect to file with `master create`. `escalate` and `request-rework` are judgements, listed under `actions.needsHuman` for the master, and never claimed by an executor.

### A concern carried beside the work

An escalation refuses delivery and nothing else: the next action is named as though none stood, the escalation is `carried` beside it, and only the merge gate refuses.

### A row that keeps failing for the same reason

Three consecutive failures with an unchanged reason mark the row stalled rather than retrying: the signal for a fleet that reads as idle and is not. It shows in `actions.stalled`, as one attention item, and on the item's own card on the dashboard; clear the named condition. A stalled row rechecks every minute, so backoff earned while the condition stood never outlives it.

### Running executors under supervision

`graphyard init` on a coordinator host writes `.graphyard/executors.json` (`count`, `kinds`, `intervalSeconds`) and starts that many `graphyard-executor@N` systemd user units. Change the count with `node scripts/graphyard-executor.mjs --install --count 2`. `master status` names every inactive declared slot and every action kind no live executor serves. An executor stands down once its checkout moves; `master executors restart` brings the fleet onto the current release.

### Session handles

Every launched session records a handle on its item (runtime, host, pane, transcript, attach command such as `herdr pane attach PANE`), listed under `sessions` in `master status`; only the session, its launcher or an admin may update it.

## Resource observation

Every bounded resource is declared in `resourceRegistry` (`src/master-resources.ts`): the review and producer ledgers (200 live records each), Herdr agent names, session slots, the GitHub budget, loop liveness, the loaded revision, database size, and worktree disk. `master status` reports each under `resources`, raising attention while headroom remains; a launch refused by a resource names it. `/healthz` reports `healthy: false` when the plane cannot write; the loop then dispatches nothing.

## Worktree disk

A worktree inside the repository reuses its dependency install when the lockfile matches. About every ten minutes the loop removes dependency directories of delivered, superseded and idle worktrees, keeping files, commits and records. `run.reclaimIdleHours` (default 3) sets the idle bound, and below `run.diskThresholdGb` free the loop raises attention under `disk`.

### The managed worktree root

Review and proof checkouts live under `run.worktreeRoot` (default `~/.local/share/graphyard/worktrees/REPOSITORY-ID`, never tmpfs). Each session's directory is removed when it resolves; `master run --once` reclaims orphans. `run.worktreeRootMinFreeGb` and `run.worktreeRootBudgetGb` bound the root.

## Containment quarantines

A dead supervisor leaves its item fenced. `master status` shows the fence under `containment`, with each process holding it: pid, cmdline and cwd. With `settleable: true`, run `master settle-containment GY-N REASON`; otherwise stop the supervisor and attest it through a two-party `rework` decision (`recover` once delivered). Verify whose the recorded scope unit (`containment.scope`) is before stopping it. See [the protocol](protocol/containment-settlement.md).

## Recovery

### Merged without a valid execution

A merge that no execution authorized records a violation and stays out of Done. `master status` names its recovery: request `master decide GY-N merge REASON` after the merge for the approver agent. Graphyard delivers the item only when the record just before the merge passed every gate; answer a refusal with a new decision and a new reason. A merged item whose files left the base shows as a reverted delivery; restore it through a follow-up item.

#### A contaminated branch

A branch carrying another item's unlanded commits is listed under `contamination` and `branches.contaminated`. The control plane restores an ejected tip itself. Otherwise run:

```sh
node "$GRAPHYARD_CLI" master repair GY-42 The branch carries GY-40's ejected tip
```

It resets the branch to the reviewed head and merges the base; if `unrepairable`, request a `rework` decision.

### Worker push rights

A worker pushes only its assigned branch (`git push origin BRANCH`, `-u`, `HEAD:BRANCH`) and takes the base with `graphyard sync GY-N` (merge, never rebase); its harness denies force, lease, deletion and base-branch pushes. To restore its own branch, it runs `git reset --hard REVIEWED_HEAD`, then `graphyard sync GY-N`, then `graphyard restore-branch GY-N EPOCH`, which makes the one `--force-with-lease` push after checking the live lease.

### Dead worker or provider change

A lease that lapsed with no explanation raises `lease-loss`. Other lapses record their cause: `submitted`, `blocked-awaiting-operator`, `stopped-by-attestation`, or `exhausted-capacity`. Reconciliation settles a `lease-loss` once a stopped-worker attestation (an applied `rework` decision) is recorded, or an admin runs `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`. Anything else is resolved by a two-party `resolve` decision. To replace a dead worker: stop it, settle its quarantine, request `rework` if it submitted, and dispatch afresh. See [operations](operations.md) and [restarting the loop](operations-reference.md#master-coordination-loop).

## Escalation context

`master context GY-N [TRIGGER]` prints the context the control plane assembles for an escalation: the repository's `AGENTS.md` rules, goals, the item slice, and precedent decisions. It fits `GRAPHYARD_ESCALATION_CONTEXT_BUDGET` bytes and carries a SHA-256 `fingerprint`. `master escalation GY-N [TRIGGER]` spawns a handler on that context alone, which records `master decide GY-N resolve '{"trigger":"…"}' --precedent ID --context FINGERPRINT REASON`, and the approver judges it.

## Pipeline speed

The routine target is submit→merge p50 ≤ 30 minutes and p90 ≤ 60 minutes over at least ten deliveries. Each row's `speed` in `master status` carries `executionMs`, `waitMs`, `reworkRounds` and `interventions`; `speed.submitToMerge` and `speed.met` give the verdict. `node scripts/measure-pipeline-speed.mjs [--split GY-N] [--record DIR]` records the figures that `manual:speed-target-met` reads. Never trade a gate or proof for the number.
