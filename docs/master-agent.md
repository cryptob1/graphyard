<!-- page: Operate Graphyard | 5 | routing, recovery, merges. -->
# Master-agent operating mode

For the coordinator session: what the master decides, and must never do.

## Autonomy: agents approve agents

Three decisions are human-only: goals and priorities, spending money or opening third-party accounts, and issuing credentials to people. For every other, an agent decides and an independent agent approves: [who decides](glossary.md#who-decides).

- **Non-weakening intent, as its own operator-agent identity:** `master create FILE REASON`, `master release GY-N REASON`, `master unblock GY-N REASON`, `master requirements GY-N FILE REASON` (additions), `master scope GY-N [REASON]`
- **[Two-party decisions](operator-automation.md#two-party-decisions), `requirements` rewrites and removals among them:** `master decide GY-N ACTION [JSON|@FILE] REASON`, then `master approver GY-N DECISION`; the approver runs `master approve GY-N DECISION REASON`, `master decisions GY-N` reads the outcome, `master withdraw GY-N DECISION REASON` retracts it
- **Routine operations:** `master principals [--apply]` (preview or apply a [roster rotation](deployment.md#changing-the-roster-safely) keeping every live principal), `master restart` (stop this host's durable loop, restart it detached), `master run [--once]`, `master config FIELD=VALUE…`, dispatch, GitHub administration, guarded merge

## Operate

Keep cycling until both hold: every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merged change is live-verified against the exact deployed release or has one too.

1. `master status` after startup and every material event
2. `master dispatch GY-N PROFILE` in `schedule.order` ([conflict avoidance](#conflict-avoidance))
3. Route review findings and failed proofs to rework; reviews and producers launch themselves
4. `master merge GY-N|--all` only when the exact candidate passes every gate ([guarded merges](github.md#the-guarded-merge)); a protocol mismatch refuses with `deploy main first`, and it stands down from an execution the loop holds
5. One deployment verification per delivery: `master verify-deployment GY-N`; main ahead of production, or a flagged capacity variable, is a deployment incident to fix, never a ledger edit
6. Close finished agent sessions, then return to status

Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions: resolve them and keep cycling.

## Conflict avoidance

- **Order:** ready items are offered smallest planned scope first within a priority ([the rule](coordination.md#schedule-by-overlap-smallest-scope-first))
- **Held:** `schedule.held` items wait for the item ahead to merge; only `master dispatch GY-N PROFILE [--allow-overlap]` overrides a hold
- **`conflicts`:** a real `git merge-tree` between fetched candidate heads

## Automatic dispatch at submit

The control plane [records under `autoDispatch`](protocol/github-webhook.md#automatic-dispatch-at-submit) what the exact head needs; the loop launches it.

- **Review request:** one per head the policy expects a GitHub verdict for
- **Producer request:** one per proof group (`unit`, `integration`, and `manual` for proofs listed in `producerProofs`) for proofs no trusted passing evidence binds; a group whose trusted evidence already failed on this head is a finding to route, not a run to repeat

- **Binding:** Head, base and policy revision; changing any cancels the request and asks afresh unless a carried binding covers it. An approval, a `CHANGES_REQUESTED` verdict or trusted evidence satisfies it; rework, closure and merge cancel it
- **Launch cadence:** within 30 seconds of the request, then every `dispatchIntervalSeconds`: the reviewer profile (`run.reviewerProfile`, or the only one) plus one producer session per proof group on a free, independent producer profile (`master producer add FILE`, [template](../examples/master/claude-producer.json))
- **Producer identity:** its credential authenticates exactly its principal as a producer, never shares a principal with a worker profile, and is skipped for an item its principal implemented. The session reads it from `GRAPHYARD_TOKEN_FILE`, works in a detached worktree of the head, and submits each proof bound to that head, base and policy revision, a failing run as `fail`
- **One session per request:** `.graphyard/reviews.json` and `.graphyard/producers.json` record which request each session answers. A session is `failed` when Herdr reports it finished, gone or blocked on a prompt for five minutes without a verdict or evidence, and relaunched at most four times; `master review GY-N [PROFILE]` recovers an exhausted one
- **Reviewer retry:** a reviewer first seen stopped without a verdict is prompted once, in place, to post the verdict it judged, the five minutes running from that sight; no master sends the prompt or edits the ledger by hand
- **Superseded records:** a pending record whose head, base or policy revision the candidate superseded is cancelled and never blocks the new head's launch; one for the exact candidate still refuses a second session
- **Settling withdraws the credential:** the session directory is removed even when Herdr cannot confirm the pane is gone. A verdict or a superseded head settles regardless, the close failure shown as `attention`; a merely failed or expired session stays pending for the next reconcile to retry
- **Session contract:** Post the verdict, submit pass or fail evidence, or record a blocker naming the blocked command and its error: never stop to ask; an ending that waits on input is recorded as failed
- **The master's half:** Findings, rework and merges; it never launches reviews or producers by hand, never approves a candidate, never submits evidence
- **Profiles and attention:** `master producer add FILE`, `master producer replace FILE`, `master producer remove NAME`, `master reviewer remove NAME`; `setup.attention` reports a reviewer App registered but never bound, a bound App whose credential file is gone, and a `herdrWorkspace` Herdr no longer lists

### The request is the session's first message

Every session Graphyard launches — worker, reviewer, producer, approver, master — takes its instruction as its own first request on the runtime's command line: the positional prompt after the flags for Claude Code, Codex and Cursor, `--prompt` for OpenCode. `master status` reports `delivery: request`, or `paste` for a runtime with no request contract.

- **Order:** the request comes last, after `agentArgs` and any role-file flags, so `agentArgs` must not end in a variadic flag (`--add-dir`, `--allowedTools`) that would swallow it; a role file's Claude Code session, reading only user settings, is passed the generated statement as `--append-system-prompt`
- **The pastes left:** a paste-only runtime's request, the loop's one re-prompt, the reviewer's verdict reminder — the launcher repeating the session's own request ([what that authorizes](onboarding.md#what-the-generated-instructions-authorize)). One counts only when Herdr sees the runtime leave `idle`, since a runtime ready before its input (OpenCode's loading UI) drops it: delivered up to three times, then the session is closed, releasing a worker's claim, and relaunched once from scratch before the launch is reported refused
- **Started:** a start timing out while Herdr sees the expected runtime acting is a session that started; a worker starts once its supervisor session is seen `working`
- **Acknowledged:** `session.activity` is `awaiting acknowledgement` (`counts.dispatchAwaiting`, beside `counts.dispatchRunning`) until Herdr sees activity — `working`, `blocked`, or a screen changing under a long command — across thirty seconds of consecutive sightings (`acknowledgedAt`), or a verdict or evidence exists
- **One re-prompt:** a session quiet for `run.acknowledgementSeconds` (30–900, default 90) is sent its request again, once (`repromptedAt`, the row's `attention`), restarting the window
- **`never started: …`:** a session settling still unacknowledged, quoting the last words `finished (done) without …` also carries. A failed launch is not failed work: it is relaunched a minute later, outside the four attempts and the widening wait, three exhausting the request (`retry.neverStarted`, `retry.unstartedLimit`); it is never settled before its re-prompt and the interval after it, whatever the five-minute grace, and `run.producerTimeoutMinutes` (at least 5) bounds it all

## Agent environments

A principal is who claims, reviews or proves; an *agent environment* is whose provider subscription a session spends ([onboarding](onboarding.md#agent-environments)). Every launch profile lists its environments in `accounts`, in failover order; `master environments [--create KINDS] [--directory DIR] [--apply]` discovers, creates and profiles them.

- **Checked before every launch** (`master dispatch`, the loop's worker dispatch, automatic reviewer and producer launches): the session runs on the first account logged in and holding quota — no unreset usage window at or above `run.quotaCeilingPercent` (default 95)
- **Quota sources:** Claude's 5-hour and 7-day windows from the provider's usage endpoint; Codex's from its newest session's rate limits; OpenCode and Cursor expose none: theirs is `unknown`, never blocking a launch
- **Failover:** an account failing either check is skipped with its reason (`claude-a quota is exhausted (7d window at 100% until …; ceiling 95%)`, or not logged in) and the launch fails over to the next, the tick recording it. A session on another runtime's account runs that runtime, without the profile's `agentArgs`
- **No launchable account:** a worker profile claims nothing and is unavailable in `master status` (`workers[].credential`); the loop routes its item elsewhere; review falls through `run.reviewerProfile`, a producer request to the next independent producer
- **Reported:** `dispatch.accounts` shows every environment as the last launch check saw it (login, quota, usage windows, the login command when logged out), with recent launches that skipped an account by role, profile, item and reason. The record sits beside the coordinator credential (`*.environments.json`, mode 0600) and never holds a provider token.

## Independent review

`master run` launches [the reviewer](github.md#the-reviewer-app) for every submitted head; `master review GY-N [PROFILE]` is that launcher, and the recovery after a refused launch.

```sh
node "$GRAPHYARD_CLI" master reviewer setup          # registers the reviewer App
node "$GRAPHYARD_CLI" master reviewer add /path/to/reviewer-profile.json
node "$GRAPHYARD_CLI" master review GY-42 claude-reviewer
```

- **Profile templates:** [Claude](../examples/master/claude-reviewer.json), [Cursor](../examples/master/cursor-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)
- **`approvals` ([trade-off](onboarding.md#approval-modes)):** `auto` adds the runtime's non-interactive contract (`--permission-mode bypassPermissions`, `OPENCODE_PERMISSION`); `prompt` lets you opt out
- **Verdict:** posting it is granted to the reviewer role: the launch allows exactly that one call
- **App confirmation:** the master's, through the browser flows below

## GitHub administration through the browser

The master owns control-plane App permission updates, their acceptance and branch-protection reconciliation. Where GitHub offers only a page (manifest confirmation, permission-request acceptance, a sudo prompt), three flows drive the operator's authenticated browser profile headless:

- **Commands:** `master browser app-permissions`, `master browser installation-accept`, `master browser protection`
- **Profile:** named by `master init --browser-profile PROFILE` (`--browser-executable PATH`, requiring it, selects a non-default Chrome); the harness denies the session every direct browser command
- **Routine reconciliation:** stays on `master protection [--apply]`

| Flow | Page | What it does | Verified afterwards by |
| --- | --- | --- | --- |
| `app-permissions` | `github.com/settings/apps/SLUG/permissions` | Raises every permission below the declared set | `gh api apps/SLUG` reports each at or above it |
| `installation-accept` | `github.com/settings/installations/ID/permissions/update` | Accepts this installation's pending permission request | `gh api user/installations` shows it granting them |
| `protection` | `github.com/OWNER/REPO/settings/branches` → the base branch's classic rule | Sets `strict` off, administrator enforcement on, the approval settings open review policies need | the protection plan re-read through the API (`--dry-run` previews it) |

Every flow is audited:

- **`.graphyard/master-actions/<time>-<flow>-<id>/`:** `record.json` lists each step, its arguments and result; a numbered PNG follows every navigation
- **`.graphyard/master-actions/ledger.json` (mode 0600):** one append-only entry naming who, what, when, before, after and whether verification passed; `master status` shows the last five under `administration`
- **GitHub's *Confirm access* page:** the flow clicks *Use GitHub Mobile*, writes the pairing code to `.graphyard/master-actions/sudo.json` and reports it under `administration.sudo` to approve on your device, then polls for three minutes: an unapproved prompt fails with the rerun command, one without a GitHub Mobile option is refused

The master never stores, exports or copies the browser profile's cookies or saved state and never drives it outside these three flows. It never adds a repository to an installation, replaces protection through the API, uses a merge bypass, edits a candidate, pushes code, posts a verdict, mints an installation token or reads a worker, reviewer or coordinator credential.

## Harness permissions

A harness command classifier would otherwise stop the master's routine commands. The rules, and the per-role files launched sessions use, are in [operator automation](operator-automation.md#harness-rules-per-role); an allowlist is a prompt policy, not an authority boundary.

- `master start claude`: writes project-scoped rules to the git-ignored `.claude/settings.local.json` before the session starts
- `master harness claude [--apply]`: previews or writes them
- `master harness codex`: prints the `trust_level = "trusted"` block for `$CODEX_HOME/config.toml`

They also cover:

- **Configuration:** reading `.graphyard/master.json`
- **The loop's systemd unit, named exactly:** `systemctl --user restart graphyard-master.service`, `journalctl --user -u graphyard-master.service`
- **Deployment administration:** `railway status`, `logs`, `deployment`, `redeploy`, `master verify-deployment`
- **CI runs:** `gh run list`, `view`, `watch`, `rerun`, `gh workflow run`
- `master config FIELD=VALUE…`: tunes loop and dispatch cadence, proof and smoke workflows, deployment URL and SHA field, reviewer profile, producer timeout, quota ceiling and a profile's account order (`accounts:PROFILE=a,b`) through the operator commands' validated path, refusing every other field
- **Operator-only:** no `Edit` or `Write` rule covers `.graphyard/master.json` itself: `autoMerge`, the merge method and every credential path

## Pipeline speed

- **A *routine* item:** at most one rework round and no hand-off between submit and merge; every step between belongs to the control plane or the loop, leaving the master genuine findings and human-only decisions
- **Target:** submit→merge p50 at most 30 minutes and p90 at most 60 minutes, over at least ten deliveries, with a median of at most one rework round; never traded for a gate, proof, identity rule or lease rule

- **Per item:** each `master status` row's `speed`, from the item's [pipeline timeline](protocol/pipeline-speed.md): `executionMs`, `waitMs`, `reworkRounds`, `interventions`, `sinceSubmitMs` in flight, `submitToMergeMs` once delivered, `routine`.
- **Overall:** the top-level `speed`: `speed.submitToMerge` and `routine.submitToMerge` (nearest-rank p50/p90 and count), `reworkRounds`, `interventions`, `execution`, `unmeasured` (each explained by `coverage`) and `items` in merge order; `met` turns `true` or `false` once ten routine deliveries are measured, with `reason` naming the figure that misses.
- **Outside a status read:** `scripts/measure-pipeline-speed.mjs --split GY-55,GY-64 --record DIR` reads the snapshot with any read-capable credential and prints the same arithmetic, per `--split` item for deliveries merged before and after it landed; `--since`/`--until` bound the window, `--json` prints everything. The 3-hourly measurement runs it and `manual:speed-target-met` reads it.
- **A missed target** is a finding to route: `items` names the slow deliveries, `interventions` and `reworkRounds` whether a hand-off or rework round took the time, and the [flow-analytics](flow-analytics.md) bottleneck summary which wait category held the rest.

## Containment and recovery

- **A quarantine whose supervisor died:** `containment` carries the recorded scope unit and supervisor pid, what systemd reports for it, and `containment.held`: every process still holding the fence with its pid, cmdline and cwd.
- `settleable: true`, no `refusals`: `master settle-containment GY-N "reason"`. **Any refusal:** stop the supervisor, then attest through a two-party `rework` decision, or `recover` once delivered ([procedure](operations-reference.md#recovery-procedures))
- **A lapsed lease:** `lease-loss` stands only for a worker that silently vanished; every other lapse is `lease.expired` with cause `submitted`, `blocked-awaiting-operator` or `stopped-by-attestation`. Reconciliation settles an explained one each tick, any `admin` settles it at once with `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`; everything else needs a two-party `resolve` decision or a declared human session ([who may settle what](delegation.md#who-may-settle-what))
- **Merged without a valid execution:** [merge bypass](operations-reference.md#merge-bypass), a two-party `merge` decision requested after the merge
