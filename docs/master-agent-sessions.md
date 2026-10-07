<!-- page: Operate Graphyard | 6 | profiles, launches. -->
# Master-agent sessions

## Launch profiles

`master worker add FILE` adds workers ([template](../examples/master/claude-worker.json)); `master reviewer setup` or `master reviewer add FILE` reviewers ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)); `master producer replace`, `master producer remove` and `master reviewer remove` apply next tick (`setup.attention` reports blocking setup).

### Session handles

`master status` `sessions` lists handles.

### Approval modes

`"approvals": "auto"` adds: Claude Code `--permission-mode bypassPermissions` and `.claude.json` trust; Codex `--ask-for-approval never --sandbox workspace-write` and `config.toml` trust; Cursor `--force --trust`; opencode `OPENCODE_PERMISSION`; Gemini, Qwen, Copilot, Muse and Antigravity their own allow-all flags; Pi none. `"prompt"` and runtimes lacking command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in arguments.

### The coordinator checkout is confined at the OS level

Every launch but the master session's starts in its own checkout with the coordinator's unwritable: Codex by `--sandbox workspace-write`, others by bubblewrap (session bus a [keyring-only proxy](operations.md#worker-host-keyring-proxy)); an unconfinable launch is refused, and the loop never starts on a dirty or moved checkout ([details](master-agent.md#operate)).

#### Worker sandbox

Writable Git roots: `.git/worktrees/NAME`, `objects`, `refs/remotes`, `refs/heads/graphyard`, `logs/`, never `.git` itself; a failed write probe fails the launch naming the path.

A profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) unless the registry defines the role. Launches take the first account under `run.quotaCeilingPercent`, else **fail over**; a runtime's limit notice commits work as unpushed `WIP:`, sets `capacity.exhausted` and relaunches elsewhere or after reset.

## The loop's own master session

Fleet role `master registry role set master ACCOUNTS …`: one session, relaunched on exit, a limit notice or `run.masterSessionMinutes` (240); changed subjects wake it, and `run.masterHeartbeatMinutes` (30) of silence sends a heartbeat.

### The request is the session's first message

Never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

The launcher writes `.graphyard/launch/NAME.request` (and Claude's `NAME.role`), mode 0600, removed with the checkout, and types a line bounded at **512 bytes** whatever the request is:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude … --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

#### The start bound reads the pane

The runtime is **ready** when Herdr reports it active with no prompt or its banner shows (`the claude runtime is on screen while Herdr reports it unknown`). Ready within **60 seconds** (`run.launchStartSeconds`) starts; one still starting gets **120 seconds** (`started.extended`). Refusals quote the case and the pane's last non-empty line, never Herdr's own `agent_not_found`: `the claude runtime never started within 60 s (command still echoing)`, `… was still starting after 120 s`, `… is blocked before it is ready`; retried as `Automatic producer launch for GY-N refused 1 time(s)`.

#### First-run consent prompts

On a first-run prompt: **`awaiting consent`**; the launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline`, never one that grants hook execution or a sandbox escape; anything else (e.g. **credential**, **payment**) escalates; workspace-trust prompts fail the launch. A trust record dropped before start refuses the launch. Held: `.graphyard/launch/NAME.consent` (`herdr pane attach`); after **15 minutes** the supervisor stops renewing and stops it; the item is dispatchable.

Reviewers and producers are `awaiting acknowledgement` until 30 s active (`counts.dispatchAwaiting`), re-prompted once if quiet past `run.acknowledgementSeconds` (default 90); settling resultless is **`never started`**: relaunched a minute later, three at most (`retry.neverStarted`), [then elsewhere](master-agent-reference.md#producer-runtime-faults).

**Idle-with-lease** (25 quiet minutes): re-prompted once, then handed to a new attempt on its branch within 60 minutes of its last activity. **Blocked mid-session**: a destructive-command prompt is declined, a folder-trust dialog relaunches the session recording the trust, any other prompt fails it after **5 minutes**.

### Panes are closed and reclaimed

Ending a session closes its pane; each cycle closes ≤12 more stale panes on this host, never one holding a live lease; over 20 agentless raise attention.

### The dispatcher's own state

- **The dispatcher bounds its own state where it composes it**, each cut marked with an ellipsis.
- **A cursor failing its schema is repaired, not fatal**, logged once with the path that failed.
- **A tick failure is attributed and surfaced.** `dispatch.lastFailure` names it. Three consecutive failures raise one attention item: no reviewer or producer session is being launched for any item. `graphyard master restart` repairs the cursor.

**A session that exits at launch is classified from its pane.** `herdr agent get` answers only `agent_not_found` for one that exits **at launch**, so the dispatcher uses `herdr pane read`: a **provider limit notice** fails over exactly as a mid-session exhaustion does; any other cause is refused with the pane's last words and retried.
