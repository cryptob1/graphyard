<!-- page: Operate Graphyard | 5 | routing, merges. -->
# Master-agent operating mode

For the coordinator session: what the master decides, and must never do.

## Autonomy: agents approve agents

Three decisions are human-only: goals and priorities, spending money or opening third-party accounts, and issuing credentials to people. For every other, an agent decides and an independent agent approves ([who decides](glossary.md#who-decides)).

- **Non-weakening intent, under its own operator-agent identity:** `master create FILE REASON`, `master release GY-N REASON`, `master unblock GY-N REASON`, `master requirements GY-N FILE REASON` (additions), `master scope GY-N [REASON]`
- **[Two-party decisions](operator-automation.md#two-party-decisions), `requirements` rewrites and removals among them:** `master decide GY-N ACTION [JSON|@FILE] [--precedent ID[,ID]] [--context FINGERPRINT] REASON`, then `master approver GY-N DECISION [KIND]` (the registry's `approver` role; `KIND` overrides the runtime); the approver runs `master approve GY-N DECISION REASON`, `master decisions GY-N` reads it, `master withdraw GY-N DECISION REASON` retracts it
- **[Escalation context](operator-automation.md#escalation-context):** `master context GY-N [TRIGGER] [--budget N]` reads what a handler decides from, `master escalation GY-N [TRIGGER] [--budget N] [precedent|KIND]` spawns the handler
- **Routine operations:** `master principals [--apply]` (preview or apply a [roster rotation](deployment.md#changing-the-roster-safely) keeping every live principal), `master restart`, `master run [--once]`, `master config FIELD=VALUE…`, `master registry …` ([the fleet](fleet.md#the-agent-registry)), dispatch, GitHub administration, guarded merge

## Human-only waits

A worker whose item reaches one of the three decisions reserved to the human operator writes no prose blocker and keeps no lease: it records a **typed request** and stops.

```sh
node "$GRAPHYARD_CLI" park GY-N EPOCH money-or-accounts A Hetzner Cloud project with an API token for the live-install proofs -- The proofs provision real servers; opening the account is the operator's
```

`KIND` is `goals-and-priorities`, `money-or-accounts` or `credentials-for-people`; the words before `--` are the exact thing needed, those after it the reason. That one transaction (`POST /api/work/GY-N/park`, the lease holder only) writes `humanRequest`, ends the attempt as `released`, sets the blocker `Waiting on a human-only decision (…): NEEDED` and appends `human.requested`. The session exits holding nothing, its supervisor's next renewal is refused, no `lease-loss` is raised, and the item is not claimable. Every open request is in one list — the dashboard's [Needs you](dashboard.md#needs-you) tab, `graphyard human-requests`, `GET /api/human-requests` and `humanRequests` in `master status`, whose attention item is addressed to the human — with the decision, the thing needed, the reason, who asked, how long it has waited and the command that answers it.

```sh
graphyard answer GY-N [REQUEST] The project exists; its token is in the ops vault under hetzner-ci
graphyard answer GY-N [REQUEST] --decline We are not opening a Hetzner account this quarter
```

Only a declared human `admin` session may answer (`POST /api/work/*/answer`); an agent holding an admin credential is refused. A provided answer clears the request and its blocker in one transaction (`human.answered`), leaving the item claimable, and **the loop dispatches it on its next cycle** with the answer in the new attempt's prompt. A declined answer keeps the item parked with the human's words as its blocker, for the master to re-scope.

## Operate

Keep cycling until both hold: every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merged change is live-verified against the exact deployed release or has one too.

1. `master status` after startup and every material event
2. `master dispatch GY-N PROFILE` in `schedule.order` ([conflict avoidance](#conflict-avoidance))
3. Route review findings and failed proofs to rework; reviews and producers launch themselves
4. `master merge GY-N|--all` only when the exact candidate passes every gate ([guarded merges](github.md#the-guarded-merge)); a protocol mismatch refuses with `deploy main first`, and it stands down from an execution the loop holds
5. One deployment verification per delivery: `master verify-deployment GY-N`; main ahead of production, or a flagged capacity variable, is a deployment incident, never a ledger edit
6. Close finished agent sessions, then return to status

Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions: resolve them and keep cycling. Most of this runs unattended ([the loop](master-loop.md)), leaving the master the escalations, the findings and the two-party decisions.

## Conflict avoidance

Ready items are offered [smallest planned scope first](coordination.md#schedule-by-overlap-smallest-scope-first) within a priority; `schedule.held` items wait for the item ahead to merge, only `master dispatch GY-N PROFILE [--allow-overlap]` overriding a hold, and `conflicts` is a real `git merge-tree` between fetched candidate heads.

## Session handles and liveness

Every launched session records a durable handle on the item — runtime, host, Herdr workspace, tab and pane, its transcript, and what it is working on — under `sessions` in `master status` and in the dashboard drawer, each with the one command or link that attaches to it: `herdr pane attach PANE` while it runs, its transcript once finished. Every launcher records one, naming the principal whose session it is; the tab the runtime opened and the transcript the agent writes the session records for itself with the `session` work command (`POST /api/work/GY-N/session`), and a handle merges field by field. Writing one is authority, because the attach command on it is an instruction somebody runs: an existing handle belongs to the session it names, the coordinator that launched it, or an admin, and creating one belongs to the implementation session under the epoch it holds or — with no epoch — to its launcher or the session of a live dispatch request whose id it carries, so nothing else can squat a predictable id or push a running session off the bounded list, which retires finished handles first.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing finished sessions is not the master's
manual duty.** A handle a dead session left behind would otherwise hold its role slot until a person noticed.

**On what interval.** The sweep runs on every automatic-dispatch tick — `run.dispatchIntervalSeconds`, 10 seconds by default and 30 at most — because a session that died reports nothing. A handle the runtime no longer reports is left alone for a 60-second grace, counted from the first sweep
that missed it and never shorter than the handle's own age, so a vanished record is closed within 90 seconds of the runtime dropping it, and one the runtime reports again starts the grace over. `dispatch.sessionReconcile` carries the bound, the last tick's closures, the handles inside their grace, and any closure it could not write back. A handle another host launched is left to
that host's loop and holds its slot until then, exactly as an unreadable runtime does.

**What it closes, and with which reason.**

- **Vanished** — unreported for the whole grace: how a coding session that exited is recognised. The outcome names the runtime, the host, how long it went unreported and how long after its last observed activity.
- **Ended** — the runtime lists it in one of that runtime's terminal states (`src/harness.ts`), which today only Muse has (`exited-error`, `terminated`). `idle`, `done` and
  `blocked` are deliberately not terminal anywhere: each is a live session waiting at its prompt, the one moment somebody needs its attach command.
- **Superseded** — a review or proof session bound to something the item has moved past: a merged candidate, a delivered item, a head the item no longer has, an item returned for rework. A delivered item is closed the same
  way as any other, since ending a handle decides nothing; an implementation session is never closed this way, its lease deciding what it may still do.
- **Duplicate** — two live review or proof sessions for one role and head cannot both stand, so the older is closed naming the session that holds the slot: one live review of a head, one producer session per proof group.

A closure is a record, never authority: it decides no gate, ends no lease, and stops no process. **The role slot follows the reconciled record:** a profile's concurrency is counted against live
sessions only — the runtime's own listing plus every recorded handle the sweep has not judged over — so a handle holds its slot before the runtime lists the session and across a restart, and a name is
busy only while a live session has it.

**A session that is running and making no progress** is not closed, because only a reader can tell whether it is working: `master status` raises one attention item per session past its role's maximum — 4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer session, 12h coordination — naming the item, the role, how long it has run, when it was last observed doing anything, and whether the runtime still reports it live. A session Herdr reports blocked is waiting on input, not gone, so its handle stays `running` carrying why.

**So what an operator or a master does instead of closing sessions by hand:** nothing, for a session
that finished or died — the sweep frees its slot on the next tick, and `graphyard master run --once` does one sweep when the loop is stopped. For one the attention item names as live but overlong, attach to it with the command on the handle and stop it there if it is stuck. Never mark
another session's handle finished to free a slot: the slot was never held by anything but a live session.

## Independent review

`master run` launches [the reviewer](github.md#the-reviewer-app) for every submitted head; `master review GY-N [PROFILE]` is that launcher, and the recovery after a refused launch. `master reviewer setup` registers the App and `master reviewer add FILE` a profile ([onboarding](onboarding.md#5-register-the-reviewer-identity), with [Claude](../examples/master/claude-reviewer.json), [Cursor](../examples/master/cursor-reviewer.json) and [opencode](../examples/master/opencode-reviewer.json) templates).

- **`approvals` ([trade-off](onboarding.md#approval-modes)):** `auto` adds the runtime's non-interactive contract (`--permission-mode bypassPermissions`, `OPENCODE_PERMISSION`), `prompt` lets you opt out
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

## Pipeline speed

- **Target:** submit→merge p50 at most 30 minutes and p90 at most 60 minutes, over at least ten deliveries, with a median of at most one rework round; never traded for a gate, proof, identity rule or lease rule
- **Per item:** each `master status` row's `speed`, [derived from its pipeline timeline](protocol/pipeline-speed.md#derived-figures): `executionMs`, `waitMs`, `reworkRounds`, `interventions`, `submitToMergeMs`, `routine`
- **Overall:** the top-level `speed`: `speed.submitToMerge` and `routine.submitToMerge` (nearest-rank p50/p90 and count), `execution`, `unmeasured` (explained by `coverage`) and `items` in merge order; `met` turns `true` or `false` once ten routine deliveries are measured, `reason` naming the figure that misses
- **Outside a status read:** `scripts/measure-pipeline-speed.mjs --split GY-55,GY-64 --record DIR` prints the same arithmetic with any read-capable credential, per `--split` item for deliveries merged before and after it landed; `--since`/`--until` bound the window, `--json` prints everything. The 3-hourly measurement runs it for `manual:speed-target-met`

## Containment and recovery

- **A quarantine whose supervisor died:** `containment` carries the recorded scope unit and supervisor pid, what systemd reports for it, and `containment.held`: each process still holding the fence, with pid, cmdline and cwd
- `settleable: true`, no `refusals`: `master settle-containment GY-N "reason"`. **Any refusal:** stop the supervisor, then attest through a two-party `rework` decision, or `recover` once delivered ([procedure](operations-reference.md#recovery-procedures))
- **A lapsed lease:** `lease-loss` stands only for a worker that silently vanished; every other lapse is `lease.expired` with cause `submitted`, `blocked-awaiting-operator` or `stopped-by-attestation`. Reconciliation settles an explained one each tick, any `admin` at once with `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`; the rest need a two-party `resolve` decision or a declared human session ([who settles what](delegation.md#who-may-settle-what))
- **Merged without a valid execution:** [merge bypass](operations-reference.md#merge-bypass), a two-party `merge` decision requested after the merge. A merged item whose content is **not on the base branch** is a [reverted delivery](coordination.md#the-landing-re-check) instead, and no merge decision is requested until the base branch holds its content
