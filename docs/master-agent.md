<!-- page: Operate Graphyard | 5 | routing, merges. -->
# Master-agent operating mode

For the coordinator session: what the master decides, and must never do.

## Autonomy: agents approve agents

Three decisions belong to the human operator alone ([who decides](glossary.md#who-decides)); for every other, an agent decides and an independent agent approves.

- **Non-weakening intent, under its own operator-agent identity:** `master create FILE REASON`, `master release GY-N REASON`, `master unblock GY-N REASON`, `master requirements GY-N FILE REASON` (additions), `master scope GY-N [REASON]`
- **[Two-party decisions](operator-automation.md#two-party-decisions), `requirements` rewrites and removals among them:** `master decide GY-N ACTION [JSON|@FILE] [--precedent ID[,ID]] [--context FINGERPRINT] REASON`, then `master approver GY-N DECISION [KIND]` (the registry's `approver` role; `KIND` overrides the runtime); the approver runs `master approve GY-N DECISION REASON`, `master decisions GY-N` reads it, `master withdraw GY-N DECISION REASON` retracts it
- **[Escalation context](operator-automation.md#escalation-context):** `master context GY-N [TRIGGER] [--budget N]` reads what a handler decides from, `master escalation GY-N [TRIGGER] [--budget N] [precedent|KIND]` spawns the handler
- **Routine operations:** `master principals [--apply]` (preview or apply a [roster rotation](deployment.md#changing-the-roster-safely) keeping every live principal), `master restart`, `master run [--once]`, `master config FIELD=VALUE…`, `master registry …` ([the fleet](fleet.md#the-agent-registry)), dispatch, GitHub administration, guarded merge

## Operate

Keep cycling until both hold: every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merged change is live-verified against the exact deployed release or has one too.

1. `master status` after startup and every material event
2. `master dispatch GY-N PROFILE` in `schedule.order` ([conflict avoidance](#conflict-avoidance))
3. Route review findings and failed proofs to rework; reviews and producers launch themselves
4. `master merge GY-N|--all` only when the exact candidate passes every gate ([guarded merges](github.md#the-guarded-merge)); a protocol mismatch refuses with `deploy main first`, and it stands down from an execution the loop holds
5. One deployment verification per delivery: `master verify-deployment GY-N`; main ahead of production, or a flagged capacity variable, is a deployment incident, never a ledger edit
6. Close finished agent sessions, then return to status

Ordinary review findings, rework, idle workers and proof setup are not stopping conditions. Most of this runs unattended ([the loop](master-loop.md)), leaving the master the escalations, the findings and the two-party decisions.

## Conflict avoidance

Ready items are offered [smallest planned scope first](coordination.md#schedule-by-overlap-smallest-scope-first) within a priority; `schedule.held` items wait for the item ahead to merge, only `master dispatch GY-N PROFILE [--allow-overlap]` overriding a hold, and `conflicts` is a real `git merge-tree` between fetched candidate heads.

## Automatic dispatch at submit

The control plane [records under `autoDispatch`](protocol/github-webhook.md#automatic-dispatch-at-submit) what the exact head needs; the loop launches it.

- **Requests:** one review per head the policy expects a GitHub verdict for; one producer per proof group (`unit`, `integration`, and `manual` for proofs in `producerProofs`) no trusted passing evidence binds. A group whose trusted evidence already failed on this head is a finding to route, not a run to repeat
- **Binding:** head, base and policy revision; changing any asks afresh unless a carried binding covers it. An approval, a `CHANGES_REQUESTED` verdict or trusted evidence satisfies it; rework, closure and merge cancel it
- **Launch cadence:** within 30 seconds of the request, then every `dispatchIntervalSeconds` — the reviewer profile (`run.reviewerProfile`, or the only one) and one producer session per proof group on a free, independent producer profile ([template](../examples/master/claude-producer.json)), up to each profile's [concurrency](fleet.md#per-role-concurrency); with fewer free slots than groups the rest wait and `master status` names the limit
- **Producer identity:** its credential authenticates exactly its principal as a producer, never shares a principal with a worker profile, and is skipped for an item its principal implemented. The session reads it from `GRAPHYARD_TOKEN_FILE`, works in the detached worktree of its own [session checkout](fleet.md#session-checkouts), and submits each proof against that binding, a failing run as `fail`
- **One session per request:** `.graphyard/reviews.json` and `.graphyard/producers.json` record which request each session answers. A session Herdr reports finished, gone or blocked on a prompt for five minutes without a verdict or evidence is `failed`, relaunched at most four times; `master review GY-N [PROFILE]` recovers an exhausted one. A reviewer first seen stopped is prompted once, in place, to post the verdict it judged, those five minutes running from that sight — never by a master's own hand
- **Session contract:** post the verdict, submit evidence or record a blocker naming the blocked command and its error; an ending that waits on input is recorded as failed
- **The master's half:** findings, rework and merges; it never launches reviews or producers by hand, never approves a candidate, never submits evidence. A request nothing answers — a dismissed approval, or a session that settled without a verdict — stays open and is [attention, not silence](github.md#dismissed-approvals-and-unanswered-requests)
- **Profiles and attention:** `master producer add|replace FILE`, `master producer remove NAME`, `master reviewer remove NAME`, and `concurrency` in either profile; `setup.attention` reports a reviewer App registered but never bound, a bound App whose credential file is gone, and a `herdrWorkspace` Herdr no longer lists

### The request is the session's first message

Every session Graphyard launches — worker, reviewer, producer, approver, master — takes its instruction as its own first request on the runtime's command line: positional after the flags for Claude Code, Codex and Cursor, `--prompt` for OpenCode. `master status` reports `delivery: request`, or `paste` for a runtime with no request contract.

- **Order:** the request comes last, after `agentArgs` and any role-file flags, so `agentArgs` must not end in a variadic flag (`--add-dir`, `--allowedTools`) that would swallow it
- **The pastes left:** a paste-only runtime's request, the loop's one re-prompt, the reviewer's verdict reminder — the launcher repeating the session's own request ([what that authorizes](onboarding.md#what-the-generated-instructions-authorize)). One counts only when Herdr sees the runtime leave `idle`: delivered three times at most, then the session is closed, a worker's claim released, and relaunched once from scratch before the launch is reported refused
- **Acknowledged:** `session.activity` is `awaiting acknowledgement` (`counts.dispatchAwaiting`, beside `counts.dispatchRunning`) until Herdr sees activity — `working`, `blocked`, or a screen changing under a long command — across thirty seconds of consecutive sightings (`acknowledgedAt`), or a verdict or evidence exists. A session quiet for `run.acknowledgementSeconds` (30–900, default 90) is sent its request again, once (`repromptedAt`, the row's `attention`), restarting the window

## Independent review

`master run` launches [the reviewer](github.md#the-reviewer-app) for every submitted head; `master review GY-N [PROFILE]` is that launcher, and the recovery after a refused launch. `master reviewer setup` registers the App and `master reviewer add FILE` a profile ([onboarding](onboarding.md#5-register-the-reviewer-identity), with [Claude](../examples/master/claude-reviewer.json), [Cursor](../examples/master/cursor-reviewer.json) and [opencode](../examples/master/opencode-reviewer.json) templates).

- **Verdict:** posting it is granted to the reviewer role, the launch allowing exactly that one call; the App confirmation is the master's, through the browser flows below

## GitHub administration through the browser

The master owns control-plane App permission updates, their acceptance and branch-protection reconciliation. Where GitHub offers only a page, `master browser app-permissions`, `master browser installation-accept` and `master browser protection` drive headless the operator's authenticated browser profile named by `master init --browser-profile PROFILE` (`--browser-executable PATH` selects a non-default Chrome and requires it); the harness denies every direct browser command, and routine reconciliation stays on `master protection [--apply]`.

| Flow | Page | What it does | Verified afterwards by |
| --- | --- | --- | --- |
| `app-permissions` | `github.com/settings/apps/SLUG/permissions` | Raises every permission below the declared set | `gh api apps/SLUG` reports each at or above it |
| `installation-accept` | `github.com/settings/installations/ID/permissions/update` | Accepts the pending permission request | `gh api user/installations` shows it granting them |
| `protection` | `github.com/OWNER/REPO/settings/branches` → the base branch's classic rule | Sets `strict` off, administrator enforcement on, the approval settings open review policies need | the protection plan re-read through the API (`--dry-run` previews it) |

Every flow is audited under `.graphyard/master-actions/`: a per-run directory whose `record.json` lists each step, its arguments and result with a numbered PNG after every navigation, and `ledger.json` (mode 0600), an append-only entry naming who, what, when, before, after and whether verification passed, the last five under `administration` in `master status`. GitHub's *Confirm access* page is answered by clicking *Use GitHub Mobile*, writing the two-digit pairing code to `sudo.json` and reporting it under `administration.sudo` to approve on your device, then polling three minutes: an unapproved prompt fails with the rerun command, one without a GitHub Mobile option is refused.

The master never stores, exports or copies the browser profile's cookies or saved state, never drives it outside these three flows, and never adds a repository to an installation, replaces protection through the API, uses a merge bypass, edits a candidate, pushes code, posts a verdict, mints an installation token or reads a worker, reviewer or coordinator credential.

## Harness permissions

A harness command classifier would otherwise stop the master's routine commands; the rules, and the per-role files launched sessions use, are in [operator automation](operator-automation.md#harness-rules-per-role). An allowlist is a prompt policy, never an authority boundary.

- `master start claude` writes project-scoped rules to the git-ignored `.claude/settings.local.json` before the session starts; `master harness claude [--apply]` previews or writes them, and `master harness codex` prints the `trust_level = "trusted"` block for `$CODEX_HOME/config.toml`
- They also cover reading `.graphyard/master.json`; the loop's systemd unit, named exactly (`systemctl --user restart graphyard-master.service`, `journalctl --user -u graphyard-master.service`); `railway status`, `logs`, `deployment`, `redeploy`, `master verify-deployment`; and `gh run list`, `view`, `watch`, `rerun`, `gh workflow run`
- `master config FIELD=VALUE…` tunes loop and dispatch cadence, proof and smoke workflows, deployment URL and SHA field, reviewer profile, producer timeout, quota ceiling and a profile's account order (`accounts:PROFILE=a,b`), refusing every other field
- **Operator-only:** no `Edit` or `Write` rule covers `.graphyard/master.json` itself: `autoMerge`, the merge method and every credential path

## Pipeline speed

- **A *routine* item:** at most one rework round and no hand-off between submit and merge, every step between belonging to the control plane or the loop
- **Target:** submit→merge p50 at most 30 minutes and p90 at most 60 minutes, over at least ten deliveries, with a median of at most one rework round; never traded for a gate, proof, identity rule or lease rule
- **Per item:** each `master status` row's `speed`, [derived from its pipeline timeline](protocol/pipeline-speed.md#derived-figures): `executionMs`, `waitMs`, `reworkRounds`, `interventions`, `submitToMergeMs`, `routine`
- **Overall:** the top-level `speed`: `speed.submitToMerge` and `routine.submitToMerge` (nearest-rank p50/p90 and count), `execution`, `unmeasured` (explained by `coverage`) and `items` in merge order; `met` turns `true` or `false` once ten routine deliveries are measured, `reason` naming the figure that misses
- **Outside a status read:** `scripts/measure-pipeline-speed.mjs --split GY-55,GY-64 --record DIR` prints the same arithmetic with any read-capable credential, per `--split` item for deliveries merged before and after it landed; `--since`/`--until` bound the window, `--json` prints everything. The 3-hourly measurement runs it for `manual:speed-target-met`

## Containment and recovery

- `settleable: true`, no `refusals`: `master settle-containment GY-N "reason"`. **Any refusal:** stop the supervisor, then attest through a two-party `rework` decision, or `recover` once delivered ([procedure](operations-reference.md#recovery-procedures))
- **A lapsed lease:** `lease-loss` stands only for a worker that silently vanished; every other lapse is `lease.expired` with cause `submitted`, `blocked-awaiting-operator` or `stopped-by-attestation`. Reconciliation settles an explained one each tick, any `admin` at once with `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`; the rest need a two-party `resolve` decision or a declared human session ([who settles what](delegation.md#who-may-settle-what))
- **Merged without a valid execution:** [merge bypass](operations-reference.md#merge-bypass), a two-party `merge` decision requested after the merge. A merged item whose content is **not on the base branch** is a [reverted delivery](coordination.md#the-landing-re-check) instead, and no merge decision is requested until the base branch holds its content
