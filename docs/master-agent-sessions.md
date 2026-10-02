<!-- page: Operate Graphyard | 6 | profiles, accounts, launches. -->
# Master-agent sessions

## Launch profiles

`master worker add FILE` adds workers ([Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json)); `master reviewer setup` or `master reviewer add FILE` reviewers ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)). `master producer replace`, `master producer remove`, `master reviewer remove` apply next tick; `setup.attention` reports launch-stopping setup.

### Session handles

`master status` `sessions` lists handles (runtime, host, pane, transcript, attach).

### Approval modes

`"approvals": "auto"` adds: Claude Code `--permission-mode bypassPermissions`, `.claude.json` trust; Codex `--ask-for-approval never --sandbox workspace-write`, network, `--add-dir`; Cursor `--force --trust`, run and logged in as `agent` (not `cursor` or `cursor-agent`); opencode allow-all `OPENCODE_PERMISSION`; Gemini, Qwen `--yolo`; Copilot `--allow-all-tools --allow-all-paths`; Muse `--approval-mode never --trust-workspace`; Pi none. `"prompt"`, `refusedLaunchKinds` and runtimes lacking command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in arguments.

### The coordinator checkout is confined at the OS level

Every launch but the master session's gets the checkout unwritable to shell commands: Codex by `--sandbox workspace-write` while every grant on the checkout or its `.git` stays within its worktree and admin directory; others by bubblewrap (checkout read-only, PIDs unshared, fresh `/proc`, systemd and `/run/dbus` hidden, session bus a keyring-only proxy), re-exposing only the session's directory (worktree, or a reviewer's or producer's checkout beside its root), worktree-admin directories, shared Git areas (objects, `graphyard/` branches, remote refs, `FETCH_HEAD`), each masked at its canonical path. Refused, with the reason: missing bubblewrap, non-Linux, refused namespaces, confinement off, an underivable checkout. Loop and executors never start, self-upgrade or restart on a dirty checkout; escalation names paths and leases.

## Accounts and failover

A profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) unless the [registry](onboarding.md#configure-the-fleet) defines the role. Launches take the first logged-in account under `run.quotaCeilingPercent`, else **fails over** (`dispatch.accounts`). A runtime's own limit notice (never agent text): worker changes committed as unpushed `WIP:`, `capacity.exhausted` (not `lease-loss`), relaunch on the next account or after reset.

## The loop's own master session

Fleet role `master registry role set master ACCOUNTS …` (unconfigured, nothing launches), one session holding its registry slot until the loop ends it (retried each cycle); loop and `master start` adopt a live `masterAgentName`. Starts on the master prompt plus a durable handover of standing judgement work; relaunches on exit (two missed readings; an unreadable inventory is none), a limit notice (account held), or past `run.masterSessionMinutes` (default 240; an open item's merge defers it ≤30 minutes). Changed subjects wake it; `run.masterHeartbeatMinutes` (default 30) of silence sends a heartbeat (`master status` `daemon.master`).

### The request is the session's first message

Never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

The launcher writes `.graphyard/launch/NAME.request` (and Claude's `NAME.role`), mode 0600, removed with the checkout, and types a line bounded at **512 bytes** whatever the request is:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude … --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

#### The start bound reads the pane

Ready (Herdr active, no prompt; or banner: `the claude runtime is on screen while Herdr reports it unknown`) within **60 seconds** (`run.launchStartSeconds`) starts; still starting → **120 seconds** (`started.extended`); else refused with the case and the pane's last non-empty line, never Herdr's own `agent_not_found`: `the claude runtime never started within 60 s (command still echoing)`, `… was still starting after 120 s`, `… is blocked before it is ready`. Back at its shell after printing → fails at once quoting its last lines (`the cursor runtime exited back to the shell … it last printed: "Error: No Cursor IDE installation found. …"`), retried as `Automatic producer launch for GY-N refused 1 time(s)`. Failure stops supervisor, closes pane, releases claim.

#### First-run consent prompts

On a first-run prompt: **`awaiting consent`**; the launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline` (least privilege), never one that grants hook execution or a sandbox escape; anything else (e.g. **credential**, **payment**) escalates. Held workers: `.graphyard/launch/NAME.consent` (`herdr pane attach`); after **15 minutes** the supervisor stops renewing and stops it; the item is dispatchable.

### Acknowledgement, resume and idle sessions

Reviewers and producers are `awaiting acknowledgement` until 30 s active (`counts.dispatchAwaiting`), re-prompted once if quiet past `run.acknowledgementSeconds` (default 90); settling resultless is **`never started`**: relaunched free a minute later, three per request (`retry.neverStarted`).

A resolved blocker or scope request re-prompts the inactive session once (item, epoch, change, `complete GY-N EPOCH PR`); re-blocking that epoch ends attempt and blocker for a fresh session (preferably another runtime). **Idle-with-lease** (30 quiet minutes, nothing open): re-prompted once, after 30 more handed to a new attempt on its branch. Pastes go to the attempt's own session-handle pane, never a profile's reusable agent name; a gone pane hands the attempt on.

Headless Pi runs (`.graphyard/runs/`, systemd-scoped) survive restarts, re-adopted; lost ones retry free (approvers thrice per decision). Only Pi is confined; triage and diagnosis runs end with the loop.

### Panes are closed and reclaimed

Ending a session closes its pane; each cycle closes ≤**6** more launched **on this host** with session or worktree gone, agentless past **120 s**, never one with an agent or live-leased worktree. Count: `daemon.actions`; over **20** agentless → attention (`daemon.escalations`).

### The dispatcher's own state

- **The dispatcher bounds its own state where it composes it**, each cut marked with an ellipsis.
- **A schema-failing cursor is repaired, not fatal**, logged once with the
  path that failed.
- **A tick failure is attributed and surfaced.** `dispatch.lastFailure` names it. Three consecutive failures raise one attention item: no reviewer or producer session is being launched for any item. `graphyard master restart` repairs the cursor.
- **A session that exits at launch is classified from its pane.** One that exits **at launch** leaves `herdr agent get` only `agent_not_found`, so `herdr pane read` decides: a **provider limit notice** fails over exactly as a mid-session exhaustion does; any other cause is refused with the pane's last words and retried.
