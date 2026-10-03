<!-- page: Operate Graphyard | 6 | profiles, accounts, launches. -->
# Master-agent sessions

## Launch profiles

Workers: `master worker add FILE`; reviewers: `master reviewer setup`/`master reviewer add FILE` ([worker](../examples/master/claude-worker.json), [reviewer](../examples/master/claude-reviewer.json)). `master producer replace`, `master producer remove`, `master reviewer remove` apply next tick; `setup.attention` reports blocking setup.

### Session handles

`master status` `sessions`: runtime, host, pane, transcript, attach.

### Approval modes

`"approvals": "auto"` adds no-prompt flags (Claude Code `--permission-mode bypassPermissions` plus `.claude.json` trust, opencode `OPENCODE_PERMISSION`, Gemini/Qwen `--yolo`); Cursor runs as `agent`, not `cursor-agent`. `"prompt"`, `refusedLaunchKinds` and runtimes without command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtime arguments need `{request}`.

### The coordinator checkout is confined at the OS level

Non-master launches get a shell-unwritable checkout or are refused: Codex via `--sandbox workspace-write` (no checkout or `.git` grant), others via bubblewrap (writable: session directory, shared Git areas). On a dirty checkout the loop and executors never start, self-upgrade or restart; escalation names paths and leases.

## Accounts and failover

Without a [registry](onboarding.md#configure-the-fleet) role, a profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`). Launches take the first logged-in account under `run.quotaCeilingPercent`, else **fails over** (`dispatch.accounts`); with none, roles wait, relaunching oldest-first. A runtime's limit notice (not agent text) commits worker changes as unpushed `WIP:`, records `capacity.exhausted`, relaunches on the next account or after reset.

## The loop's own master session

A one-session fleet role (`master registry role set master ACCOUNTS …`); the loop and `master start` adopt a live `masterAgentName`. Started on the master prompt plus a handover, it relaunches on exit, limit notice, or past `run.masterSessionMinutes` (default 240; a merge defers up to 30 minutes). Changed subjects wake it; `run.masterHeartbeatMinutes` (default 30) of silence sends a heartbeat (`daemon.master`).

### The request is the session's first message

Never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

The launcher writes `.graphyard/launch/NAME.request` (and Claude's `NAME.role`), mode 0600, removed with the checkout, and types a line bounded at **512 bytes** whatever the request is:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude … --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

#### The start bound reads the pane

The runtime is **ready** when Herdr reports it active with no prompt or its banner shows (`the claude runtime is on screen while Herdr reports it unknown`). Ready within **60 seconds** (`run.launchStartSeconds`) starts; one still starting gets **120 seconds** (`started.extended`). A foreground launch command is starting: supervisor prints `graphyard: establishing containment for GY-N epoch E` before calling the API. Refused with the pane's last non-empty line, never Herdr's own `agent_not_found`: `the claude runtime never started within 60 s (command still echoing)`, `… was still starting after 120 s`, `… is blocked before it is ready`. Returning to shell fails immediately (`Automatic producer launch for GY-N refused 1 time(s)`), releasing supervisor, pane and claim.

OpenCode 1.18 is ready at `Ask anything…`/`tab agents` ([fixture](../tests/fixtures/opencode-1.18-start-screen.txt)).

#### First-run consent prompts

A runtime stopped at a first-run prompt is **`awaiting consent`**. The launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline`, never one that grants hook execution or a sandbox escape; anything else (especially **credential** or **payment**) escalates. A held worker is in `.graphyard/launch/NAME.consent` (`herdr pane attach`); after **15 minutes** its supervisor stops renewing and stops it; the item stays dispatchable.

### Acknowledgement, resume and idle sessions

Reviewers and producers are `awaiting acknowledgement` until 30 s active (`counts.dispatchAwaiting`), re-prompted once if quiet past `run.acknowledgementSeconds` (default 90); resultless, it is **`never started`**, relaunched free a minute later, three at most (`retry.neverStarted`).

A resolved blocker or scope request re-prompts the inactive session once (`complete GY-N EPOCH PR`); re-blocking hands the epoch to a fresh session, preferably another runtime. **Idle-with-lease** (30 quiet minutes, nothing open): re-prompted once, handed on after 30 more. Pastes target the attempt's pane, never a shared agent name; a gone pane hands on.

Headless Pi runs (`.graphyard/runs/`, systemd-scoped) survive restarts, re-adopted; lost ones retry free. Only Pi is confined; triage and diagnosis runs end with the loop.

### Panes are closed and reclaimed

Ending a session closes its pane. Each cycle closes up to **6** panes launched **on this host** whose session/worktree is gone, agentless past **120 s**, without an agent or lease; >**20** agentless raises attention (`daemon.escalations`).

### The dispatcher's own state

- **The dispatcher bounds its own state where it composes it**, each cut marked with an ellipsis.
- **A cursor that fails its schema is repaired, not fatal**, logged once with the path that failed.
- **A tick failure is attributed and surfaced** in `dispatch.lastFailure`. Three consecutive failures raise one attention item: no reviewer or producer session is being launched for any item. `graphyard master restart` repairs the cursor.
- **A session that exits at launch is classified from its pane.** One that exits **at launch** leaves `herdr agent get` only `agent_not_found`, so `herdr pane read` decides: a **provider limit notice** fails over exactly as a mid-session exhaustion; anything else is refused with the pane's last words and retried.
