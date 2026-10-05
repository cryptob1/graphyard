<!-- page: Operate Graphyard | 6 | profiles, accounts, launches. -->
# Master-agent sessions

## Launch profiles

`master worker add FILE` adds workers ([Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json)); `master reviewer setup` or `master reviewer add FILE` reviewers ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)). `master producer replace`, `master producer remove`, `master reviewer remove` apply next tick; `setup.attention` reports blocking setup.

### Session handles

`master status` `sessions` lists handles.

### Approval modes

`"approvals": "auto"` adds: Claude Code `--permission-mode bypassPermissions`, `.claude.json` trust; Codex `--ask-for-approval never --sandbox workspace-write`, network, `--add-dir`; Cursor `--force --trust`, run and logged in as `agent` (not `cursor` or `cursor-agent`); opencode allow-all `OPENCODE_PERMISSION`; Gemini, Qwen `--yolo`; Copilot `--allow-all-tools --allow-all-paths`; Muse `--approval-mode never --trust-workspace`; Antigravity `agy` `--dangerously-skip-permissions`, `trustedWorkspaces`, `--prompt-interactive`; Pi none. `"prompt"`, `refusedLaunchKinds` and runtimes lacking command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in arguments.

### The coordinator checkout is confined at the OS level

Every launch but the master session's gets the checkout unwritable to shell commands: Codex by a confined `--sandbox workspace-write`, others by bubblewrap (checkout read-only, session bus a [keyring-only proxy](operations.md#worker-host-keyring-proxy)) re-exposing only the session worktree and shared Git areas. A launch that cannot be confined is refused with the reason. Every non-master session starts in its own checkout. Loop and executors never start, self-upgrade or restart on a dirty or moved checkout ([details](master-agent.md#operate)).

## Accounts and failover

A profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) unless the [registry](onboarding.md#configure-the-fleet) defines the role. Launches take the first account under `run.quotaCeilingPercent`, else **fail over** (`dispatch.accounts`), as does a runtime failing to start. A runtime's limit notice (never agent text; from a working session, master too, only beside its retry marker `[retrying in 4s]`) commits work as unpushed `WIP:`, sets `capacity.exhausted` and relaunches elsewhere or after reset (agy's `Individual quota reached`).

## The loop's own master session

Fleet role `master registry role set master ACCOUNTS …` (unset: none): one session; the loop and `master start` adopt a live `masterAgentName`. It starts on the master prompt plus a handover of standing judgement work and relaunches on exit, a limit notice or past `run.masterSessionMinutes` (240). Changed subjects wake it; after `run.masterHeartbeatMinutes` (30) of silence it gets a heartbeat (`master status` `daemon.master`).

### The request is the session's first message

Never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

The launcher writes `.graphyard/launch/NAME.request` (and Claude's `NAME.role`), mode 0600, removed with the checkout, and types a line bounded at **512 bytes** whatever the request is:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude … --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

#### The start bound reads the pane

The runtime is **ready** when Herdr reports it active with no prompt or its banner shows (`the claude runtime is on screen while Herdr reports it unknown`). Ready within **60 seconds** (`run.launchStartSeconds`) starts; one still starting gets **120 seconds** (`started.extended`); its supervisor prints `graphyard: establishing containment for GY-N epoch E` first. Refusals quote the case and the pane's last non-empty line, never Herdr's own `agent_not_found`: `the claude runtime never started within 60 s (command still echoing)`, `… was still starting after 120 s`, `… is blocked before it is ready`; retried as `Automatic producer launch for GY-N refused 1 time(s)`, releasing pane, supervisor and claim.

OpenCode 1.18 is ready at `Ask anything…`/`tab agents` ([fixture](../tests/fixtures/opencode-1.18-start-screen.txt)).

#### First-run consent prompts

On a first-run prompt: **`awaiting consent`**; the launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline`, never one that grants hook execution or a sandbox escape; anything else (e.g. **credential**, **payment**) escalates; workspace-trust prompts fail the launch. Held workers: `.graphyard/launch/NAME.consent` (`herdr pane attach`); after **15 minutes** the supervisor stops renewing and stops it; the item is dispatchable.

### Acknowledgement, resume and idle sessions

Reviewers and producers are `awaiting acknowledgement` until 30 s active (`counts.dispatchAwaiting`), re-prompted once if quiet past `run.acknowledgementSeconds` (default 90); settling resultless is **`never started`**: relaunched free a minute later, three at most (`retry.neverStarted`), [then elsewhere](master-agent-reference.md#producer-runtime-faults).

**Idle-with-lease** (30 quiet minutes, nothing open): re-prompted once, after 30 more handed to a new attempt on its branch.

Headless Pi runs (`.graphyard/runs/`) survive restarts.

### Panes are closed and reclaimed

Ending a session closes its pane. Each cycle closes ≤**10** more **on this host**, never one whose item and epoch holds a live lease: agentless past **120 s** with session or worktree gone, or in a Graphyard worktree; an agent named for its ended session after **60 s**. Over **20** agentless raise attention (`daemon.escalations`).

### The dispatcher's own state

- **The dispatcher bounds its own state where it composes it**, each cut marked with an ellipsis.
- **A cursor that fails its schema is repaired, not fatal**, logged once with the path that failed.
- **A tick failure is attributed and surfaced.** `dispatch.lastFailure` names it. Three consecutive failures raise one attention item: no reviewer or producer session is being launched for any item. `graphyard master restart` repairs the cursor.

**A session that exits at launch is classified from its pane.** `herdr agent get` answers only `agent_not_found` for a runtime that exits **at launch**, so the dispatcher uses `herdr pane read`: a **provider limit notice** fails over exactly as a mid-session exhaustion does; any other cause is refused with the pane's last words and retried.
