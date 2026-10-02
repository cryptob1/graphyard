<!-- page: Operate Graphyard | 6 | profiles, accounts, launches. -->
# Master-agent sessions

## Launch profiles

`master worker add FILE` adds workers; `master reviewer setup` or `master reviewer add FILE`, reviewers ([worker](../examples/master/claude-worker.json), [reviewer](../examples/master/claude-reviewer.json) examples). `master producer replace`, `master producer remove` and `master reviewer remove` apply next tick; `setup.attention` reports blocking setup.

### Session handles

`master status` `sessions`: runtime, host, pane, transcript, attach.

### Approval modes

`"approvals": "auto"` adds each runtime's no-prompt flags (Claude Code `--permission-mode bypassPermissions` and `.claude.json` trust, opencode `OPENCODE_PERMISSION`, Gemini and Qwen `--yolo`); Cursor runs as `agent`, not `cursor-agent`. `"prompt"`, `refusedLaunchKinds` and runtimes lacking command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in their arguments.

### The coordinator checkout is confined at the OS level

Every launch but the master's gets the checkout unwritable to shell commands or is refused: Codex by `--sandbox workspace-write` (no grant on the checkout or its `.git`), others by bubblewrap (PIDs unshared, fresh `/proc`, systemd hidden, session bus a keyring-only proxy; only the session's directory and shared Git areas writable). The loop and executors never start, self-upgrade or restart on a dirty checkout; the escalation names paths and leases.

## Accounts and failover

A profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) unless the [registry](onboarding.md#configure-the-fleet) defines the role. A launch takes the first logged-in account under `run.quotaCeilingPercent`, else **fails over** (`dispatch.accounts`); with none, the role waits and relaunches oldest-first. On a runtime's own limit notice (never agent text) the loop commits worker changes as unpushed `WIP:`, records `capacity.exhausted` and relaunches on the next account or after reset.

## The loop's own master session

A fleet role (`master registry role set master ACCOUNTS …`) pinned to one session; the loop and `master start` adopt a live one named `masterAgentName`. It starts on the master prompt plus a handover, relaunching on exit, a limit notice, or past `run.masterSessionMinutes` (default 240; a merge defers it up to 30 minutes). Changed subjects wake it; `run.masterHeartbeatMinutes` (default 30) of silence sends a heartbeat (`daemon.master`).

### The request is the session's first message

Never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

The launcher writes `.graphyard/launch/NAME.request` (and Claude's `NAME.role`), mode 0600, removed with the checkout, and types a line bounded at **512 bytes** whatever the request is:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude … --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

#### The start bound reads the pane

A runtime ready (no prompt, or banner shown: `the claude runtime is on screen while Herdr reports it unknown`) within **60 seconds** (`run.launchStartSeconds`) starts; one still starting gets **120 seconds** (`started.extended`); else it is refused with the pane's last non-empty line, never Herdr's own `agent_not_found`: `the claude runtime never started within 60 s (command still echoing)`, `… was still starting after 120 s`, `… is blocked before it is ready`. One back at its shell fails at once (`Automatic producer launch for GY-N refused N time(s)`). A failed launch releases its supervisor, pane and claim.

#### First-run consent prompts

A runtime stopped on a first-run prompt is **`awaiting consent`**. The launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline`, never one that grants hook execution or a sandbox escape; anything else (above all **credential** or **payment**) escalates. A held worker is in `.graphyard/launch/NAME.consent` (`herdr pane attach`); after **15 minutes** its supervisor stops renewing and stops it, leaving the item dispatchable.

### Acknowledgement, resume and idle sessions

A reviewer or producer is `awaiting acknowledgement` until 30 s active (`counts.dispatchAwaiting`), re-prompted once if quiet past `run.acknowledgementSeconds` (default 90); settling resultless, it is **`never started`**, relaunched free a minute later, three at most (`retry.neverStarted`).

A resolved blocker or scope request re-prompts the attempt's inactive session once (`complete GY-N EPOCH PR`); blocking again hands the epoch to a fresh session, preferably another runtime. **Idle-with-lease** (30 quiet minutes, nothing open) is re-prompted once, handed on after 30 more. Pastes target the attempt's own pane, never a shared agent name; a gone pane hands it on.

Headless Pi runs (`.graphyard/runs/`, systemd-scoped) survive restarts, re-adopted; lost ones retry free. Only Pi is confined; triage and diagnosis runs end with the loop.

### Panes are closed and reclaimed

Ending a session closes its pane; each cycle also closes up to **6** panes launched **on this host** whose session or worktree is gone, agentless past **120 s**, never with an agent or live lease. Over **20** agentless raise attention (`daemon.escalations`).

### The dispatcher's own state

- **The dispatcher bounds its own state where it composes it**, each cut marked with an ellipsis.
- **A cursor that fails its schema is repaired, not fatal**, logged once with the path that failed.
- **A tick failure is attributed and surfaced** in `dispatch.lastFailure`. Three consecutive failures raise one attention item: no reviewer or producer session is being launched for any item. `graphyard master restart` repairs the cursor.
- **A session that exits at launch is classified from its pane.** One that exits **at launch** leaves `herdr agent get` only `agent_not_found`, so `herdr pane read` decides: a **provider limit notice** fails over exactly as a mid-session exhaustion does; any other cause is refused with the pane's last words and retried.
