<!-- page: Operate Graphyard | 6 | profiles, accounts, launches. -->
# Master-agent sessions

## Launch profiles

`master worker add FILE` adds workers ([Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json)); `master reviewer setup` and `master reviewer add FILE`, reviewers ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)). `master producer replace`, `master producer remove` and `master reviewer remove` apply next tick; `setup.attention` reports blocking setup.

### Session handles

`master status` `sessions` lists handles (runtime, host, pane, transcript, attach).

### Approval modes

`"approvals": "auto"` means: Claude Code `--permission-mode bypassPermissions`, `.claude.json` trust; Codex `--ask-for-approval never --sandbox workspace-write`, network, `--add-dir`; Cursor `--force --trust` via `agent` (not `cursor-agent`); opencode allow-all `OPENCODE_PERMISSION`; Gemini, Qwen `--yolo`; Copilot `--allow-all-tools --allow-all-paths`; Muse `--approval-mode never --trust-workspace`; Pi none. `"prompt"`, `refusedLaunchKinds` and runtimes lacking command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in their arguments.

### The coordinator checkout is confined at the OS level

Every launch but the master session's runs with the checkout unwritable to shell commands, or is refused: Codex by `--sandbox workspace-write` (while no grant on the checkout or its `.git` leaves the session's worktree), others under bubblewrap (checkout read-only, PIDs unshared, fresh `/proc`, bus and systemd hidden; only the session's directory and shared Git areas writable). The loop and executors never start, self-upgrade or restart on a dirty checkout; the escalation names paths and leases.

## Accounts and failover

A profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) unless the [registry](onboarding.md#configure-the-fleet) defines the role. A launch takes the first logged-in account under `run.quotaCeilingPercent`, else **fails over** (`dispatch.accounts`); with none left, the role waits (one uncounted `capacity` line), relaunching oldest-first. On a runtime's own limit notice (never agent text) the loop commits worker changes as unpushed `WIP:`, records `capacity.exhausted` and relaunches on the next account or after reset.

## The loop's own master session

A fleet role (`master registry role set master ACCOUNTS …`) pinned to one session; the loop and `master start` adopt a live one named `masterAgentName`. It starts on the master prompt plus a handover and relaunches on exit, a limit notice, or past `run.masterSessionMinutes` (default 240; deferred up to 30 minutes for a merge). Cycles wake it naming changed subjects; `run.masterHeartbeatMinutes` (default 30) of silence sends a heartbeat (`daemon.master`).

### The request is the session's first message

Never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

The launcher writes `.graphyard/launch/NAME.request` (and Claude's `NAME.role`), mode 0600, removed with the checkout, and types a line bounded at **512 bytes** whatever the request is:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude … --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

#### The start bound reads the pane

A runtime ready (active with no prompt, or banner shown: `the claude runtime is on screen while Herdr reports it unknown`) within **60 seconds** (`run.launchStartSeconds`) starts; one still starting gets **120 seconds** (`started.extended`); else it is refused with the pane's last non-empty line, never Herdr's own `agent_not_found`: `the claude runtime never started within 60 s (command still echoing)`, `… was still starting after 120 s`, `… is blocked before it is ready`. One back at its shell fails at once, quoting its last lines (`Automatic producer launch for GY-N refused N time(s)`). A failed launch stops its supervisor, closes its pane, releases its claim.

#### First-run consent prompts

A runtime stopped on a first-run prompt is **`awaiting consent`**. The launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline`, never one that grants hook execution or a sandbox escape; anything else (a **credential** or **payment** prompt above all) escalates. A worker is held in `.graphyard/launch/NAME.consent` (`herdr pane attach`); after **15 minutes** its supervisor stops renewing and stops it, leaving the item dispatchable.

### Acknowledgement, resume and idle sessions

A reviewer or producer is `awaiting acknowledgement` until 30 s active (`counts.dispatchAwaiting`), re-prompted once if quiet past `run.acknowledgementSeconds` (default 90); settling resultless, it is **`never started`**, relaunched free a minute later, up to three (`retry.neverStarted`).

A resolved blocker or scope request re-prompts the attempt's inactive session once (`complete GY-N EPOCH PR`); blocking again on that epoch hands it to a fresh session, preferably another runtime. **Idle-with-lease** (30 quiet minutes, nothing open) is re-prompted once, then handed on after 30 more. Pastes go to the attempt's own handle's pane, never a shared agent name; a gone pane hands it on.

### Panes are closed and reclaimed

Ending a session closes its pane. A per-cycle sweep closes panes Graphyard launched **on this host** whose session or worktree is gone, agentless past **120 s**, **6** a pass at most, never one with an agent or live lease. `daemon.actions` records the count and oldest agentless pane; over **20** raise attention (`daemon.escalations`).

### The dispatcher's own state

- **The dispatcher bounds its own state where it composes it**, each cut marked with an ellipsis.
- **A cursor that fails its schema is repaired, not fatal**; the repair is logged once with the
  path that failed.
- **A tick failure is attributed and surfaced** in `dispatch.lastFailure`. Three consecutive failures raise one attention item: no reviewer or producer session is being launched for any item. `graphyard master restart` repairs the cursor.
- **A session that exits at launch is classified from its pane.** For a runtime that exits **at launch** `herdr agent get` answers only `agent_not_found`, so `herdr pane read` decides: a **provider limit notice** fails over exactly as a mid-session exhaustion does; any other cause is refused with the pane's last words and retried.
