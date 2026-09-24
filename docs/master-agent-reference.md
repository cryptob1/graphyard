<!-- page: Operate Graphyard | 5 | master commands, executors, GitHub administration, conflict avoidance, and recovery. -->
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

Write two or three acceptance criteria per item and split a fourth into a dependent item. Put documentation inside the behavioural criterion it describes. A standalone docs criterion usually becomes a `manual:` proof, the most expensive evidence there is.

## Scope requests

A worker that needs a file outside `plannedFiles` runs `scope-request GY-N EPOCH PATH… -- REASON` and keeps its lease. The control plane approves documentation and files the item's criteria name, as an additive widening. It refuses and escalates anything else; the master applies a refused request with `master scope`.

## Human-only waits

A worker whose item needs a human-only decision runs `park GY-N EPOCH KIND NEEDED -- REASON`, where `KIND` is `goals-and-priorities`, `money-or-accounts` or `credentials-for-people`. That releases the lease and lists the request under **Work → Needs you** and `humanRequests`. A human `admin` answers with `graphyard answer GY-N …`, and the loop dispatches the item on its next cycle.

## Scheduling and the merge queue

### Conflict avoidance

An item whose planned files overlap an in-flight item is held, for at most two hours. After that the loop dispatches it and records the overlap; before then, `master dispatch --allow-overlap` overrides the hold. Once a candidate exists, overlap is judged on the files it changed. Ready items are offered smallest planned scope first. `master create` refuses a root-level directory scope unless `--allow-broad-scope` records it. `git merge-tree` probes every pair of open candidates and reports real conflicts under `conflicts`. `graphyard sync` regenerates generated files instead of making workers resolve them.

### Speculative tips and branch protection

A queued candidate's tip is its own reviewed head merged onto the predicted base, published on its PR branch.

**An approval must survive a tip publication.** An approval carries onto the tip when the predecessor changed no reviewed file. `master merge` re-posts it through the reviewer App.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** An approval of the current head that GitHub dismissed with `The merge-base changed after approval.` is restored (`observation.reviews[].dismissal`, `restoredApproval`). Any other dismissal restores nothing.

**A branch must never keep another item's unlanded commits.** Tips are built from the reviewed head. An ejection restores the branches it leaves behind (`baseRefresh.restore`).

## GitHub administration through the browser

The master owns control-plane App permission updates, acceptance of the installation permission request, and branch-protection reconciliation. It uses the API first (`master protection --apply`). Where GitHub offers only a page (App manifest confirmation, permission acceptance, a sudo prompt), it runs `master browser FLOW`. The flow drives the operator's browser profile (set with `master init --browser-profile`) headless.

| Flow | What it does |
| --- | --- |
| `app-permissions` | Raises the control-plane App's permissions to what Graphyard needs |
| `installation-accept` | Accepts the installation's pending permission request |
| `protection` | Reconciles branch protection (`--dry-run` previews) |

Commands: `master browser app-permissions`, `master browser installation-accept`, `master browser protection`. Each flow records its steps and screenshots in `record.json` under `.graphyard/master-actions/`. It verifies the result through the API, and appends to the audit ledger `ledger.json`, which `master status` shows. On a *Confirm access* page, the flow triggers GitHub Mobile and reports the two-digit code in `master status`. Approving it on the device is the operator's part, along with the three human-only decisions.

The master must never drive the profile outside these flows; it never stores, exports, or reuses its cookies. It never uses an administrative merge bypass, pushes code, posts a verdict, or reads a worker credential.

`master protection` keeps GitHub's approval rules consistent with open items' review policies. It refuses a mix of native and non-native review providers, and it needs `strict` off for the merge queue.

## Harness permissions

