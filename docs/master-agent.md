<!-- page: Operate Graphyard | 5 | routing, recovery, merges. -->
# Master-agent operating mode

For the coordinator session: what the master decides, and must never do.

## Autonomy: agents approve agents

Three decisions are human-only: goals and priorities, spending money or opening third-party accounts, and issuing credentials to people. Every other names an agent that makes it and an independent agent that approves it — [who decides](glossary.md#who-decides).

- **Non-weakening intent, as its own operator-agent identity:** `master create FILE REASON`, `master release GY-N REASON`, `master unblock GY-N REASON`, `master requirements GY-N FILE REASON` (additions), `master scope GY-N [REASON]`
- **[Two-party decisions](operator-automation.md#two-party-decisions): `release`, `unblock`, `requirements` rewrites and removals, `resolve`, `attest`, `merge`, `rework`, `recover`, `grant`:** `master decide GY-N ACTION [JSON|@FILE] REASON`, then `master approver GY-N DECISION`; the approver runs `master approve GY-N DECISION REASON`, `master decisions GY-N` reads the outcome, and `master withdraw GY-N DECISION REASON` takes back the master's own request
- **Routine operations:** `master principals [--apply]`, `master restart`, `master run [--once]`, `master config FIELD=VALUE…`, dispatch, GitHub administration, guarded merge

## Operate

Keep cycling until both hold: every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merged change is live-verified against the exact deployed release or has such a blocker recorded.

1. `master status` after startup and every material event
2. `master dispatch GY-N PROFILE [--allow-overlap]` in `schedule.order`, smallest scope first, leaving `schedule.held` items for the item ahead to merge ([conflict avoidance](coordination.md#schedule-by-overlap-smallest-scope-first)); `conflicts` is a real `git merge-tree` between fetched candidate heads, not an overlap guess
3. Route review findings and failed proofs to rework; reviews and producers launch themselves
4. `master merge GY-N|--all` only when the exact candidate passes every gate ([guarded merges](github.md#the-guarded-merge)); a protocol mismatch refuses with `deploy main first`
5. One deployment verification per delivery: `master verify-deployment GY-N`; main ahead of production, or a flagged capacity variable, is a deployment incident to fix, never a ledger edit
6. Close finished agent sessions, then return to status

Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions: resolve them and keep cycling.

## Automatic dispatch at submit

The control plane records what the exact head needs under `autoDispatch`; the loop launches it. The two request kinds are [recorded by the control plane](protocol/github-webhook.md#automatic-dispatch-at-submit): one **review request** per head the policy expects a GitHub verdict for, and one **producer request per proof group** — `unit`, `integration` and `manual` for proofs listed in `producerProofs` — for proofs no trusted passing evidence binds. A group whose trusted evidence already failed on this head is a finding to route, not a run to repeat.

- **Binding:** Head, base and policy revision; changing any cancels the request and asks afresh unless a carried binding covers it. An approval, a `CHANGES_REQUESTED` verdict or trusted evidence satisfies it; rework, closure and merge cancel it
- **Launch cadence:** Launched within 30 seconds of the request, then every `dispatchIntervalSeconds`: the reviewer profile (`run.reviewerProfile`, or the only one) plus one producer session per proof group on a free, independent producer profile (`master producer add FILE`, [template](../examples/master/claude-producer.json))
- **Producer identity:** Its credential authenticates exactly its principal as a producer, never shares a principal with a worker profile, and is skipped for an item its principal implemented. The session receives it as a path in `GRAPHYARD_TOKEN_FILE`, works in a detached worktree of the head, and submits each proof bound to that head, base and policy revision, a failing run as `fail`
- **One session per request:** `.graphyard/reviews.json` and `.graphyard/producers.json` record which request each session answers. A session is `failed` when Herdr reports it finished, gone or blocked on a prompt for five minutes without a verdict or evidence, and relaunched at most four times; `master review GY-N [PROFILE]` recovers an exhausted one
- **Session contract:** Post the verdict, submit pass or fail evidence, or record a blocker naming the blocked command and its error — never stop to ask, and an ending that waits on input is recorded as failed
- **The master's half:** Findings, rework and merges; it never launches reviews or producers by hand, never approves a candidate, never submits evidence
- **Profiles and attention:** `master producer add FILE`, `master producer replace FILE`, `master producer remove NAME`, `master reviewer remove NAME`; `setup.attention` reports a reviewer App registered but never bound, a bound App whose credential file is gone, and a `herdrWorkspace` Herdr no longer lists

## Agent environments

A principal is who claims, reviews or proves; an *agent environment* is whose provider subscription a session spends — one isolated config and login home per account, set up in [onboarding](onboarding.md#agent-environments). Every launch profile lists its environments in `accounts`, in failover order; `master environments [--create KINDS] [--directory DIR] [--apply]` discovers, creates and profiles them.

- **Checked before every launch** — `master dispatch`, the loop's worker dispatch and the automatic reviewer and producer launches alike: the session runs on the first account logged in and holding quota, meaning no usage window at or above `run.quotaCeilingPercent` (default 95) that has not reset. Claude's 5-hour and 7-day windows come from the provider's usage endpoint, Codex's from its newest session's rate limits; OpenCode and Cursor expose none, so theirs is `unknown`, which never blocks a launch.
- **Failover:** an account failing either check is skipped with its reason and the launch fails over to the next (`claude-a quota is exhausted (7d window at 100% until …; ceiling 95%)`, `claude-b is not logged in`), the tick recording which it skipped. A session on another runtime's account runs that runtime, without the profile's `agentArgs`. A worker profile no account can launch claims nothing and is unavailable in `master status` (`workers[].credential`), so the loop routes its item elsewhere; review falls through `run.reviewerProfile`, a producer request to the next independent producer.
- **Confirmed prompt delivery:** a launch counts only once Herdr sees the runtime leave `idle`, since a runtime ready before its input is (OpenCode, while its UI loads) drops the prompt. A stalled prompt is delivered up to three times; a session that still has not taken it is closed, releasing a worker's claim, and launched once more from scratch before the launch is reported refused.
- **Reported:** `dispatch.accounts` shows every environment as the last launch check saw it — login, quota, usage windows, the login command when logged out — with recent launches that skipped an account by role, profile, item and reason. The record sits beside the coordinator credential (`*.environments.json`, mode 0600) and never holds a provider token.

## Independent review

The reviewer is a separate GitHub identity: not the pull-request author, not the control-plane App. `master run` launches it for every submitted head; `master review GY-N [PROFILE]` is that launcher and the recovery path after a refused launch.

```sh
node "$GRAPHYARD_CLI" master reviewer setup          # registers the reviewer App
node "$GRAPHYARD_CLI" master reviewer add /path/to/reviewer-profile.json
node "$GRAPHYARD_CLI" master review GY-42 claude-reviewer
```

Add one profile — [Claude](../examples/master/claude-reviewer.json), [Cursor](../examples/master/cursor-reviewer.json) or [opencode](../examples/master/opencode-reviewer.json) — whose `approvals` mode is the trade-off [onboarding](onboarding.md#approval-modes) tabulates: `auto` adds that runtime's non-interactive contract (`--permission-mode bypassPermissions`, `OPENCODE_PERMISSION`), `prompt` lets you opt out and answer in the tab. The reviewer App confirmation is the master's, through the browser flows below.

## GitHub administration through the browser

The master owns control-plane App permission updates, acceptance of the installation permission request they raise, and branch-protection reconciliation. GitHub offers no API for manifest confirmation, permission-request acceptance or a sudo prompt, so `master browser app-permissions`, `master browser installation-accept` and `master browser protection` drive the operator's own authenticated browser profile headless — `master init --browser-profile PROFILE` names it, the harness denies the session every direct browser command, and routine reconciliation stays on `master protection [--apply]`.

| Flow | Page | What it does | Verified afterwards by |
| --- | --- | --- | --- |
| `app-permissions` | `github.com/settings/apps/SLUG/permissions` | Raises every control-plane permission below what Graphyard needs | `gh api apps/SLUG` reports each at or above it |
| `installation-accept` | `github.com/settings/installations/ID/permissions/update` | Accepts this installation's pending permission request | `gh api user/installations` shows it granting them |
| `protection` | `github.com/OWNER/REPO/settings/branches` → the base branch's classic rule | Sets `strict` off, administrator enforcement on, and the approval settings the open review policies need | the protection plan re-read through the API (`--dry-run` previews it) |

Every flow is audited: `record.json` lists each step, its arguments and result, a numbered PNG follows every navigation, both under `.graphyard/master-actions/<time>-<flow>-<id>/`, with one append-only entry in `.graphyard/master-actions/ledger.json` (mode 0600) naming who, what, when, before, after and whether verification passed; `master status` shows the last five under `administration`. On GitHub's *Confirm access* page the flow clicks *Use GitHub Mobile*, writes the pairing code to `.graphyard/master-actions/sudo.json` and reports it under `administration.sudo` with the instruction to approve the prompt on your device, then polls for three minutes; a prompt nobody approves fails with the rerun command, and one without a GitHub Mobile option is refused.

The browser profile is the operator's identity: the master never stores, exports or copies its cookies or saved state and never drives it outside these three flows. It never adds a repository to an installation or replaces protection through the API, never uses a merge bypass, never edits a candidate or pushes code, never posts a verdict, never mints an installation token and never reads a worker, reviewer or coordinator credential.

## Harness permissions

A harness command classifier would otherwise stop the master on its own routine commands, and Claude Code's auto mode would refuse the browser flows outright. `master start claude` writes project-scoped rules to the git-ignored `.claude/settings.local.json` before the session starts, `master harness claude [--apply]` previews or writes them, and `master harness codex` prints the `trust_level = "trusted"` block for `$CODEX_HOME/config.toml`. Those rules, and the per-role files launched sessions use, are in [operator automation](operator-automation.md#harness-rules-per-role); an allowlist is a prompt policy, not an authority boundary.

They cover everything else the master owns, so no routine action waits: reading `.graphyard/master.json`; the loop's own systemd unit, named exactly (`systemctl --user restart graphyard-master.service`, `journalctl --user -u graphyard-master.service`); deployment administration (`railway status`, `logs`, `deployment`, `redeploy`, `master verify-deployment`); CI runs (`gh run list`, `view`, `watch`, `rerun`, `gh workflow run`); and `master config FIELD=VALUE…`, which tunes loop and dispatch cadence, proof and smoke workflows, deployment URL and SHA field, reviewer profile, producer timeout, quota ceiling and a profile's account order (`accounts:PROFILE=a,b`) through the operator commands' own validated path, refusing every other field. No `Edit` or `Write` rule covers `.graphyard/master.json` itself: `autoMerge`, the merge method and every credential path stay operator-only.

## Pipeline speed

A *routine* item has at most one rework round and no hand-off between submit and merge. Its target is a submit→merge p50 of at most 30 minutes and p90 of at most 60 minutes, over at least ten deliveries, with a median of at most one rework round: every step between belongs to the control plane or the loop, leaving the master a genuine finding or a human-only decision. Never trade a gate, a proof, an identity rule or a lease rule for the number.

- **Per item:** each `master status` row's `speed`, from the item's own [pipeline timeline](protocol/pipeline-speed.md): `executionMs` (lease time over attempts), `waitMs` (everything else since the first claim), `reworkRounds`, `interventions`, `sinceSubmitMs` in flight, `submitToMergeMs` once delivered, `routine`.
- **Overall:** the top-level `speed` — `speed.submitToMerge` and `routine.submitToMerge` (nearest-rank p50/p90 and count), `reworkRounds` (median, p90, distribution), `interventions`, `execution`, `unmeasured` (deliveries predating the timeline), `items` in merge order, and `met`: `true` or `false` once ten routine deliveries are measured, `reason` naming the figure that misses, `null` until then.
- **Outside a status read:** `scripts/measure-pipeline-speed.mjs --split GY-55,GY-64 --record DIR` reads the snapshot with any read-capable credential and prints the same arithmetic, per `--split` item for deliveries merged before and after it landed; `--since`/`--until` bound the window, `--json` prints everything. The 3-hourly measurement runs it and `manual:speed-target-met` reads it.
- **A missed target** is routed like any finding: `items` names the slow deliveries, each row's `interventions` and `reworkRounds` say whether the time went to a hand-off or a rework round, and the [flow-analytics](flow-analytics.md) bottleneck summary which wait category held the rest.

## Containment and recovery

- **A quarantine whose supervisor died:** The fence stays up until someone proves the worker stopped. `containment` carries the recorded scope unit and supervisor pid, what systemd reports for it, and `containment.held`: every process still holding the fence with its pid, cmdline and cwd.
- `settleable: true`, no `refusals`: `master settle-containment GY-N "reason"`. **Any refusal:** stop the supervisor, then attest through a two-party `rework` decision, or `recover` once delivered ([procedure](operations-reference.md#recovery-procedures))
- **A lapsed lease:** `lease-loss` stands only for a worker that silently vanished; every other lapse is `lease.expired` with cause `submitted`, `blocked-awaiting-operator` or `stopped-by-attestation`. Reconciliation settles an explained one each tick, any `admin` settles it at once with `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`, and everything else needs a two-party `resolve` decision or a declared human session ([who may settle what](delegation.md#who-may-settle-what))
