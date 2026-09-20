<!-- page: Operate Graphyard | 5 | routing, recovery, guarded merges. -->
# Master-agent operating mode

For the coordinator session: what the master decides, and must never do.

## Autonomy: agents approve agents

Three decisions are human-only: goals and priorities, spending money or opening third-party accounts, and issuing credentials to people. Every other names an agent that makes it and an independent agent that approves it — [who decides](glossary.md#who-decides).

- **Non-weakening intent, as its own operator-agent identity:** `master create FILE REASON`, `master release GY-N REASON`, `master unblock GY-N REASON`, `master requirements GY-N FILE REASON` (additions), `master scope GY-N [REASON]`
- **[Two-party decisions](operator-automation.md#two-party-decisions): `release`, `unblock`, `requirements` rewrites and removals, `resolve`, `attest`, `merge`, `rework`, `recover`, `grant`:** `master decide GY-N ACTION [JSON|@FILE] REASON`, then `master approver GY-N DECISION`; the approver runs `master approve GY-N DECISION REASON`, and `master decisions GY-N` reads the outcome
- **Routine operations:** `master principals [--apply]`, `master restart`, `master run [--once]`, dispatch, GitHub administration, guarded merge

## Operate

Keep cycling until both hold: (1) every in-scope item is Done or has a genuinely external blocker recorded in Graphyard; and (2) every merged change is live-verified against the exact deployed release, or a genuinely external deployment blocker is recorded in Graphyard.

1. `master status` after startup and every material event
2. `master dispatch GY-N PROFILE [--allow-overlap]` in `schedule.order`, leaving `schedule.held` items for the item ahead to merge ([conflict avoidance](coordination.md#schedule-by-overlap-smallest-scope-first) — `conflicts` in `master status` is a real `git merge-tree` between the fetched candidate heads, not an overlap guess)
3. Route review findings and failed proofs to rework; reviews and producers launch themselves
4. `master merge GY-N|--all` only when the exact candidate passes every gate ([guarded merges](github.md#the-guarded-merge)); a protocol mismatch refuses with `deploy main first`
5. One deployment verification per delivery: `master verify-deployment GY-N`. Main ahead of production, or a flagged capacity variable, is a deployment incident to fix, never a ledger edit
6. Close finished agent sessions, then return to status

Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions: resolve them and keep cycling.

## Automatic dispatch at submit

The control plane records what the exact head needs under `autoDispatch`; the loop launches it.

The two request kinds and everything they carry are [recorded by the control plane](protocol/github-webhook.md#automatic-dispatch-at-submit): one **review request** per head the policy expects a GitHub verdict for, and one **producer request per proof group** — `unit`, `integration`, and `manual` for proofs listed in `producerProofs` — for proofs no trusted passing evidence binds. A group whose trusted evidence already failed on this head is a finding to route, not a run to repeat.

- **Binding:** Head, base and policy revision; changing any cancels the request and asks afresh unless a carried binding covers it. An approval, a `CHANGES_REQUESTED` verdict or trusted evidence satisfies it; rework, closure and merge cancel it
- **Launch cadence:** Launched within 30 seconds of the request, then every `dispatchIntervalSeconds`: the reviewer profile (`run.reviewerProfile`, or the only one) plus one producer session per proof group on a free, independent producer profile in `.graphyard/master.json` (`master producer add FILE`, template [claude-producer.json](../examples/master/claude-producer.json))
- **Producer identity:** Its credential must authenticate exactly its principal as a producer, never shares a principal with a worker profile, and is skipped for an item its principal implemented. The session receives it as a path in `GRAPHYARD_TOKEN_FILE`, works in a detached worktree of the exact head, and submits each proof bound to that head, base and policy revision, a failing run as `fail`
- **One session per request:** `.graphyard/reviews.json` and `.graphyard/producers.json` record which request each session answers. A session is `failed` when Herdr reports it finished, gone or blocked on a prompt for five minutes without a verdict or evidence, and relaunched at most four times; `master review GY-N [PROFILE]` recovers an exhausted request
- **Session contract:** Post the verdict, submit pass or fail evidence, or record a blocker naming the exact blocked command and its error — never stop to ask for confirmation or offer options. One ending while waiting on input is recorded as failed with that reason
- **The master's half:** Findings, rework and merges; it never launches reviews or producers by hand, never approves a candidate, and never submits evidence
- **Profiles and attention:** `master producer add FILE`, `master producer replace FILE`, `master producer remove NAME`, `master reviewer remove NAME`. `setup.attention` reports a reviewer App registered but never bound, a bound App whose credential file is gone, and a `herdrWorkspace` Herdr no longer lists

## Independent review

The reviewer is a separate GitHub identity: not the pull-request author, not the control-plane App. `master run` launches it for every submitted head; `master review GY-N [PROFILE]` is the launcher it uses and the recovery path after a refused launch.

```sh
node "$GRAPHYARD_CLI" master reviewer setup          # registers the reviewer App
node "$GRAPHYARD_CLI" master reviewer add /path/to/reviewer-profile.json
node "$GRAPHYARD_CLI" master review GY-42 claude-reviewer
```

Add one profile — [Claude](../examples/master/claude-reviewer.json), [Cursor](../examples/master/cursor-reviewer.json) or [opencode](../examples/master/opencode-reviewer.json) — whose `approvals` mode is the trade-off [onboarding](onboarding.md#approval-modes) tabulates: `auto` starts without a keypress, `prompt` lets you opt out and answer in the tab. The reviewer App confirmation is the master's, through the browser flows below.

## GitHub administration through the browser

The master owns control-plane App permission updates, acceptance of the installation permission request they raise, and branch-protection reconciliation. Routine cases go through the API; GitHub offers none for App manifest confirmation, permission-request acceptance or a sudo prompt, so `master browser FLOW` drives the operator's own authenticated browser profile headless — `master init --browser-profile PROFILE` names it, and the harness denies the session every direct browser command. Routine protection reconciliation stays on the API path, `master protection [--apply]`. The three flows are `master browser app-permissions`, `master browser installation-accept` and `master browser protection`.

| Flow | Page | What it does | Verified afterwards by |
| --- | --- | --- | --- |
| `app-permissions` | `github.com/settings/apps/SLUG/permissions` | Raises every control-plane permission below what Graphyard needs | `gh api apps/SLUG` reports each at or above the requirement |
| `installation-accept` | `github.com/settings/installations/ID/permissions/update` | Accepts this installation's pending permission request | `gh api user/installations` shows it granting them |
| `protection` | `github.com/OWNER/REPO/settings/branches` → the base branch's classic rule | Sets `strict` off, administrator enforcement on, and the approval settings the open review policies need | the protection plan re-read through the API is consistent (`--dry-run` previews it) |

Every flow is audited. Each page action is recorded under `.graphyard/master-actions/<time>-<flow>-<id>/`, where `record.json` lists every step with its arguments and result and a numbered PNG follows every navigation and mutation, and an entry is appended to `.graphyard/master-actions/ledger.json` (mode 0600, append-only) naming who (browser login, profile, `gh` identity, OS user, host, coordinator principal), what, when, before and after, the outcome and whether verification passed. `master status` shows the last five under `administration`.

When GitHub answers with its *Confirm access* page, the flow clicks *Use GitHub Mobile*, reads the two-digit pairing code, writes it to `.graphyard/master-actions/sudo.json` and reports it under `administration.sudo` with the instruction to approve the prompt on your device and choose that code; it then polls for three minutes and continues where it was. A prompt nobody approves fails with the code and the rerun command rather than hanging, and one without a GitHub Mobile option is refused rather than guessed at.

The browser profile is the operator's identity: the master never stores, exports or copies its cookies or saved state, never uses the auth vault or state files, and never drives the profile outside these three flows. It never adds a repository to an installation or replaces protection through the API, never uses an administrative merge bypass, never edits a candidate or pushes code, never posts a verdict, never mints an installation token and never reads a worker, reviewer or coordinator credential — human-only decisions stay human-only, and those rules are denied in the harness as well as stated in the generated instructions.

## Harness permissions

A master inside a harness with a command classifier stops on its own routine commands until someone approves them, and Claude Code's auto mode further refuses protection reads and writes, installation and permission changes and browser control. `master start claude` writes project-scoped rules to the git-ignored `.claude/settings.local.json` before the session starts, `master harness claude [--apply]` previews or writes them, and `master harness codex` prints the `trust_level = "trusted"` block for `$CODEX_HOME/config.toml`. Those rules, and the per-role files launched sessions use, are in [operator automation](operator-automation.md#harness-rules-per-role); an allowlist is a prompt policy, not an authority boundary.

## Containment and recovery

- **A quarantine whose supervisor died:** The fence stays up until someone proves the worker stopped. `containment` carries the recorded scope unit and supervisor pid, what systemd reports for it, and `containment.held` — every process still holding the fence with its pid, cmdline and cwd
- **Attributing a neighbouring scope:** A `graphyard-watch-*` scope belongs to the live supervisor whose pid its name carries, so another item's worker is not this item's fence, while an orphaned scope is
- `settleable: true`, no `refusals`: `master settle-containment GY-N "reason"`
- **Any refusal:** Stop the supervisor, then attest through a two-party `rework` decision, or `recover` once delivered ([procedure](operations-reference.md#recovery-procedures))
- **A lapsed lease:** `lease-loss` stands only for a worker that silently vanished; every other lapse is `lease.expired` with cause `submitted`, `blocked-awaiting-operator` or `stopped-by-attestation`
- **Settling one:** Reconciliation settles an explained `lease-loss` each tick; any `admin` settles one at once with `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`; everything else needs a two-party `resolve` decision or a declared human session ([who may settle what](delegation.md#who-may-settle-what))