A harness command classifier (Claude Code's auto mode) would refuse the master's routine administration. `master harness claude --apply` writes rules to `.claude/settings.local.json`, and `master harness codex` prints a trust block. The rules allow the master's CLI, `herdr`, read-only `gh`, protection reads and subresource `PATCH`, `master config`, and restarts of the `graphyard-master.service` unit. They deny merges, verdicts, token minting, `git push`, direct `agent-browser`, and credential reads. Worker, reviewer and producer sessions never inherit these rules. Each Claude session runs with `--setting-sources user --settings .graphyard/harness/ROLE-PROFILE.json`. A harness allowlist is a prompt policy; branch protection and the App-bound check are the enforcement.

## Typed next actions and stateless executors

The control plane computes one typed action per item: `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment` or `escalate`. Stateless executors claim and run them ([architecture](architecture.md#inverted-coordination-typed-actions-and-stateless-executors)). `master status` reports them under `actions`. An item with no action carries a named wait. One that is `unaccounted` is a control-plane defect: file it with `master create`. `escalate` and `request-rework` are judgements, listed under `actions.needsHuman` for the master, and never claimed by an executor.

### A concern carried beside the work

An escalation refuses delivery and nothing else. The item's next action is named as though no escalation stood, the escalation is carried beside it (`carried`), and only the merge gate refuses.

### A row that keeps failing for the same reason

Three consecutive failures with an unchanged reason mark the row stalled rather than retrying. That is the signal for a fleet that reads as idle and is not. It shows in `actions.stalled`, as one attention item, and on the item's own card on the dashboard. Clear the named condition. A stalled row rechecks every minute, so backoff earned while the condition stood never outlives it.

### Running executors under supervision

`graphyard init` on a coordinator host writes `.graphyard/executors.json` (`count`, `kinds`, `intervalSeconds`) and starts that many `graphyard-executor@N` systemd user units. Change the count with `node scripts/graphyard-executor.mjs --install --count 2`. `master status` names every declared slot that is not active, and every action kind no live executor serves. An executor stands down once its checkout moves to a new commit; `master executors restart` brings the fleet onto the current release.

### Session handles

Every launched session records a handle on its item (runtime, host, pane, transcript, and an attach command such as `herdr pane attach PANE`), listed under `sessions` in `master status`. Only the session, its launcher or an admin may update one.

## Resource observation

Every bounded resource the loop uses is declared in `resourceRegistry` (`src/master-resources.ts`): the review and producer ledgers (200 live records each), Herdr agent names, session slots, the GitHub budget, loop liveness, the loaded revision, database size, and worktree disk. `master status` reports each under `resources`, and raises attention while headroom remains. A launch refused by a resource names that resource. `/healthz` reports `healthy: false` when the plane cannot write, and the loop dispatches nothing until it recovers.

## Worktree disk

A worktree inside the repository reuses the repository's dependency install when its lockfile matches. Each cycle, every ten minutes or so, the loop removes the dependency directories of delivered, superseded and idle worktrees; files, commits and records are kept. `run.reclaimIdleHours` (default 3) sets the idle bound, and below `run.diskThresholdGb` free the loop raises attention under `disk`.

### The managed worktree root

Review and proof checkouts live under `run.worktreeRoot`, which defaults to `worktrees/REPOSITORY-ID` in `~/.local/share/graphyard`, never on tmpfs. Each session gets one directory, removed when it resolves. `master run --once` reclaims orphaned ones. `run.worktreeRootMinFreeGb` and `run.worktreeRootBudgetGb` bound the root.

## Containment quarantines

A worker whose supervisor died leaves its item fenced. `master status` shows the fence under `containment`, with every process still holding it, including pid, cmdline and cwd. With `settleable: true`, run `master settle-containment GY-N REASON`. When a refusal remains, stop the supervisor, then attest the stop through a two-party `rework` decision, or `recover` once the item is delivered. The fence names its recorded scope unit (`containment.scope`). Verify whose a scope is before stopping it. See [the protocol](protocol/containment-settlement.md).

## Recovery

### Merged without a valid execution

A merge that no execution authorized records a violation and stays out of Done. `master status` names it with its recovery. Request `master decide GY-N merge REASON` after the merge, and have the approver agent approve it. Graphyard delivers the item only when the record just before the merge passed every gate. A refusal is answered with a new decision that gives a new reason. A merged item whose files are missing from the base shows as a reverted delivery; restore it through a follow-up item.

#### A contaminated branch

A branch carrying another item's unlanded commits is listed under `contamination` and `branches.contaminated`. The control plane restores an ejected tip on its own. For any other case, run:

```sh
node "$GRAPHYARD_CLI" master repair GY-42 The branch carries GY-40's ejected tip
```

The control plane then resets the branch to the reviewed head and merges the base onto it. When the outcome is `unrepairable`, request a `rework` decision.

### Worker push rights

A worker pushes only its assigned branch (`git push origin BRANCH`, `-u`, `HEAD:BRANCH`), and takes the base with `graphyard sync GY-N`, which merges and never rebases. Its harness denies force, lease, deletion and base-branch pushes. To restore its own branch, it runs `git reset --hard REVIEWED_HEAD`, then `graphyard sync GY-N`, then `graphyard restore-branch GY-N EPOCH`, which makes the one `--force-with-lease` push after checking the live lease.

### Dead worker or provider change

A lease that lapsed with no explanation raises `lease-loss`. Other lapses are history with their cause: `submitted`, `blocked-awaiting-operator`, `stopped-by-attestation`, or `exhausted-capacity`. Reconciliation settles a `lease-loss` once a stopped-worker attestation (an applied `rework` decision) is recorded. An admin may also settle it with `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`. Anything else is resolved by a two-party `resolve` decision. To replace a dead worker, stop the old one, settle its quarantine, request `rework` if a candidate was submitted, and dispatch a fresh attempt. See [operations](operations.md) and [restarting the loop](operations-reference.md#master-coordination-loop).

## Escalation context

`master context GY-N [TRIGGER]` prints the context the control plane assembles for an escalation: the repository's `AGENTS.md` rules, goals, the item slice, and precedent decisions. It fits a byte budget (`GRAPHYARD_ESCALATION_CONTEXT_BUDGET`) and carries a SHA-256 `fingerprint`. `master escalation GY-N [TRIGGER]` spawns a handler on that context alone. The handler records `master decide GY-N resolve '{"trigger":"…"}' --precedent ID --context FINGERPRINT REASON`, and the approver judges it.

## Pipeline speed

The routine target is a submit→merge p50 of at most 30 minutes and a p90 of at most 60 minutes over at least ten deliveries. Each row's `speed` in `master status` carries `executionMs`, `waitMs`, `reworkRounds` and `interventions`; `speed.submitToMerge` and `speed.met` give the verdict. `node scripts/measure-pipeline-speed.mjs [--split GY-N] [--record DIR]` records the figures that `manual:speed-target-met` reads. Never trade a gate or proof for the number.
